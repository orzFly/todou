import { createServer, type Server } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

/**
 * A minimal OpenID Provider for exercising the real openid-client flow:
 * discovery, jwks, token, and userinfo. Claims are mutable per test.
 */
export type StubIssuer = {
  origin: string;
  /** Claims embedded in the next ID token (sub is always present). */
  idTokenClaims: Record<string, unknown>;
  /** Claims served by the userinfo endpoint (merged over { sub }). */
  userinfoClaims: Record<string, unknown>;
  /** When true, the token endpoint answers 500. */
  failTokenEndpoint: boolean;
  subject: string;
  close: () => Promise<void>;
};

export async function startStubIssuer(clientId: string): Promise<StubIssuer> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "stub-key", alg: "RS256" };

  const stub: Omit<StubIssuer, "close" | "origin"> = {
    idTokenClaims: {},
    userinfoClaims: {},
    failTokenEndpoint: false,
    subject: "stub-sub",
  };

  let origin = "";
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", origin);
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

      switch (url.pathname) {
        case "/.well-known/openid-configuration":
          return send(200, {
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            jwks_uri: `${origin}/jwks`,
            userinfo_endpoint: `${origin}/userinfo`,
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
            code_challenge_methods_supported: ["S256"],
          });
        case "/jwks":
          return send(200, { keys: [jwk] });
        case "/token": {
          if (stub.failTokenEndpoint) {
            return send(500, { error: "server_error" });
          }
          const now = Math.floor(Date.now() / 1000);
          const idToken = await new SignJWT({
            sub: stub.subject,
            ...stub.idTokenClaims,
          })
            .setProtectedHeader({ alg: "RS256", kid: "stub-key" })
            .setIssuer(origin)
            .setAudience(clientId)
            .setIssuedAt(now)
            .setExpirationTime(now + 300)
            .sign(privateKey);
          return send(200, {
            access_token: "stub-access-token",
            token_type: "bearer",
            expires_in: 300,
            id_token: idToken,
          });
        }
        case "/userinfo":
          return send(200, { sub: stub.subject, ...stub.userinfoClaims });
        default:
          return send(404, { error: "not_found" });
      }
    })().catch((cause) => {
      res.writeHead(500).end(String(cause));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("stub issuer failed to bind a port");
  }
  origin = `http://127.0.0.1:${address.port}`;

  return Object.assign(stub, {
    origin,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  });
}
