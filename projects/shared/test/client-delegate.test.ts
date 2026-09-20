import { describe, expect, it, vi } from "vitest";
import {
  type ClientErrorEnvelope,
  deserializeClientError,
  type ErrorEnvelope,
  GoneError,
  MovedError,
  type MutationLifecycleEvent,
  type RequestContext,
  type RequestDelegate,
  serializeClientError,
  TodouClient,
  TodouError,
  TodouNetworkError,
} from "../src/index.ts";

type Call = { url: string; init?: RequestInit };

// This package targets ES2023, before Promise.withResolvers.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function network() {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/batch")) {
      const body = JSON.parse(String(init?.body)) as {
        requests: Array<{ url: string }>;
      };
      return Response.json({
        responses: body.requests.map(({ url }) => ({
          status: 200,
          body: { url },
        })),
      });
    }
    return Response.json({ url: String(url) });
  };
  return { calls, fetch };
}

describe("TodouClient logical delegate", () => {
  it("exports context types and delegates typed GETs before the batch queue", async () => {
    const transport = network();
    const delegate = vi.fn<RequestDelegate>(async ({ path, query }) => ({
      path,
      query,
    }));
    const client = new TodouClient({ ...transport, batch: true, delegate });
    const context: RequestContext = {
      projectionId: "issues",
      forceFresh: true,
    };
    const query = { status: [1, 2], q: "red green", limit: 5 };
    const result = await Promise.all([
      client.withContext(context).listIssues("alpha", query),
      client.withContext({ projectionId: "projects" }).listProjects(),
    ]);
    expect(result).toEqual([
      { path: "/projects/alpha/issues", query },
      { path: "/projects", query: undefined },
    ]);
    expect(delegate).toHaveBeenCalledTimes(2);
    expect(delegate.mock.calls[0]?.[0]).toMatchObject({
      method: "GET",
      path: "/projects/alpha/issues",
      query,
      context,
    });
    expect(transport.calls).toEqual([]);
  });

  it("takes immutable independent context snapshots across awaited calls", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const contexts: RequestContext[] = [];
    const client = new TodouClient({
      delegate: ({ context }) => {
        contexts.push(context);
        return contexts.length === 1 ? first.promise : second.promise;
      },
    });
    const source = { origin: "tab-one", projectionId: "one", forceFresh: true };
    const view = client.withContext(source);
    source.projectionId = "changed";
    const one = view.me();
    const two = view
      .withContext({ projectionId: "two", forceFresh: false })
      .me();
    second.resolve({ id: 2 });
    first.resolve({ id: 1 });
    await expect(one).resolves.toEqual({ id: 1 });
    await expect(two).resolves.toEqual({ id: 2 });
    expect(contexts).toMatchObject([
      { origin: "tab-one", projectionId: "one", forceFresh: true },
      { origin: "tab-one", projectionId: "two", forceFresh: false },
    ]);
    expect(contexts.every(Object.isFrozen)).toBe(true);
    await client.me();
    expect(contexts[2]?.projectionId).toBeUndefined();
  });

  it("shares batch queue and transport configuration across context views", async () => {
    const transport = network();
    const headers = { "x-client": "original" };
    const client = new TodouClient({
      ...transport,
      batch: true,
      baseUrl: "https://todou.example/prefix",
      headers,
      token: "todou_pat_fake",
    });
    headers["x-client"] = "changed";
    const results = await Promise.all([
      client.withContext({ projectionId: "one" }).me(),
      client.withContext({ projectionId: "two" }).listProjects(),
      client.version(),
    ]);
    expect(results).toEqual([
      { url: "/me" },
      { url: "/projects" },
      { url: "/version" },
    ]);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.url).toBe(
      "https://todou.example/prefix/api/batch",
    );
    expect(transport.calls[0]?.init?.headers).toMatchObject({
      "x-client": "original",
      authorization: "Bearer todou_pat_fake",
    });
  });

  it("leaves a lone GET direct and preserves 50-item chunking", async () => {
    const transport = network();
    const client = new TodouClient({ ...transport, batch: true });
    await expect(
      client.withContext({ projectionId: "one" }).me(),
    ).resolves.toEqual({ url: "/api/me" });
    const results = await Promise.all(
      Array.from({ length: 101 }, (_, n) =>
        client
          .withContext({ projectionId: String(n) })
          .request("GET", `/items/${n}`),
      ),
    );
    expect(results).toHaveLength(101);
    expect(
      transport.calls.slice(1).map(({ init }) => {
        const envelope: { requests: unknown[] } = JSON.parse(
          String(init?.body),
        );
        return envelope.requests.length;
      }),
    ).toEqual([50, 50, 1]);
  });

  it.each([404, 405])(
    "shares remembered batch unavailability (%i) with later views",
    async (status) => {
      const calls: string[] = [];
      const client = new TodouClient({
        batch: true,
        fetch: async (url) => {
          calls.push(String(url));
          return String(url).endsWith("/batch")
            ? Response.json({ error: { code: "unknown" } }, { status })
            : Response.json({ ok: true });
        },
      });
      await Promise.all([
        client.withContext({}).me(),
        client.withContext({}).version(),
      ]);
      await Promise.all([client.me(), client.withContext({}).version()]);
      expect(calls.filter((url) => url === "/api/batch")).toHaveLength(1);
      expect(calls).toHaveLength(5);
    },
  );

  it("keeps writes, FormData, and real raw responses outside the delegate", async () => {
    const delegate = vi.fn<RequestDelegate>(async () => ({ delegated: true }));
    const calls: Call[] = [];
    const responses: Response[] = [];
    const client = new TodouClient({
      batch: true,
      delegate,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        const response = Response.json({ direct: true });
        responses.push(response);
        return response;
      },
    });
    await expect(
      client.request("POST", "/projects", { json: { slug: "alpha" } }),
    ).resolves.toEqual({ direct: true });
    const form = new FormData();
    form.set("file", "payload");
    await client.request("GET", "/form", { form });
    const response = await client.requestRaw("GET", "/download");
    expect(response).toBe(responses[2]);
    expect(await response.json()).toEqual({ direct: true });
    expect(calls.map(({ url }) => url)).toEqual([
      "/api/projects",
      "/api/form",
      "/api/download",
    ]);
    expect(calls[1]?.init?.body).toBe(form);
    expect(delegate).not.toHaveBeenCalled();
  });

  it("preserves the original logical error path including query across delegation", async () => {
    const serverError = new TodouError(
      403,
      "forbidden",
      "cannot read",
      { role: "none" },
      "/batch",
    );
    const client = new TodouClient({
      baseUrl: "https://todou.example/prefix",
      batch: true,
      delegate: async () => {
        throw serverError;
      },
    });
    const error = await client
      .listIssues("alpha", {
        status: [1, 2],
        q: "red green",
        absent: undefined,
      })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(TodouError);
    expect(error).toMatchObject({
      status: 403,
      code: "forbidden",
      message: "cannot read",
      details: { role: "none" },
      path: "/projects/alpha/issues?status=1%2C2&q=red+green",
    });
    expect(serverError.path).toBe("/batch");
  });

  it("keeps network redirects in the network client and preserves their logical path over RPC", async () => {
    const networkClient = new TodouClient({
      baseUrl: "https://todou.example/prefix",
      fetch: async () => {
        const response = Response.json({ destination: true });
        Object.defineProperties(response, {
          redirected: { value: true },
          url: {
            value: "https://todou.example/prefix/api/projects/beta/issues/9",
          },
        });
        return response;
      },
    });
    const client = new TodouClient({
      delegate: async ({ method, path, query }) => {
        try {
          return await networkClient.request(method, path, { query });
        } catch (error) {
          throw deserializeClientError(
            structuredClone(serializeClientError(error)),
          );
        }
      },
    });
    const error = await client
      .getIssue("alpha", 1, { metadata: "*" })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(MovedError);
    expect(error).toMatchObject({
      path: "/projects/alpha/issues/1?metadata=*",
      movedTo: { slug: "beta", number: 9 },
    });
    const raw = await networkClient.requestRaw(
      "GET",
      "/projects/alpha/issues/1",
    );
    expect(raw.redirected).toBe(true);
    expect(raw.url).toBe(
      "https://todou.example/prefix/api/projects/beta/issues/9",
    );
    expect(await raw.json()).toEqual({ destination: true });
  });

  it("retains direct canonical-slug hints without inventing batch hints", async () => {
    const hints = vi.fn();
    const client = new TodouClient({
      batch: true,
      onCanonicalSlug: hints,
      fetch: async (url) =>
        String(url).endsWith("/batch")
          ? Response.json({
              responses: [{ status: 204 }, { status: 200, body: [] }],
            })
          : Response.json(
              {},
              { headers: { "x-todou-canonical-slug": "beta" } },
            ),
    });
    await client.withContext({}).getProject("alpha");
    expect(hints).toHaveBeenCalledWith("beta", "alpha");
    await expect(
      Promise.all([client.getProject("alpha"), client.listProjects()]),
    ).resolves.toEqual([undefined, []]);
    expect(hints).toHaveBeenCalledTimes(1);
  });

  it("notifies writes once with context and parsed data, never the physical batch POST", async () => {
    const transport = network();
    const events: MutationLifecycleEvent[] = [];
    const client = new TodouClient({
      ...transport,
      batch: true,
      onMutation: (event) => {
        events.push(event);
      },
    });
    await client
      .withContext({ operationId: "write-one" })
      .request("PATCH", "/me", { json: { name: "alice" } });
    const form = new FormData();
    form.set("file", "payload");
    await client.requestRaw("POST", "/upload", { form });
    await Promise.all([client.me(), client.listProjects()]);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      method: "PATCH",
      path: "/me",
      phase: "success",
      data: { url: "/api/me" },
      context: { operationId: "write-one" },
      body: { name: "alice" },
    });
    expect(events[1]).toMatchObject({
      method: "POST",
      path: "/upload",
      phase: "success",
    });
    expect(events[1]?.body).toBe(form);
  });

  it("awaits mutation completion without replacing the original success or error", async () => {
    const gate = deferred<void>();
    const events: MutationLifecycleEvent[] = [];
    let finished = false;
    let fail = false;
    const client = new TodouClient({
      fetch: async () =>
        fail
          ? Response.json(
              { error: { code: "denied", message: "denied" } },
              { status: 403 },
            )
          : Response.json({ ok: true }),
      onMutation: async (event) => {
        events.push(event);
        await gate.promise;
        throw new Error("hook failed");
      },
    });
    const pending = client.request("POST", "/write").then((result) => {
      finished = true;
      return result;
    });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(finished).toBe(false);
    gate.resolve();
    await expect(pending).resolves.toEqual({ ok: true });
    fail = true;
    await expect(client.request("POST", "/write")).rejects.toMatchObject({
      status: 403,
      code: "denied",
    });
    expect(events).toHaveLength(2);
    expect(events[1]?.phase).toBe("error");
  });
});

