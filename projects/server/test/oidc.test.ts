import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.ts";
import { type StubIssuer, startStubIssuer } from "./stub-issuer.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const CLIENT_ID = "todou-test";

/** The callback answers with two Set-Cookie headers (transient deletion +
 * session); pick the session one. */
function sessionCookieOf(res: Response): string {
  const cookie = res.headers
    .getSetCookie()
    .find((v) => v.startsWith("todou_session="));
  return (cookie ?? "").split(";")[0] as string;
}

let idp: StubIssuer;
let t: TestApp;

beforeAll(async () => {
  idp = await startStubIssuer(CLIENT_ID);
  t = await makeTestApp("shared", {
    extraToml: [
      "[auth]",
      'mode = "oidc"',
      "[auth.oidc]",
      `issuer = "${idp.origin}"`,
      `client_id = "${CLIENT_ID}"`,
      'client_secret = "test-secret"',
    ].join("\n"),
  });
});

afterAll(async () => {
  await t.cleanup();
  await idp.close();
});

beforeEach(() => {
  idp.failTokenEndpoint = false;
  idp.subject = "stub-sub";
  idp.idTokenClaims = { preferred_username: "alice", name: "Alice Weber" };
  idp.userinfoClaims = {};
});

/** Drive GET /api/auth/login and pull apart the redirect + transient cookie. */
async function startLogin(redirect = "/projects") {
  const res = await t.app.request(
    `/api/auth/login?redirect=${encodeURIComponent(redirect)}`,
  );
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location") ?? "");
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] as string;
  expect(cookie.startsWith("todou_oidc=")).toBe(true);
  return { location, cookie };
}

async function completeCallback(options?: { state?: string; cookie?: string }) {
  const { location, cookie } = await startLogin();
  const state = options?.state ?? location.searchParams.get("state") ?? "";
  return t.app.request(
    `/api/auth/callback?code=stub-code&state=${encodeURIComponent(state)}`,
    { headers: { cookie: options?.cookie ?? cookie } },
  );
}

describe("oidc login flow", () => {
  it("redirects to the IdP with PKCE and stores a transient cookie", async () => {
    const { location } = await startLogin();
    expect(location.origin).toBe(idp.origin);
    expect(location.pathname).toBe("/authorize");
    expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://localhost/api/auth/callback",
    );
  });

  it("completes the code exchange, provisions, and resumes the redirect", async () => {
    const res = await completeCallback();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/projects");

    const session = sessionCookieOf(res);
    expect(session.startsWith("todou_session=")).toBe(true);

    const me = await t.app.request("/api/me", { headers: { cookie: session } });
    expect(me.status).toBe(200);
    const body = await json(me);
    expect(body.login).toBe("alice");
    expect(body.display_name).toBe("Alice Weber");
    expect(body.is_instance_admin).toBe(true);
  });

  it("matches the same subject to the same user on the next login", async () => {
    const first = await completeCallback();
    const second = await completeCallback();
    for (const res of [first, second]) {
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/projects");
    }
  });

  it("falls back to userinfo when the ID token lacks the login claim", async () => {
    idp.subject = "userinfo-sub";
    idp.idTokenClaims = {};
    idp.userinfoClaims = { preferred_username: "carol" };
    const res = await completeCallback();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/projects");
  });

  it("redirects to /login?error=state_mismatch on a tampered state", async () => {
    const res = await completeCallback({ state: "forged-state" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?error=state_mismatch");
  });

  it("redirects with state_mismatch when the transient cookie is gone", async () => {
    const res = await completeCallback({ cookie: "unrelated=1" });
    expect(res.headers.get("location")).toBe("/login?error=state_mismatch");
  });

  it("redirects with exchange_failed when the token endpoint breaks", async () => {
    idp.failTokenEndpoint = true;
    const res = await completeCallback();
    expect(res.headers.get("location")).toBe("/login?error=exchange_failed");
  });

  it("redirects with claim_missing when no usable login claim exists", async () => {
    idp.subject = "claimless-sub";
    idp.idTokenClaims = {};
    idp.userinfoClaims = {};
    const res = await completeCallback();
    expect(res.headers.get("location")).toBe("/login?error=claim_missing");
  });

  it("redirects with claim_missing for an unusable login value", async () => {
    idp.subject = "spacey-sub";
    idp.idTokenClaims = { preferred_username: "John Doe" };
    const res = await completeCallback();
    expect(res.headers.get("location")).toBe("/login?error=claim_missing");
  });

  it("sanitises the resume redirect to same-site paths", async () => {
    const { location, cookie } = await startLogin();
    void location;
    void cookie;
    const res = await t.app.request(
      "/api/auth/login?redirect=https://evil.example/phish",
    );
    expect(res.status).toBe(302);
    const evilFlow = new URL(res.headers.get("location") ?? "");
    const evilCookie = (res.headers.get("set-cookie") ?? "").split(
      ";",
    )[0] as string;
    const done = await t.app.request(
      `/api/auth/callback?code=stub-code&state=${encodeURIComponent(
        evilFlow.searchParams.get("state") ?? "",
      )}`,
      { headers: { cookie: evilCookie } },
    );
    expect(done.headers.get("location")).toBe("/");
  });

  it("400s the POST login endpoint in oidc mode", async () => {
    const res = await t.app.request("/api/auth/login", { method: "POST" });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("wrong_auth_mode");
  });

  it("still destroys sessions on logout", async () => {
    const login = await completeCallback();
    const session = sessionCookieOf(login);
    const out = await t.app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie: session },
    });
    expect(out.status).toBe(204);
    const me = await t.app.request("/api/me", {
      headers: { cookie: session },
    });
    expect(me.status).toBe(401);
  });
});

describe("oidc provisioning denials", () => {
  it("redirects with provision_denied when auto_create is off", async () => {
    const strict = await makeTestApp("shared", {
      extraToml: [
        "[auth]",
        'mode = "oidc"',
        "[auth.oidc]",
        `issuer = "${idp.origin}"`,
        `client_id = "${CLIENT_ID}"`,
        'client_secret = "test-secret"',
        "auto_create = false",
      ].join("\n"),
    });
    try {
      idp.subject = "denied-sub";
      idp.idTokenClaims = { preferred_username: "nobody" };
      const start = await strict.app.request("/api/auth/login");
      const flow = new URL(start.headers.get("location") ?? "");
      const cookie = (start.headers.get("set-cookie") ?? "").split(
        ";",
      )[0] as string;
      const res = await strict.app.request(
        `/api/auth/callback?code=c&state=${encodeURIComponent(
          flow.searchParams.get("state") ?? "",
        )}`,
        { headers: { cookie } },
      );
      // The subject rides along: it is what an admin needs for
      // `todou-server user bind-subject`.
      expect(res.headers.get("location")).toBe(
        "/login?error=provision_denied&subject=denied-sub",
      );
    } finally {
      await strict.cleanup();
    }
  });

  it("404s oidc GET routes in single mode", async () => {
    const single = await makeTestApp();
    try {
      const res = await single.app.request("/api/auth/login");
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe("wrong_auth_mode");
    } finally {
      await single.cleanup();
    }
  });
});
