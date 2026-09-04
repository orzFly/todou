import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GoneError,
  MovedError,
  TodouClient,
  TodouError,
} from "../src/client.ts";

type Captured = { url: string; init: RequestInit };

function mockFetch(
  status: number,
  body: unknown,
): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function mockFetchSeq(responses: Array<{ status: number; body?: unknown }>): {
  fetch: typeof fetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const res = responses[calls.length];
    if (!res) throw new Error("no scripted response left");
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(
      res.body === undefined ? null : JSON.stringify(res.body),
      { status: res.status, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const directUploadResponses = (attachment: unknown) => [
  {
    status: 200,
    body: {
      upload_id: 7,
      url: "http://store.test/put",
      headers: {},
      expires_at: "2026-01-01T00:00:00.000Z",
    },
  },
  { status: 200, body: {} },
  { status: 200, body: attachment },
];

describe("TodouClient", () => {
  it("builds csv query strings and skips undefined params", async () => {
    const { fetch, calls } = mockFetch(200, { items: [], next_cursor: null });
    const client = new TodouClient({ fetch });
    await client.listIssues("todou", {
      status: [1, 2],
      q: "potato",
      assignee: undefined,
    });
    expect(calls[0]?.url).toBe(
      "/api/projects/todou/issues?status=1%2C2&q=potato",
    );
  });

  it("sends bearer tokens when configured", async () => {
    const { fetch, calls } = mockFetch(200, { id: 1 });
    const client = new TodouClient({
      fetch,
      token: "todou_pat_x",
      baseUrl: "http://localhost:3000",
    });
    await client.me();
    expect(calls[0]?.url).toBe("http://localhost:3000/api/me");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer todou_pat_x");
  });

  it("builds revision history urls", async () => {
    const { fetch, calls } = mockFetch(200, { items: [] });
    const client = new TodouClient({ fetch });
    await client.getIssueRevisions("todou", 7, { limit: 5 });
    await client.getCommentRevisions("todou", 7, 42);
    expect(calls[0]?.url).toBe(
      "/api/projects/todou/issues/7/revisions?limit=5",
    );
    expect(calls[1]?.url).toBe(
      "/api/projects/todou/issues/7/comments/42/revisions",
    );
  });

  it("throws TodouError with server error codes", async () => {
    const { fetch } = mockFetch(409, {
      error: { code: "conflict", message: "slug taken" },
    });
    const client = new TodouClient({ fetch });
    const err = await client
      .createProject({ slug: "x", name: "X", description: "" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TodouError);
    expect((err as TodouError).status).toBe(409);
    expect((err as TodouError).code).toBe("conflict");
  });

  it("returns undefined for 204 responses", async () => {
    const { fetch } = mockFetch(204, undefined);
    const client = new TodouClient({ fetch });
    await expect(client.logout()).resolves.toBeUndefined();
  });

  it("never invokes the default fetch with the client as `this`", async () => {
    // Browsers enforce that fetch's `this` is window/undefined; storing the
    // bare global fetch and calling it via a private field breaks Firefox.
    const original = globalThis.fetch;
    let observedThis: unknown = "unset";
    globalThis.fetch = function (
      this: unknown,
      ...args: Parameters<typeof fetch>
    ) {
      observedThis = this;
      void args;
      return Promise.resolve(
        new Response(JSON.stringify({ id: 1 }), { status: 200 }),
      );
    } as typeof fetch;
    try {
      const client = new TodouClient();
      await client.me();
      expect(observedThis === undefined || observedThis === globalThis).toBe(
        true,
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it("maps timeline last=true onto last=1", async () => {
    const { fetch, calls } = mockFetch(200, {
      items: [],
      prev_cursor: null,
      next_cursor: null,
    });
    const client = new TodouClient({ fetch });
    await client.getTimeline("todou", 42, { last: true, limit: 50 });
    expect(calls[0]?.url).toBe(
      "/api/projects/todou/issues/42/timeline?last=1&limit=50",
    );
  });

  it("sends custom headers without letting them override auth", async () => {
    const { fetch, calls } = mockFetch(200, { id: 1 });
    const client = new TodouClient({
      fetch,
      token: "todou_pat_x",
      headers: {
        "x-todou-agent-context": '{"agent":"claude-code"}',
        authorization: "Bearer forged",
      },
    });
    await client.me();
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-todou-agent-context"]).toBe('{"agent":"claude-code"}');
    expect(headers.authorization).toBe("Bearer todou_pat_x");
  });

  it("pins sha256 on direct-upload tickets for small files", async () => {
    const attachment = { id: 1, filename: "hello.txt" };
    const { fetch, calls } = mockFetchSeq(directUploadResponses(attachment));
    const client = new TodouClient({ fetch });
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    const result = await client.uploadAttachment("todou", 3, file);
    expect(result).toEqual(attachment);
    const ticket = JSON.parse(String(calls[0]?.init.body)) as Record<
      string,
      unknown
    >;
    expect(ticket.size).toBe(5);
    expect(ticket.sha256).toBe(
      createHash("sha256").update("hello").digest("base64"),
    );
    expect(calls[1]?.url).toBe("http://store.test/put");
    expect(calls[2]?.url).toBe(
      "/api/projects/todou/attachments/direct-uploads/7/complete",
    );
  });

  it("skips sha256 above the hash cap instead of buffering the file", async () => {
    const attachment = { id: 2, filename: "huge.bin" };
    const { fetch, calls } = mockFetchSeq(directUploadResponses(attachment));
    const client = new TodouClient({ fetch });
    const size = 32 * 1024 * 1024 + 1;
    const file = new File([new Uint8Array(size)], "huge.bin");
    const result = await client.uploadAttachment("todou", 3, file);
    expect(result).toEqual(attachment);
    const ticket = JSON.parse(String(calls[0]?.init.body)) as Record<
      string,
      unknown
    >;
    expect(ticket.size).toBe(size);
    expect("sha256" in ticket).toBe(false);
  });

  it("exposes request() for raw API calls", async () => {
    const { fetch, calls } = mockFetch(200, { ok: true });
    const client = new TodouClient({ fetch, token: "todou_pat_x" });
    const result = await client.request<{ ok: boolean }>(
      "POST",
      "/projects/todou/members",
      { json: { user_id: 2 }, query: { dry: true } },
    );
    expect(result).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("/api/projects/todou/members?dry=true");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe('{"user_id":2}');
  });
});

describe("TodouClient batching (T-91)", () => {
  const envelopeFetch = () => {
    const calls: Captured[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const { requests } = JSON.parse(String(init?.body)) as {
        requests: Array<{ url: string }>;
      };
      return Response.json({
        responses: requests.map((r) =>
          r.url === "/missing"
            ? {
                status: 404,
                body: { error: { code: "not_found", message: "nope" } },
              }
            : { status: 200, body: { echo: r.url } },
        ),
      });
    }) as typeof fetch;
    return { fetch: fetchImpl, calls };
  };

  it("coalesces same-tick GETs into one envelope, positionally", async () => {
    const { fetch, calls } = envelopeFetch();
    const client = new TodouClient({ fetch, batch: true });
    const [a, b, c] = await Promise.all([
      client.request("GET", "/me"),
      client.request("GET", "/projects/p/statuses"),
      client.request("GET", "/projects/p/issues", { query: { limit: 5 } }),
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/batch");
    expect(calls[0]?.init.method).toBe("POST");
    expect(a).toEqual({ echo: "/me" });
    expect(b).toEqual({ echo: "/projects/p/statuses" });
    expect(c).toEqual({ echo: "/projects/p/issues?limit=5" });
  });

  it("sends a lone GET directly, keeping plain HTTP semantics", async () => {
    const { fetch, calls } = mockFetch(200, { id: 1 });
    const client = new TodouClient({ fetch, batch: true });
    expect(await client.request("GET", "/me")).toEqual({ id: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/me");
  });

  it("rejects failed items with the same TodouError shape as direct sends", async () => {
    const { fetch } = envelopeFetch();
    const client = new TodouClient({ fetch, batch: true });
    const [ok, missing] = await Promise.allSettled([
      client.request("GET", "/me"),
      client.request("GET", "/missing"),
    ]);
    expect(ok.status).toBe("fulfilled");
    expect(missing.status).toBe("rejected");
    const error = (missing as PromiseRejectedResult).reason as TodouError;
    expect(error).toBeInstanceOf(TodouError);
    expect(error.status).toBe(404);
    expect(error.code).toBe("not_found");
  });

  it("falls back to direct sends and remembers when the gateway is missing", async () => {
    const calls: Captured[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/api/batch")) {
        return Response.json(
          { error: { code: "not_found", message: "no batch here" } },
          { status: 404 },
        );
      }
      return Response.json({ url: String(url) });
    }) as typeof fetch;
    const client = new TodouClient({ fetch: fetchImpl, batch: true });

    const first = await Promise.all([
      client.request("GET", "/me"),
      client.request("GET", "/projects"),
    ]);
    expect(first).toEqual([{ url: "/api/me" }, { url: "/api/projects" }]);
    const batchCalls = calls.filter((c) => c.url.endsWith("/api/batch"));
    expect(batchCalls).toHaveLength(1);

    // Degradation is remembered: the next burst goes straight to direct.
    await Promise.all([
      client.request("GET", "/me"),
      client.request("GET", "/projects"),
    ]);
    expect(calls.filter((c) => c.url.endsWith("/api/batch"))).toHaveLength(1);
  });

  it("keeps writes out of the batch queue", async () => {
    const { fetch, calls } = mockFetch(200, { ok: true });
    const client = new TodouClient({ fetch, batch: true });
    await client.request("POST", "/projects", { json: { slug: "x" } });
    expect(calls[0]?.url).toBe("/api/projects");
    expect(calls[0]?.init.method).toBe("POST");
  });

  it("surfaces a sub-response 301 as MovedError", async () => {
    const fetchImpl = (async () =>
      Response.json({
        responses: [
          { status: 301, body: { moved_to: { slug: "b", number: 45 } } },
        ],
      })) as typeof fetch;
    const client = new TodouClient({ fetch: fetchImpl, batch: true });
    await Promise.all([
      expect(client.request("GET", "/projects/a/issues/123")).rejects.toThrow(
        MovedError,
      ),
      // A second queued GET is what pushes the pair into an envelope.
      client.request("GET", "/me").catch(() => undefined),
    ]);
  });
});

describe("TodouClient redirects (T-231)", () => {
  /** A fetch that reports having followed a redirect, as the real one does. */
  const redirectedFetch = (finalUrl: string, body: unknown = { id: 1 }) =>
    (async () => {
      const res = Response.json(body);
      Object.defineProperty(res, "redirected", { value: true });
      Object.defineProperty(res, "url", { value: finalUrl });
      return res;
    }) as typeof fetch;

  it("turns a followed issue redirect into MovedError", async () => {
    const client = new TodouClient({
      fetch: redirectedFetch("http://todou.example/api/projects/b/issues/45"),
    });
    const error = await client.getIssue("a", 123).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MovedError);
    expect((error as MovedError).movedTo).toEqual({ slug: "b", number: 45 });
  });

  it("carries comment_id when the comment route redirected", async () => {
    const client = new TodouClient({
      fetch: redirectedFetch(
        "http://todou.example/api/projects/b/issues/45/comments/2001",
      ),
    });
    const error = await client
      .locateComment("a", 1462)
      .catch((e: unknown) => e);
    expect((error as MovedError).movedTo).toEqual({
      slug: "b",
      number: 45,
      comment_id: 2001,
    });
  });

  it("keeps sub-route redirects pointed at the issue", async () => {
    const client = new TodouClient({
      fetch: redirectedFetch(
        "http://todou.example/api/projects/b/issues/45/timeline?limit=50",
      ),
    });
    const error = await client
      .getTimeline("a", 123, {})
      .catch((e: unknown) => e);
    expect((error as MovedError).movedTo).toEqual({ slug: "b", number: 45 });
  });

  it("reads the issue out of a redirected attachment list (T-245)", async () => {
    // The list addresses its issue through the query, so there is no
    // `/issues/{n}` in the new URL. Missing it would return B's attachments
    // as though they were A's, with nothing raised.
    const client = new TodouClient({
      fetch: redirectedFetch(
        "http://todou.example/api/projects/b/attachments?issue_number=7",
        [],
      ),
    });
    const error = await client.listAttachments("a", 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MovedError);
    expect((error as MovedError).movedTo).toEqual({ slug: "b", number: 7 });
  });

  it("needs no new rule for a spec sub-route (T-245)", async () => {
    // The guard on the claim that only the attachment list changed shape:
    // the issue rule already tolerates a tail, so the seven other widened
    // entries resolve without touching this function.
    const client = new TodouClient({
      fetch: redirectedFetch(
        "http://todou.example/api/projects/b/issues/7/spec/files",
      ),
    });
    const error = await client.getSpecFiles("a", 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MovedError);
    expect((error as MovedError).movedTo).toEqual({ slug: "b", number: 7 });
  });

  it("leaves an attachment download redirect alone (T-245)", async () => {
    // Anchored at `/attachments`: a download is the binary channel, which is
    // meant to follow its redirect and hand back the bytes.
    const client = new TodouClient({
      fetch: redirectedFetch(
        "http://todou.example/api/projects/b/attachments/2/download/note.txt",
        { ok: true },
      ),
    });
    expect(
      await client.request(
        "GET",
        "/projects/a/attachments/1/download/note.txt",
      ),
    ).toEqual({ ok: true });
  });

  it("leaves a presigned attachment redirect alone", async () => {
    const client = new TodouClient({
      fetch: redirectedFetch("http://store.test/blob/abc?sig=1", { ok: true }),
    });
    expect(await client.request("GET", "/projects/a/attachments/8")).toEqual({
      ok: true,
    });
  });

  it("maps an unfollowed 410 to GoneError with the title", async () => {
    const { fetch } = mockFetch(410, { moved: true, title: "Old card" });
    const client = new TodouClient({ fetch });
    const error = await client.getIssue("a", 123).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoneError);
    expect((error as GoneError).body).toEqual({
      moved: true,
      title: "Old card",
    });
  });

  it("still returns bytes from requestRaw after following a redirect", async () => {
    // The binary channel must not throw: `attach download` following a 301
    // to the moved attachment is exactly the result it wants.
    const fetchImpl = (async () => {
      const res = new Response("PNGDATA", { status: 200 });
      Object.defineProperty(res, "redirected", { value: true });
      Object.defineProperty(res, "url", {
        value: "http://todou.example/api/projects/b/issues/45/comments/2001",
      });
      return res;
    }) as typeof fetch;
    const client = new TodouClient({ fetch: fetchImpl });
    const res = await client.requestRaw("GET", "/projects/a/attachments/88");
    expect(await res.text()).toBe("PNGDATA");
  });
});

describe("TodouClient change stream (T-123)", () => {
  const feed = () => {
    const encoder = new TextEncoder();
    const calls: Captured[] = [];
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let cancelled = false;
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (c) => {
            controller = c;
          },
          cancel: () => {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream; charset=utf-8" } },
      );
    }) as typeof fetch;
    return {
      fetch: fetchImpl,
      calls,
      write: (text: string) => controller?.enqueue(encoder.encode(text)),
      end: () => controller?.close(),
      cancelled: () => cancelled,
    };
  };

  const change = (project: string) =>
    `event: change\ndata: ${JSON.stringify({
      entity: "comment",
      id: 9,
      action: "created",
      issue_number: 3,
      project,
    })}\n\n`;

  it("subscribes to the user-level feed with the bearer token", async () => {
    const server = feed();
    const client = new TodouClient({
      baseUrl: "http://api.test",
      token: "todou_pat_test",
      fetch: server.fetch,
      headers: { "x-todou-agent-context": "{}" },
    });
    const stream = await client.openChangeStream({ onEvent: () => {} });
    expect(server.calls[0]?.url).toBe("http://api.test/api/events");
    const headers = server.calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer todou_pat_test");
    expect(headers.accept).toBe("text/event-stream");
    expect(headers["x-todou-agent-context"]).toBe("{}");
    stream.close();
  });

  it("dispatches change events and reports liveness for every chunk", async () => {
    const server = feed();
    const client = new TodouClient({ fetch: server.fetch });
    const events: string[] = [];
    let alive = 0;
    const stream = await client.openChangeStream({
      onEvent: (event) => events.push(`${event.project}/${event.entity}`),
      onAlive: () => {
        alive += 1;
      },
    });
    server.write(`event: hello\ndata: {}\n\n${change("todou")}`);
    server.write("event: ping\ndata: {}\n\n");
    server.end();
    await stream.closed;
    // One dispatch per change event; liveness counts bytes, not frames, so
    // a heartbeat carrying no change still proves the stream is alive.
    expect(events).toEqual(["todou/comment"]);
    expect(alive).toBe(2);
  });

  it("drops frames it cannot read instead of ending the stream", async () => {
    const server = feed();
    const client = new TodouClient({ fetch: server.fetch });
    const events: string[] = [];
    const stream = await client.openChangeStream({
      onEvent: (event) => events.push(event.project),
    });
    server.write("event: change\ndata: not json\n\n");
    server.write('event: change\ndata: {"entity":"nope"}\n\n');
    server.write(change("todou"));
    server.end();
    await stream.closed;
    expect(events).toEqual(["todou"]);
  });

  it("reports a server without the feed as a plain 404", async () => {
    const { fetch } = mockFetch(404, {
      error: { code: "not_found", message: "no route" },
    });
    const client = new TodouClient({ fetch });
    const error: unknown = await client
      .openChangeStream({ onEvent: () => {} })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TodouError);
    expect((error as TodouError).status).toBe(404);
  });

  it("refuses a 2xx that is not an event stream", async () => {
    const { fetch } = mockFetch(200, { hello: "i am a login page" });
    const client = new TodouClient({ fetch });
    const error: unknown = await client
      .openChangeStream({ onEvent: () => {} })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TodouError);
    expect((error as TodouError).code).toBe("not_event_stream");
    // 200, so callers classify it as permanent rather than retrying it.
    expect((error as TodouError).status).toBe(200);
  });

  it("close() cancels the body so the process can exit", async () => {
    const server = feed();
    const client = new TodouClient({ fetch: server.fetch });
    const stream = await client.openChangeStream({ onEvent: () => {} });
    stream.close();
    await stream.closed;
    expect(server.cancelled()).toBe(true);
  });
});

describe("TodouClient canonical slug notice (T-156)", () => {
  const withHeader = (canonical?: string): typeof fetch =>
    (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          ...(canonical === undefined
            ? {}
            : { "x-todou-canonical-slug": canonical }),
        },
      })) as typeof fetch;

  it("reports the current slug when the response carries one", async () => {
    const seen: string[] = [];
    const client = new TodouClient({
      fetch: withHeader("newname"),
      onCanonicalSlug: (slug) => seen.push(slug),
    });
    await client.request("GET", "/projects/oldname");
    expect(seen).toEqual(["newname"]);
  });

  it("stays quiet when the slug used is the current one", async () => {
    const seen: string[] = [];
    const client = new TodouClient({
      fetch: withHeader(),
      onCanonicalSlug: (slug) => seen.push(slug),
    });
    await client.request("GET", "/projects/newname");
    expect(seen).toEqual([]);
  });

  it("never fires on an error response", async () => {
    const seen: string[] = [];
    const client = new TodouClient({
      fetch: (async () =>
        new Response(JSON.stringify({ error: { code: "not_found" } }), {
          status: 404,
          headers: {
            "content-type": "application/json",
            "x-todou-canonical-slug": "newname",
          },
        })) as typeof fetch,
      onCanonicalSlug: (slug) => seen.push(slug),
    });
    await expect(client.request("GET", "/projects/oldname")).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});
