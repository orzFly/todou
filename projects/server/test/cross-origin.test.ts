import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const fromPeer = (remoteAddress: string) => ({
  incoming: { socket: { remoteAddress } },
});

const CROSS_SITE = {
  origin: "https://evil.example",
  "sec-fetch-site": "cross-site",
};

async function expectRefused(res: Response) {
  expect(res.status).toBe(403);
  expect((await json(res)).error.code).toBe("cross_origin_request");
}

async function expectNotRefused(res: Response) {
  if (res.status === 403) {
    expect((await json(res)).error.code).not.toBe("cross_origin_request");
  }
}

describe("cross-origin guard, cookie session (single mode)", () => {
  let t: TestApp;
  let cookie: string;
  let bearer: { authorization: string };
  const slug = "csrf";

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    ({ headers: bearer } = await addUserWithToken(t.ctx, "bot-one", {
      instanceAdmin: true,
    }));
    await t.app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ slug, name: "CSRF" }),
    });
    await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title: "target" }),
    });
  });

  afterAll(async () => {
    await t.cleanup();
  });

  const upload = (headers: Record<string, string>) => {
    const form = new FormData();
    form.set("file", new File(["evil"], "evil.txt", { type: "text/plain" }));
    form.set("issue_number", "1");
    return t.app.request(`/api/projects/${slug}/attachments`, {
      method: "POST",
      headers,
      body: form,
    });
  };

  const restore = (headers: Record<string, string>) =>
    t.app.request(`/api/projects/${slug}/issues/1/restore`, {
      method: "POST",
      headers,
    });

  it("refuses a cross-site multipart upload", async () => {
    await expectRefused(await upload({ cookie, ...CROSS_SITE }));
  });

  it("refuses a same-site one: SameSite=Lax lets a sibling subdomain in", async () => {
    await expectRefused(
      await upload({
        cookie,
        origin: "https://sibling.todou.example",
        "sec-fetch-site": "same-site",
      }),
    );
  });

  it("refuses a body-less cross-site POST", async () => {
    await expectRefused(await restore({ cookie, ...CROSS_SITE }));
    await expectRefused(
      await t.app.request("/api/auth/cli/requests/999/deny", {
        method: "POST",
        headers: { cookie, ...CROSS_SITE },
      }),
    );
  });

  it("refuses a cross-site login, which is a state change too", async () => {
    await expectRefused(
      await t.app.request("/api/auth/login", {
        method: "POST",
        headers: CROSS_SITE,
      }),
    );
  });

  it("lets the deployment's own pages through", async () => {
    const res = await upload({
      cookie,
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
    });
    expect(res.status).toBe(201);
    // The vite dev server proxies /api: Origin names the dev port, the
    // browser still calls it same-origin, and that verdict is what counts.
    const dev = await upload({
      cookie,
      origin: "http://localhost:5173",
      "sec-fetch-site": "same-origin",
    });
    expect(dev.status).toBe(201);
  });

  it("lets a user-initiated request (no initiating page) through", async () => {
    await expectNotRefused(await restore({ cookie, "sec-fetch-site": "none" }));
  });

  it("lets a request with no browser headers through (CLI, curl)", async () => {
    expect((await upload({ cookie })).status).toBe(201);
  });

  it("exempts Bearer, even carrying a hostile Origin", async () => {
    const res = await upload({ ...bearer, ...CROSS_SITE });
    expect(res.status).toBe(201);
  });

  it("does not exempt Basic: browsers replay it on any site's form", async () => {
    await expectRefused(
      await upload({ authorization: "Basic dXNlcjpwdw==", ...CROSS_SITE }),
    );
  });

  it("leaves safe methods alone (reads, the oidc callback, SSE)", async () => {
    const me = await t.app.request("/api/me", {
      headers: { cookie, ...CROSS_SITE },
    });
    expect(me.status).toBe(200);
    const head = await t.app.request("/api/me", {
      method: "HEAD",
      headers: { cookie, ...CROSS_SITE },
    });
    expect(head.status).toBe(200);
    await expectNotRefused(
      await t.app.request("/api/auth/callback?code=x&state=y", {
        headers: CROSS_SITE,
      }),
    );
  });

  it("lets the web's batch envelope through and still refuses it cross-site", async () => {
    const body = JSON.stringify({ requests: [{ url: "/me" }] });
    const ok = await t.app.request("/api/batch", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body,
    });
    expect(ok.status).toBe(200);
    expect((await json(ok)).responses[0].status).toBe(200);
    await expectRefused(
      await t.app.request("/api/batch", {
        method: "POST",
        headers: { cookie, "content-type": "text/plain", ...CROSS_SITE },
        body,
      }),
    );
  });

  describe("browsers without Sec-Fetch-Site fall back to Origin", () => {
    it("refuses a foreign Origin", async () => {
      await expectRefused(
        await upload({ cookie, origin: "https://evil.example" }),
      );
    });

    it("refuses the opaque origin a sandboxed frame sends", async () => {
      await expectRefused(await upload({ cookie, origin: "null" }));
    });

    it("accepts the Host the browser addressed, whatever the scheme", async () => {
      // TLS terminates upstream: the server sees http, the page is https.
      const res = await upload({
        cookie,
        host: "todou.example",
        origin: "https://todou.example",
      });
      expect(res.status).toBe(201);
    });

    it("refuses a sibling host, which differs only below the site", async () => {
      await expectRefused(
        await upload({
          cookie,
          host: "todou.example",
          origin: "https://evil.todou.example",
        }),
      );
    });
  });
});