describe("explicit RPC error serialization", () => {
  const path = "/projects/alpha/issues?limit=2";
  const cases: Error[] = [
    new TodouError(403, "forbidden", "cannot read", { role: "none" }, path),
    new MovedError({ slug: "beta", number: 2, comment_id: 8 }, path),
    new GoneError({ moved: true, title: "Moved issue" }, path),
    new TodouNetworkError(new TypeError("connection reset"), path),
    new DOMException("cancelled", "AbortError"),
    new DOMException("deadline exceeded", "TimeoutError"),
    Object.assign(new Error("bad protocol"), {
      kind: "protocol",
      code: "invalid_message",
    }),
    Object.assign(new Error("identity changed"), {
      kind: "session-reset",
      name: "SessionResetError",
    }),
    Object.assign(new Error("spec failed"), { name: "SpecReadError" }),
  ];

  it.each(cases)(
    "round-trips $name: $message through structured clone",
    (original) => {
      const envelope: ErrorEnvelope = serializeClientError(original);
      const copy: ClientErrorEnvelope = structuredClone(envelope);
      const error = deserializeClientError(copy);
      expect(error).toBeInstanceOf(original.constructor);
      expect(error.message).toBe(original.message);
      expect(error.name).toBe(original.name);
      expect(copy).not.toHaveProperty("stack");
      if (original instanceof TodouError) {
        expect(error).toMatchObject({
          status: original.status,
          code: original.code,
          path,
          details: original.details,
        });
      }
      if (original instanceof MovedError)
        expect(error).toMatchObject({ movedTo: original.movedTo });
      if (original instanceof GoneError)
        expect(error).toMatchObject({ body: original.body });
      if (original instanceof TodouNetworkError)
        expect(error).toMatchObject({
          path,
          cause: { name: "TypeError", message: "connection reset" },
        });
      if ("kind" in original)
        expect(error).toHaveProperty("kind", original.kind);
    },
  );
});
