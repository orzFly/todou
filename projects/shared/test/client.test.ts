import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GoneError,
  MovedError,
  TodouClient,
  TodouError,
  TodouNetworkError,
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
  it.each([undefined, "Rework the design"])(
    "posts a version-guarded withdrawal with reason=%s",
    async (reason) => {
      const result = {
        version: 2,
        review_status: "withdrawn",
        unchanged: false,
        cursor: "withdrawal-cursor",
      };
      const { fetch, calls } = mockFetch(200, result);
      const client = new TodouClient({ fetch });
      const input = { version: 2, ...(reason === undefined ? {} : { reason }) };

      await expect(client.withdrawSpec("todou", 428, input)).resolves.toEqual(
        result,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(
        "/api/projects/todou/issues/428/spec/withdraw",
      );
      expect(calls[0]?.init.method).toBe("POST");
      expect(JSON.parse(String(calls[0]?.init.body))).toEqual(input);
    },
  );

  it("does not retry a conflicting withdrawal with a stale version", async () => {
    const { fetch, calls } = mockFetch(409, {
      error: {
        code: "conflict",
        message: "Current spec is v3 (unreviewed); refresh before withdrawing",
      },
    });
    const client = new TodouClient({ fetch });
    await expect(
      client.withdrawSpec("todou", 428, { version: 2 }),
    ).rejects.toMatchObject({ status: 409, code: "conflict" });
    expect(calls).toHaveLength(1);
  });

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

  it("addresses the metadata endpoints (T-282)", async () => {
    const { fetch, calls } = mockFetch(200, { entries: [] });
    const client = new TodouClient({ fetch });
    await client.getIssueMetadata("todou", 282, ["orch", "ci"]);
    await client.getIssueMetadata("todou", 282, "*");
    await client.getIssue("todou", 282, { metadata: "*" });
    // No namespaces asked for means no parameter at all, which is what the
    // server reads as "do not return the field".
    await client.getIssue("todou", 282);
    await client.listIssueMetadataNamespaces("todou", 282);
    await client.writeIssueMetadata("todou", 282, {
      entries: [{ namespace: "orch", key: "phase", value: "plan" }],
    });
    expect(calls.map((c) => c.url)).toEqual([
      "/api/projects/todou/issues/282/metadata?namespace=orch%2Cci",
      "/api/projects/todou/issues/282/metadata?namespace=*",
      "/api/projects/todou/issues/282?metadata=*",
      "/api/projects/todou/issues/282",
      "/api/projects/todou/issues/282/metadata/namespaces",
      "/api/projects/todou/issues/282/metadata",
    ]);
    expect(calls[5]?.init.method).toBe("PATCH");
  });

  it("puts both stream subscriptions in the events URL (T-282)", async () => {
    const { fetch } = mockFetch(200, {});
    const client = new TodouClient({ fetch });
    expect(client.userEventsUrl()).toBe("/api/events");
    expect(client.userEventsUrl({ inbox: true })).toBe("/api/events?inbox=1");
    expect(client.userEventsUrl({ inbox: true, metadata: "*" })).toBe(
      "/api/events?inbox=1&metadata=*",
    );
    expect(client.userEventsUrl({ metadata: ["orch"] })).toBe(
      "/api/events?metadata=orch",
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

/** A batch-answering fetch that echoes URLs, 404s on /missing (T-91 suite). */
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

describe("TodouClient batching (T-91)", () => {
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

describe("TodouClient batch streaming (T-368)", () => {
  /**
   * A fetch answering the batch POST with an SSE stream the test writes
   * frame by frame. `write` enqueues a raw chunk, `finish` closes.
   */
  function streamFetch() {
    const calls: Captured[] = [];
    const encoder = new TextEncoder();
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        source = controller;
      },
    });
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const write = (chunk: string): void => {
      if (source === undefined) throw new Error("stream not started");
      // A real fetch body carries bytes, so the harness encodes.
      source.enqueue(encoder.encode(chunk));
    };
    const close = (): void => {
      source?.close();
    };
    return { fetch: fetchImpl, calls, write, close };
  }

  const flushTick = (): Promise<void> =>
    // Executor form, not withResolvers: this package's lib target predates
    // es2024 and the change is confined to this one helper.
    new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

  it("settles waiters as item frames arrive, in arrival order", async () => {
    const { fetch, calls, write } = streamFetch();
    const client = new TodouClient({ fetch, batch: true });

    // Enqueue order fixes chunk positions: two=0, one=1.
    const two = client.request("GET", "/two");
    const one = client.request("GET", "/one");
    // The flush runs on the macrotask timer; await that timer's own signal:
    // the batch POST is the only thing scheduled on it.
    await flushTick();
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.accept).toBe("text/event-stream");

    // index 1 arrives first and settles its waiter before the stream ends —
    // a hold-everything-until-done implementation hangs this await.
    write('event: item\ndata: {"index":1,"status":200,"body":{"n":2}}\n\n');
    await expect(one).resolves.toEqual({ n: 2 });

    write('event: item\ndata: {"index":0,"status":200,"body":{"n":1}}\n\n');
    write('event: done\ndata: {"count":2}\n\n');
    await expect(two).resolves.toEqual({ n: 1 });
  });

  it("maps failed item frames to the same TodouError shape", async () => {
    const { fetch, write } = streamFetch();
    const client = new TodouClient({ fetch, batch: true });
    const missing = client.request("GET", "/missing");
    client.request("GET", "/me").catch(() => undefined);
    await flushTick();
    write(
      'event: item\ndata: {"index":0,"status":404,"body":{"error":{"code":"not_found","message":"nope"}}}\n\n',
    );
    write('event: done\ndata: {"count":2}\n\n');
    const error = (await missing.catch((e: unknown) => e)) as TodouError;
    expect(error).toBeInstanceOf(TodouError);
    expect(error.status).toBe(404);
    expect(error.code).toBe("not_found");
  });

  it("maps a 301 item with moved_to to MovedError", async () => {
    const { fetch, write } = streamFetch();
    const client = new TodouClient({ fetch, batch: true });
    const moved = client.request("GET", "/projects/a/issues/1");
    client.request("GET", "/me").catch(() => undefined);
    await flushTick();
    write(
      'event: item\ndata: {"index":0,"status":301,"body":{"moved_to":{"slug":"b","number":45}}}\n\n',
    );
    write('event: done\ndata: {"count":2}\n\n');
    const error = (await moved.catch((e: unknown) => e)) as MovedError;
    expect(error).toBeInstanceOf(MovedError);
    expect(error.movedTo).toEqual({ slug: "b", number: 45 });
  });

  it("rejects waiters the stream never settles as batch_mismatch", async () => {
    const { fetch, write, close } = streamFetch();
    const client = new TodouClient({ fetch, batch: true });
    const one = client.request("GET", "/one");
    const two = client.request("GET", "/two");
    await flushTick();
    // Truncated: index 0 never arrives and there is no done frame.
    write('event: item\ndata: {"index":1,"status":200,"body":{"n":2}}\n\n');
    await expect(two).resolves.toEqual({ n: 2 });
    close();
    const error = (await one.catch((e: unknown) => e)) as TodouError;
    expect(error).toBeInstanceOf(TodouError);
    expect(error.code).toBe("batch_mismatch");
  });

  it("rejects waiters when the stream errors mid-flight", async () => {
    const encoder = new TextEncoder();
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        source = c;
      },
    });
    const fetchImpl = (async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch;
    const client = new TodouClient({ fetch: fetchImpl, batch: true });
    const one = client.request("GET", "/one");
    const two = client.request("GET", "/two");
    await flushTick();
    if (source === undefined) throw new Error("stream not started");
    source.enqueue(
      encoder.encode(
        'event: item\ndata: {"index":1,"status":200,"body":{"n":2}}\n\n',
      ),
    );
    await expect(two).resolves.toEqual({ n: 2 });
    // A reset connection instead of a clean end: the read rejects, and the
    // unsatisfied waiter must be rejected too — not left pending forever.
    source.error(new Error("connection reset"));
    const error = (await one.catch((e: unknown) => e)) as TodouError;
    expect(error).toBeInstanceOf(TodouError);
    expect(error.code).toBe("batch_mismatch");
  });

  it("rejects waiters when a 200 claims JSON but is not the envelope", async () => {
    const fetchImpl = (async () =>
      new Response("<html>login page</html>", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const client = new TodouClient({ fetch: fetchImpl, batch: true });
    const results = await Promise.allSettled([
      client.request("GET", "/one"),
      client.request("GET", "/two"),
    ]);
    // Pre-fix this hung forever: the json() rejection escaped the
    // fire-and-forget flush and neither waiter ever settled.
    for (const r of results) {
      expect(r.status).toBe("rejected");
      if (r.status === "rejected") {
        expect((r.reason as TodouError).code).toBe("batch_mismatch");
      }
    }
  });

  it("still reads the JSON envelope when the server answers JSON", async () => {
    const { fetch, calls } = envelopeFetch();
    const client = new TodouClient({ fetch, batch: true });
    const [a, b] = await Promise.all([
      client.request("GET", "/me"),
      client.request("GET", "/projects"),
    ]);
    expect(a).toEqual({ echo: "/me" });
    expect(b).toEqual({ echo: "/projects" });
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.accept).toBe("text/event-stream");
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

  it("marks an error thrown by fetch as a transport failure", async () => {
    const cause = new TypeError("fetch failed");
    const client = new TodouClient({
      fetch: (async () => {
        throw cause;
      }) as typeof fetch,
    });

    const error = await client.getSpecFiles("a", 1).catch((caught) => caught);
    expect(error).toBeInstanceOf(TodouNetworkError);
    expect((error as TodouNetworkError).cause).toBe(cause);
  });

  it("marks a response body stream reset, but not invalid JSON, as transport failure", async () => {
    const cause = new TypeError("body stream reset");
    const client = new TodouClient({
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(cause);
            },
          }),
          { status: 200 },
        ),
    });
    const error = await client.getSpecFiles("a", 1).catch((caught) => caught);
    expect(error).toBeInstanceOf(TodouNetworkError);
    expect((error as TodouNetworkError).cause).toBe(cause);

    const malformed = new TodouClient({
      fetch: async () => new Response("{broken", { status: 200 }),
    });
    await expect(malformed.getSpecFiles("a", 1)).rejects.toBeInstanceOf(
      SyntaxError,
    );

    const bug = new Error("body adapter bug");
    const response = new Response("{}");
    response.text = async () => {
      throw bug;
    };
    const buggy = new TodouClient({ fetch: async () => response });
    await expect(buggy.getSpecFiles("a", 1)).rejects.toBe(bug);
  });

  it("does not label query serialization or synchronous adapter bugs as network failures", async () => {
    let calls = 0;
    const client = new TodouClient({
      fetch: async () => {
        calls += 1;
        return new Response("{}");
      },
    });
    const query = Object.defineProperty({}, "version", {
      enumerable: true,
      get() {
        throw new TypeError("query getter bug");
      },
    });
    const error = await client
      .requestRaw("GET", "/me", { query })
      .catch((caught) => caught);
    expect(calls).toBe(0);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(TodouNetworkError);

    const adapterBug = new TypeError("adapter bug");
    const adapter = new TodouClient({
      fetch: (() => {
        throw adapterBug;
      }) as typeof fetch,
    });
    const thrown = await adapter.me().catch((caught) => caught);
    expect(thrown).toBe(adapterBug);
  });

  it("keeps aborted fetches as cancellations", async () => {
    const abort = new DOMException("cancelled", "AbortError");
    const client = new TodouClient({
      fetch: async () => {
        throw abort;
      },
    });
    await expect(client.me()).rejects.toBe(abort);
    const response = new Response("{}");
    response.text = async () => {
      throw abort;
    };
    const bodyAbort = new TodouClient({ fetch: async () => response });
    await expect(bodyAbort.me()).rejects.toBe(abort);
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

  // A proxy that mounts the server under a subpath puts its own prefix back
  // on the `Location`, so the final URL a client lands on carries it (T-246).
  describe("mounted under a path prefix", () => {
    const moved = "http://gw.example/todou/api/projects/b/issues/45";

    it.each([
      ["an absolute base url", "http://gw.example/todou"],
      ["a trailing slash on the base url", "http://gw.example/todou/"],
      ["a base url that is only the prefix", "/todou"],
    ])("reads the move past the prefix with %s", async (_name, baseUrl) => {
      const client = new TodouClient({
        baseUrl,
        fetch: redirectedFetch(moved),
      });
      const error = await client.getIssue("a", 123).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MovedError);
      expect((error as MovedError).movedTo).toEqual({ slug: "b", number: 45 });
    });

    it("carries comment_id past the prefix too", async () => {
      const client = new TodouClient({
        baseUrl: "http://gw.example/todou",
        fetch: redirectedFetch(
          "http://gw.example/todou/api/projects/b/issues/45/comments/2001",
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

    it("leaves a landing outside the mount point alone", async () => {
      const client = new TodouClient({
        baseUrl: "http://gw.example/todou",
        fetch: redirectedFetch("http://gw.example/api/projects/b/issues/45"),
      });
      expect(await client.getIssue("a", 123)).toEqual({ id: 1 });
    });

    it("leaves the same prefix on another host alone", async () => {
      const client = new TodouClient({
        baseUrl: "http://gw.example/todou",
        fetch: redirectedFetch(
          "http://evil.test/todou/api/projects/b/issues/45",
        ),
      });
      expect(await client.getIssue("a", 123)).toEqual({ id: 1 });
    });

    it("reads a redirected attachment list's issue out of the query past the prefix (T-250)", async () => {
      // The answer is assembled from two parts of one URL: the path reduced
      // by the mount prefix, and the issue number off the query of the
      // untouched URL. That holds only while a prefix lives in the path.
      const client = new TodouClient({
        baseUrl: "http://gw.example/todou",
        fetch: redirectedFetch(
          "http://gw.example/todou/api/projects/b/attachments?issue_number=7",
          [],
        ),
      });
      const error = await client
        .listAttachments("a", 1)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MovedError);
      expect((error as MovedError).movedTo).toEqual({ slug: "b", number: 7 });
    });

    it("keeps a spec sub-route pointed at the issue past the prefix (T-250)", async () => {
      const client = new TodouClient({
        baseUrl: "http://gw.example/todou",
        fetch: redirectedFetch(
          "http://gw.example/todou/api/projects/b/issues/7/spec/files",
        ),
      });
      const error = await client.getSpecFiles("a", 1).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MovedError);
      expect((error as MovedError).movedTo).toEqual({ slug: "b", number: 7 });
    });

    it("leaves an attachment download redirect alone past the prefix (T-250)", async () => {
      // What fails this is the attachment list rule losing its trailing
      // anchor; removing the prefix reduction cannot, because reducing less
      // can only match less.
      const client = new TodouClient({
        baseUrl: "http://gw.example/todou",
        fetch: redirectedFetch(
          "http://gw.example/todou/api/projects/b/attachments/2/download/note.txt",
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