describe("cross-origin guard behind a proxy that rewrites Host", () => {
  const PUBLIC = "https://todou.example";

  it("accepts Origin matching http.public_origin", async () => {
    const t = await makeTestApp("shared", {
      extraToml: `[http]\npublic_origin = "${PUBLIC}"`,
    });
    try {
      const cookie = await t.login();
      const res = await t.app.request("/api/me/prefs", {
        method: "PATCH",
        headers: {
          cookie,
          host: "127.0.0.1:8637",
          origin: PUBLIC,
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(res.status).toBe(200);
    } finally {
      await t.cleanup();
    }
  });

  it("accepts Origin matching a trusted X-Forwarded-Host, not an untrusted one", async () => {
    const t = await makeTestApp();
    try {
      const cookie = await t.login();
      const prefs = (peer: string) =>
        t.app.request(
          "/api/me/prefs",
          {
            method: "PATCH",
            headers: {
              cookie,
              host: "127.0.0.1:8637",
              "x-forwarded-host": "todou.example",
              origin: PUBLIC,
              "content-type": "application/json",
            },
            body: "{}",
          },
          fromPeer(peer),
        );
      expect((await prefs("127.0.0.1")).status).toBe(200);
      await expectRefused(await prefs("203.0.113.9"));
    } finally {
      await t.cleanup();
    }
  });
});

describe("cross-origin guard, forward mode", () => {
  let t: TestApp;
  const FORWARD_TOML = [
    "[auth]",
    'mode = "forward"',
    "[auth.forward]",
    'user_header = "Remote-User"',
  ].join("\n");
  const asAlice = { "remote-user": "alice" };

  beforeAll(async () => {
    t = await makeTestApp("shared", { extraToml: FORWARD_TOML });
  });

  afterAll(async () => {
    await t.cleanup();
  });

  const avatar = (headers: Record<string, string>) => {
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "a.png", {
        type: "image/png",
      }),
    );
    return t.app.request(
      "/api/me/avatar",
      { method: "POST", headers, body: form },
      fromPeer("127.0.0.1"),
    );
  };

  it("refuses what the proxy authenticated but another site sent", async () => {
    await expectRefused(await avatar({ ...asAlice, ...CROSS_SITE }));
  });

  it("serves the same request from the deployment's own pages", async () => {
    await expectNotRefused(
      await avatar({ ...asAlice, "sec-fetch-site": "same-origin" }),
    );
  });
});

describe("JSON routes take JSON", () => {
  let t: TestApp;
  let cookie: string;
  const slug = "typed";

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    await t.app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ slug, name: "Typed" }),
    });
    await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title: "carries files" }),
    });
  });

  afterAll(async () => {
    await t.cleanup();
  });

  const send = (
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: RequestInit["body"],
  ) => t.app.request(path, { method, headers: { cookie, ...headers }, body });

  it("415s text/plain where an all-optional schema used to accept {}", async () => {
    const res = await send(
      "PATCH",
      "/api/me/prefs",
      { "content-type": "text/plain" },
      "{}",
    );
    expect(res.status).toBe(415);
    expect((await json(res)).error.code).toBe("unsupported_media_type");
  });

  it("415s text/plain where the handler used to crash on {}", async () => {
    for (const path of ["/api/me/tokens", `/api/projects/${slug}/issues`]) {
      const res = await send(
        "POST",
        path,
        { "content-type": "text/plain" },
        '{"name":"x","title":"x"}',
      );
      expect(res.status).toBe(415);
    }
  });

  it("415s a form-encoded body", async () => {
    const res = await send(
      "POST",
      `/api/projects/${slug}/issues`,
      { "content-type": "application/x-www-form-urlencoded" },
      "title=x",
    );
    expect(res.status).toBe(415);
  });

  it("415s a body that names no type at all", async () => {
    const res = await send(
      "POST",
      `/api/projects/${slug}/issues`,
      { "content-length": "11" },
      new Uint8Array(new TextEncoder().encode('{"title":1}')),
    );
    expect(res.status).toBe(415);
  });

  it("still takes JSON, with or without parameters", async () => {
    for (const type of [
      "application/json",
      "application/json; charset=utf-8",
    ]) {
      const res = await send(
        "POST",
        `/api/projects/${slug}/issues`,
        { "content-type": type },
        JSON.stringify({ title: "typed" }),
      );
      expect(res.status).toBe(201);
    }
  });

  it("holds a body-less request to the schema as {}", async () => {
    // Used to reach the handler unvalidated and crash on the NOT NULL name.
    const res = await send("POST", "/api/me/tokens", {});
    expect(res.status).toBe(422);
    expect((await json(res)).error.message).toContain("name");
    // Every field optional: an omitted body is a legitimate empty one.
    expect((await send("PATCH", "/api/me/prefs", {})).status).toBe(200);
  });

  it("leaves multipart routes to their own validators", async () => {
    const form = new FormData();
    form.set("file", new File(["x"], "x.txt", { type: "text/plain" }));
    form.set("issue_number", "1");
    const res = await send(
      "POST",
      `/api/projects/${slug}/attachments`,
      {},
      form,
    );
    expect(res.status).toBe(201);
  });
});
