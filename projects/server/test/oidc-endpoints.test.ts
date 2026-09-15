import type * as oidc from "openid-client";
import { describe, expect, it } from "vitest";
import {
  applyInternalEndpoints,
  clientAuthFor,
  needsInsecureTransport,
} from "../src/auth/oidc.ts";
import type { Config } from "../src/config.ts";

const INTERNAL = "http://keycloak.identity.svc.cluster.local:8080";

const PUBLISHED: oidc.ServerMetadata = {
  issuer: "https://auth.example.com",
  authorization_endpoint: "https://auth.example.com/realms/x/authorize",
  token_endpoint: "https://auth.example.com/realms/x/token",
  userinfo_endpoint: "https://auth.example.com/realms/x/userinfo?v=2",
  jwks_uri: "https://auth.example.com/realms/x/jwks",
};

function oidcConfig(
  overrides: Partial<Config["auth"]["oidc"]> = {},
): Config["auth"]["oidc"] {
  return {
    scopes: "openid profile email",
    login_claim: "preferred_username",
    auto_create: true,
    ...overrides,
  };
}

describe("applyInternalEndpoints", () => {
  it("rebases the server-dialled endpoints onto internal_origin, paths intact", () => {
    const patched = applyInternalEndpoints(
      PUBLISHED,
      oidcConfig({ internal_origin: INTERNAL }),
    );
    expect(patched.token_endpoint).toBe(`${INTERNAL}/realms/x/token`);
    expect(patched.userinfo_endpoint).toBe(`${INTERNAL}/realms/x/userinfo?v=2`);
    expect(patched.jwks_uri).toBe(`${INTERNAL}/realms/x/jwks`);
  });

  it("leaves issuer and authorization_endpoint on the public origin", () => {
    const patched = applyInternalEndpoints(
      PUBLISHED,
      oidcConfig({ internal_origin: INTERNAL }),
    );
    expect(patched.issuer).toBe(PUBLISHED.issuer);
    expect(patched.authorization_endpoint).toBe(
      PUBLISHED.authorization_endpoint,
    );
  });

  it("lets a single endpoint override win over internal_origin", () => {
    const patched = applyInternalEndpoints(
      PUBLISHED,
      oidcConfig({
        internal_origin: INTERNAL,
        token_endpoint: "http://idp.internal:9000/other/path/token",
      }),
    );
    expect(patched.token_endpoint).toBe(
      "http://idp.internal:9000/other/path/token",
    );
    expect(patched.userinfo_endpoint).toBe(`${INTERNAL}/realms/x/userinfo?v=2`);
    expect(patched.jwks_uri).toBe(`${INTERNAL}/realms/x/jwks`);
  });

  it("changes only the named endpoint when internal_origin is unset", () => {
    const patched = applyInternalEndpoints(
      PUBLISHED,
      oidcConfig({ userinfo_endpoint: `${INTERNAL}/realms/x/userinfo` }),
    );
    expect(patched.userinfo_endpoint).toBe(`${INTERNAL}/realms/x/userinfo`);
    expect(patched.token_endpoint).toBe(PUBLISHED.token_endpoint);
    expect(patched.jwks_uri).toBe(PUBLISHED.jwks_uri);
  });

  it("does not invent an endpoint discovery never published", () => {
    const { userinfo_endpoint: _omitted, ...withoutUserinfo } = PUBLISHED;
    const patched = applyInternalEndpoints(
      withoutUserinfo,
      oidcConfig({ internal_origin: INTERNAL }),
    );
    expect("userinfo_endpoint" in patched).toBe(false);
  });

  it("returns the metadata unchanged when nothing is configured", () => {
    expect(applyInternalEndpoints(PUBLISHED, oidcConfig())).toEqual(PUBLISHED);
  });
});

describe("needsInsecureTransport", () => {
  it("is true for an https issuer reached over a plaintext internal endpoint", () => {
    expect(
      needsInsecureTransport({
        ...PUBLISHED,
        token_endpoint: `${INTERNAL}/realms/x/token`,
      }),
    ).toBe(true);
  });

  it("is false when every address is https", () => {
    expect(needsInsecureTransport(PUBLISHED)).toBe(false);
  });

  it("is true for an http issuer, as before", () => {
    expect(
      needsInsecureTransport({
        issuer: "http://127.0.0.1:9999",
        authorization_endpoint: "http://127.0.0.1:9999/authorize",
        token_endpoint: "http://127.0.0.1:9999/token",
      }),
    ).toBe(true);
  });

  it("is true for a plaintext authorization_endpoint alone", () => {
    expect(
      needsInsecureTransport({
        ...PUBLISHED,
        authorization_endpoint: "http://auth.example.com/realms/x/authorize",
      }),
    ).toBe(true);
  });
});

describe("clientAuthFor", () => {
  function authenticate(
    cfg: Partial<Config["auth"]["oidc"]>,
    declared: string[] | undefined,
  ): { body: URLSearchParams; headers: Headers } {
    const body = new URLSearchParams();
    const headers = new Headers();
    // A fresh client per call, and not a shared one: openid-client's
    // secret-less ClientSecretPost/ClientSecretBasic memoise into one
    // WeakMap keyed by this object, so whichever method reached a given
    // client first would answer for the other one here. Real deployments
    // negotiate one method per Configuration, which is why this only bites
    // a test that drives both through the same object. Nothing here needs
    // escaping, so the expected header can stay a literal: the
    // form-urlencode-then-base64 is oauth4webapi's, not ours to test.
    const client: oidc.ClientMetadata = {
      client_id: "cid",
      client_secret: "s",
    };
    clientAuthFor(oidcConfig(cfg))(
      { ...PUBLISHED, token_endpoint_auth_methods_supported: declared },
      client,
      body,
      headers,
    );
    return { body, headers };
  }

  function expectBasic({ body, headers }: ReturnType<typeof authenticate>) {
    expect(headers.get("authorization")).toBe(`Basic ${btoa("cid:s")}`);
    // The shape the report measured as a 401 is basic *plus* a body
    // client_id, and the call site alone does not rule it out.
    expect(body.has("client_id")).toBe(false);
    expect(body.has("client_secret")).toBe(false);
  }

  function expectPost({ body, headers }: ReturnType<typeof authenticate>) {
    expect(body.get("client_id")).toBe("cid");
    expect(body.get("client_secret")).toBe("s");
    expect(headers.has("authorization")).toBe(false);
  }

  it("prefers post when the IdP declares both", () => {
    expectPost(authenticate({}, ["client_secret_basic", "client_secret_post"]));
  });

  it("uses basic when that is all the IdP declares", () => {
    expectBasic(authenticate({}, ["client_secret_basic"]));
  });

  it("falls back to post when the IdP declares nothing", () => {
    expectPost(authenticate({}, undefined));
  });

  it("falls back to post rather than vetoing an unimplemented declaration", () => {
    expectPost(authenticate({}, ["private_key_jwt"]));
  });

  it("lets the configured method beat a declaration of post", () => {
    expectBasic(
      authenticate({ token_endpoint_auth_method: "client_secret_basic" }, [
        "client_secret_post",
      ]),
    );
  });

  it("lets the configured method beat a declaration of basic", () => {
    expectPost(
      authenticate({ token_endpoint_auth_method: "client_secret_post" }, [
        "client_secret_basic",
      ]),
    );
  });
});
