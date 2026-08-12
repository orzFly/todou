import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import * as oidc from "openid-client";
import type { AppContext } from "../bootstrap.ts";
import type { Config } from "../config.ts";
import { DomainError } from "../errors.ts";
import { requestOrigin } from "../http/proxy.ts";
import { cookieSecure } from "./cookies.ts";
import { normalizeLogin, ProvisionError, provisionUser } from "./provision.ts";
import { createSession, SESSION_COOKIE } from "./session.ts";

/** state + PKCE verifier + resume path, alive only for the IdP round-trip. */
const TRANSIENT_COOKIE = "todou_oidc";
const TRANSIENT_MAX_AGE_S = 300;
// Narrow path: the browser only replays it to /api/auth/login|callback.
const TRANSIENT_PATH = "/api/auth";

export type OidcErrorCode =
  | "state_mismatch"
  | "exchange_failed"
  | "claim_missing"
  | "provision_denied"
  | "login_conflict";

/** Only same-site paths may be resumed after login (mirrors the web rule). */
export function safeRedirect(value: unknown): string {
  return typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//")
    ? value
    : "/";
}

const discoveries = new WeakMap<Config, Promise<oidc.Configuration>>();

/**
 * Discovery is lazy and cached per loaded config: doing it at boot would
 * chain todou's startup to the IdP being up, and self-hosted boxes
 * routinely start both together. A failure clears the cache so the next
 * login attempt retries.
 */
function getIdp(config: Config): Promise<oidc.Configuration> {
  let discovered = discoveries.get(config);
  if (!discovered) {
    const cfg = config.auth.oidc;
    // Required keys are enforced by loadConfig in oidc mode.
    const issuer = cfg.issuer as string;
    discovered = oidc
      .discovery(
        new URL(issuer),
        cfg.client_id as string,
        { client_secret: cfg.client_secret },
        undefined,
        // An http:// issuer is the deployer's explicit choice (intranet
        // IdPs, the test stub); openid-client refuses it by default.
        issuer.startsWith("http://")
          ? { execute: [oidc.allowInsecureRequests] }
          : undefined,
      )
      .catch((cause) => {
        discoveries.delete(config);
        throw new DomainError(
          503,
          "oidc_unavailable",
          `oidc issuer discovery failed: ${String(cause)}`,
        );
      });
    discoveries.set(config, discovered);
  }
  return discovered;
}

type TransientPayload = { state: string; verifier: string; redirect: string };

function encodeTransient(payload: TransientPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeTransient(value: string): TransientPayload | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<TransientPayload>;
    if (
      typeof parsed.state === "string" &&
      typeof parsed.verifier === "string" &&
      typeof parsed.redirect === "string"
    ) {
      return parsed as TransientPayload;
    }
  } catch {
    // Fall through: a mangled cookie reads as "no flow in progress".
  }
  return null;
}

// biome-ignore lint/suspicious/noExplicitAny: works for every route env
type AnyContext = Context<any>;

export async function oidcLoginRedirect(
  c: AnyContext,
  ctx: AppContext,
): Promise<Response> {
  const idp = await getIdp(ctx.config);
  const verifier = oidc.randomPKCECodeVerifier();
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  const state = oidc.randomState();
  const redirect = safeRedirect(c.req.query("redirect"));

  const authUrl = oidc.buildAuthorizationUrl(idp, {
    redirect_uri: callbackUri(c, ctx.config),
    scope: ctx.config.auth.oidc.scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  setCookie(c, TRANSIENT_COOKIE, encodeTransient({ state, verifier, redirect }), {
    httpOnly: true,
    sameSite: "Lax",
    secure: cookieSecure(c, ctx.config),
    path: TRANSIENT_PATH,
    maxAge: TRANSIENT_MAX_AGE_S,
  });
  return c.redirect(authUrl.toString(), 302);
}

export async function oidcCallback(
  c: AnyContext,
  ctx: AppContext,
): Promise<Response> {
  const fail = (code: OidcErrorCode) =>
    c.redirect(`/login?error=${code}`, 302);

  const transientRaw = getCookie(c, TRANSIENT_COOKIE);
  deleteCookie(c, TRANSIENT_COOKIE, { path: TRANSIENT_PATH });
  const transient = transientRaw ? decodeTransient(transientRaw) : null;
  if (!transient) return fail("state_mismatch");

  // The grant call verifies state/code against this URL's query; rebuild it
  // on the public origin so it matches the redirect_uri the flow started with.
  const publicUrl = new URL(callbackUri(c, ctx.config));
  publicUrl.search = new URL(c.req.url).search;

  let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
  try {
    const idp = await getIdp(ctx.config);
    tokens = await oidc.authorizationCodeGrant(idp, publicUrl, {
      pkceCodeVerifier: transient.verifier,
      expectedState: transient.state,
    });
  } catch (cause) {
    // openid-client reports a state mismatch as an error too, but the
    // distinction matters for humans: stale bookmark vs broken IdP.
    const message = String(cause);
    console.error("oidc code exchange failed:", message);
    return fail(
      message.includes("state") ? "state_mismatch" : "exchange_failed",
    );
  }

  const claims = tokens.claims();
  if (!claims?.sub) return fail("claim_missing");

  const loginClaim = ctx.config.auth.oidc.login_claim;
  let rawLogin = claims[loginClaim];
  if (typeof rawLogin !== "string" || rawLogin === "") {
    // Some IdPs keep profile claims off the ID token; userinfo has them all.
    try {
      const idp = await getIdp(ctx.config);
      const info = await oidc.fetchUserInfo(
        idp,
        tokens.access_token,
        claims.sub,
      );
      rawLogin = info[loginClaim];
    } catch (cause) {
      console.error("oidc userinfo fetch failed:", String(cause));
      return fail("claim_missing");
    }
  }
  if (typeof rawLogin !== "string") return fail("claim_missing");
  const login = normalizeLogin(rawLogin);
  if (login === null) {
    console.error(
      `oidc login_claim "${loginClaim}" value ${JSON.stringify(rawLogin)} is not a usable login`,
    );
    return fail("claim_missing");
  }

  let user: Awaited<ReturnType<typeof provisionUser>>;
  try {
    user = await provisionUser(
      ctx.router.system(),
      {
        subject: claims.sub,
        login,
        name: typeof claims.name === "string" ? claims.name : null,
        email: typeof claims.email === "string" ? claims.email : null,
      },
      { autoCreate: ctx.config.auth.oidc.auto_create },
    );
  } catch (cause) {
    if (cause instanceof ProvisionError) return fail(cause.reason);
    throw cause;
  }

  const session = await createSession(ctx.router.system(), user.id);
  setCookie(c, SESSION_COOKIE, session.value, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: cookieSecure(c, ctx.config),
    expires: session.expiresAt,
  });
  return c.redirect(transient.redirect, 302);
}

function callbackUri(c: AnyContext, config: Config): string {
  return `${requestOrigin(c, config)}/api/auth/callback`;
}
