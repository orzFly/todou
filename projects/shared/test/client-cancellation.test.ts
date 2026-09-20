import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TodouClient, TodouNetworkError } from "../src/client.ts";

type Call = {
  url: string;
  signal: AbortSignal;
  respond: (response: Response) => void;
};

// ES2023 does not yet expose Promise.withResolvers.
function pendingFetch() {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = (url, init) => {
    const signal = init?.signal;
    if (!signal) throw new Error("fetch was not given its abort signal");
    return new Promise<Response>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      calls.push({
        url: String(url),
        signal,
        respond: (response) => {
          signal.removeEventListener("abort", abort);
          resolve(response);
        },
      });
      if (signal.aborted) abort();
    });
  };
  return { fetch, calls };
}

function streamingFetch() {
  const calls: Array<{ url: string; signal: AbortSignal }> = [];
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const signal = init?.signal;
    if (!signal) throw new Error("missing abort signal");
    calls.push({ url: String(url), signal });
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        source = controller;
      },
      cancel,
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    });
  };
  const item = (index: number, body: unknown, status = 200) => {
    source.enqueue(
      new TextEncoder().encode(
        `event: item\ndata: ${JSON.stringify({ index, status, body })}\n\n`,
      ),
    );
  };
  return { fetch, calls, cancel, item };
}

describe("TodouClient cancellation and bounded exchanges", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["direct", "batch", "delegate", "raw"] as const)(
    "does not send a pre-aborted %s request",
    async (channel) => {
      const transport = pendingFetch();
      const delegate = vi.fn(async () => ({}));
      const client = new TodouClient({
        fetch: transport.fetch,
        batch: channel === "batch",
        delegate: channel === "delegate" ? delegate : undefined,
      });
      const controller = new AbortController();
      controller.abort();
      const view = client.withContext({ signal: controller.signal });
      const pending =
        channel === "raw" ? view.requestRaw("GET", "/me") : view.me();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(0);
      expect(transport.calls).toHaveLength(0);
      expect(delegate).not.toHaveBeenCalled();
    },
  );

  it("cancels direct requests with either context or per-call signal", async () => {
    const transport = pendingFetch();
    const client = new TodouClient({ fetch: transport.fetch });
    const contextAbort = new AbortController();
    const callAbort = new AbortController();
    const pending = client
      .withContext({ signal: contextAbort.signal })
      .request("GET", "/me", { signal: callAbort.signal });
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    callAbort.abort();
    await rejected;
    expect(transport.calls[0]?.signal.aborted).toBe(true);
    expect(contextAbort.signal.aborted).toBe(false);

    const next = client
      .withContext({ signal: contextAbort.signal })
      .requestRaw("GET", "/me");
    const nextRejected = expect(next).rejects.toMatchObject({
      name: "AbortError",
    });
    contextAbort.abort();
    await nextRejected;
    expect(transport.calls[1]?.signal.aborted).toBe(true);
  });

  it("keeps raw response cancellation connected after returning headers", async () => {
    const controller = new AbortController();
    let signal: AbortSignal | null | undefined;
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const client = new TodouClient({
      fetch: async (_url, init) => {
        signal = init?.signal;
        const stream = new ReadableStream<Uint8Array>({
          start: (value) => {
            source = value;
          },
        });
        signal?.addEventListener("abort", () => source.error(signal?.reason), {
          once: true,
        });
        return new Response(stream);
      },
    });
    const response = await client.requestRaw("GET", "/download", {
      signal: controller.signal,
    });
    const pending = response.text();
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await rejected;
    expect(signal?.aborted).toBe(true);
  });

  it("cancels during JSON body consumption without reclassifying AbortError", async () => {
    const controller = new AbortController();
    let signal: AbortSignal | null | undefined;
    const response = new Response(new ReadableStream<Uint8Array>());
    const client = new TodouClient({
      fetch: async (_url, init) => {
        signal = init?.signal;
        return response;
      },
    });
    const pending = client.withContext({ signal: controller.signal }).me();
    const errorPromise = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    const error = await errorPromise;
    expect(error).toMatchObject({ name: "AbortError" });
    expect(error).not.toBeInstanceOf(TodouNetworkError);
    expect(signal?.aborted).toBe(true);
  });

  it("removes a cancelled queued item and sends the remaining item directly", async () => {
    const transport = pendingFetch();
    const client = new TodouClient({ fetch: transport.fetch, batch: true });
    const controller = new AbortController();
    const cancelled = client.withContext({ signal: controller.signal }).me();
    const rejected = expect(cancelled).rejects.toMatchObject({
      name: "AbortError",
    });
    const live = client.listProjects();
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.calls.map(({ url }) => url)).toEqual(["/api/projects"]);
    transport.calls[0]?.respond(Response.json([]));
    await expect(live).resolves.toEqual([]);
  });

  it("does not dispatch an entirely cancelled queue", async () => {
    const transport = pendingFetch();
    const client = new TodouClient({ fetch: transport.fetch, batch: true });
    const controller = new AbortController();
    const done = Promise.allSettled([
      client.withContext({ signal: controller.signal }).me(),
      client.withContext({ signal: controller.signal }).listProjects(),
    ]);
    controller.abort();
    await done;
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.calls).toEqual([]);
  });

  it("cancels one flushed waiter without aborting its batch neighbour", async () => {
    const transport = pendingFetch();
    const client = new TodouClient({ fetch: transport.fetch, batch: true });
    const controller = new AbortController();
    const cancelled = client.withContext({ signal: controller.signal }).me();
    const rejected = expect(cancelled).rejects.toMatchObject({
      name: "AbortError",
    });
    const live = client.listProjects();
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejected;
    expect(transport.calls[0]?.signal.aborted).toBe(false);
    transport.calls[0]?.respond(
      Response.json({
        responses: [
          { status: 200, body: { ignored: true } },
          { status: 200, body: ["live"] },
        ],
      }),
    );
    await expect(live).resolves.toEqual(["live"]);
  });

  it("aborts the physical fetch only after all flushed waiters cancel", async () => {
    const transport = pendingFetch();
    const client = new TodouClient({ fetch: transport.fetch, batch: true });
    const one = new AbortController();
    const two = new AbortController();
    const done = Promise.allSettled([
      client.withContext({ signal: one.signal }).me(),
      client.withContext({ signal: two.signal }).listProjects(),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    one.abort();
    expect(transport.calls[0]?.signal.aborted).toBe(false);
    two.abort();
    expect(transport.calls[0]?.signal.aborted).toBe(true);
    const results = await done;
    expect(results.every((result) => result.status === "rejected")).toBe(true);
  });

  it("ignores late or duplicate frames and releases a stream when the last waiter cancels", async () => {
    const transport = streamingFetch();
    const client = new TodouClient({ fetch: transport.fetch, batch: true });
    const cancelFirst = new AbortController();
    const cancelLast = new AbortController();
    const first = client.withContext({ signal: cancelFirst.signal }).me();
    const firstRejected = expect(first).rejects.toMatchObject({
      name: "AbortError",
    });
    const second = client.listProjects();
    const last = client.withContext({ signal: cancelLast.signal }).version();
    const lastRejected = expect(last).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(0);
    cancelFirst.abort();
    await firstRejected;
    transport.item(0, { ignored: true });
    transport.item(1, ["first-result"]);
    transport.item(1, ["duplicate"]);
    transport.item(999, "out of range");
    await expect(second).resolves.toEqual(["first-result"]);
    expect(transport.calls[0]?.signal.aborted).toBe(false);
    cancelLast.abort();
    await lastRejected;
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.calls[0]?.signal.aborted).toBe(true);
    expect(transport.cancel).toHaveBeenCalledTimes(1);
  });

  it("skips cancelled items in later 50-item chunks", async () => {
    const transport = pendingFetch();
    const client = new TodouClient({ fetch: transport.fetch, batch: true });
    const controller = new AbortController();
    const firstChunk = Array.from({ length: 50 }, (_, n) =>
      client.request("GET", `/items/${n}`),
    );
    const later = client
      .withContext({ signal: controller.signal })
      .request("GET", "/later");
    const rejected = expect(later).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejected;
    transport.calls[0]?.respond(
      Response.json({
        responses: Array.from({ length: 50 }, () => ({ status: 204 })),
      }),
    );
    await Promise.all(firstChunk);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.calls).toHaveLength(1);
  });

  it("does not revive cancelled items when the batch endpoint falls back to direct fetches", async () => {
    const transport = pendingFetch();
    const client = new TodouClient({ fetch: transport.fetch, batch: true });
    const controller = new AbortController();
    const cancelled = client.withContext({ signal: controller.signal }).me();
    const rejected = expect(cancelled).rejects.toMatchObject({
      name: "AbortError",
    });
    const live = client.listProjects();
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejected;
    transport.calls[0]?.respond(
      Response.json({ error: { code: "unknown" } }, { status: 404 }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.calls.map(({ url }) => url)).toEqual([
      "/api/batch",
      "/api/projects",
    ]);
    transport.calls[1]?.respond(Response.json([]));
    await expect(live).resolves.toEqual([]);
  });

  it.each(["direct", "raw", "delegate"] as const)(
    "physically aborts a %s deadline",
    async (channel) => {
      const transport = pendingFetch();
      let delegatedSignal: AbortSignal | undefined;
      const client = new TodouClient({
        fetch: transport.fetch,
        delegate:
          channel === "delegate"
            ? async ({ context }) => {
                delegatedSignal = context.signal;
                return new Promise(() => {});
              }
            : undefined,
      });
      const pending =
        channel === "raw"
          ? client.requestRaw("GET", "/me", { timeoutMs: 20 })
          : client.withContext({ timeoutMs: 20 }).me();
      const rejected = expect(pending).rejects.toMatchObject({
        name: "TimeoutError",
      });
      await vi.advanceTimersByTimeAsync(20);
      await rejected;
      expect((delegatedSignal ?? transport.calls[0]?.signal)?.aborted).toBe(
        true,
      );
    },
  );

  it("bounds JSON body reads as well as response headers", async () => {
    let signal: AbortSignal | null | undefined;
    const client = new TodouClient({
      timeoutMs: 20,
      fetch: async (_url, init) => {
        signal = init?.signal;
        return new Response(new ReadableStream<Uint8Array>());
      },
    });
    const rejected = expect(client.me()).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(signal?.aborted).toBe(true);
  });

  it("bounds raw response bytes without replacing the Response", async () => {
    let signal: AbortSignal | null | undefined;
    let response!: Response;
    const client = new TodouClient({
      fetch: async (_url, init) => {
        signal = init?.signal;
        response = new Response(
          new ReadableStream<Uint8Array>({
            start: (source) =>
              signal?.addEventListener(
                "abort",
                () => source.error(signal?.reason),
                { once: true },
              ),
          }),
        );
        return response;
      },
    });
    const raw = await client.requestRaw("GET", "/download", { timeoutMs: 20 });
    expect(raw).toBe(response);
    const rejected = expect(raw.text()).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(signal?.aborted).toBe(true);
  });

  it("keeps an expired batch item from aborting a longer live item, then enforces the physical deadline", async () => {
    const transport = streamingFetch();
    const client = new TodouClient({
      fetch: transport.fetch,
      batch: true,
      batchTimeoutMs: 40,
    });
    const short = client.withContext({ timeoutMs: 10 }).me();
    const long = client.withContext({ timeoutMs: 100 }).listProjects();
    const shortRejected = expect(short).rejects.toMatchObject({
      name: "TimeoutError",
    });
    const longRejected = expect(long).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(10);
    await shortRejected;
    expect(transport.calls[0]?.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(30);
    await longRejected;
    expect(transport.calls[0]?.signal.aborted).toBe(true);
    expect(transport.cancel).toHaveBeenCalledTimes(1);
  });

  it("physically aborts an entire batch deadline while awaiting headers", async () => {
    const transport = pendingFetch();
    const client = new TodouClient({
      fetch: transport.fetch,
      batch: true,
      timeoutMs: 100,
      batchTimeoutMs: 20,
    });
    const results = Promise.allSettled([client.me(), client.listProjects()]);
    await vi.advanceTimersByTimeAsync(20);
    expect(transport.calls[0]?.signal.aborted).toBe(true);
    for (const result of await results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected")
        expect(result.reason).toMatchObject({ name: "TimeoutError" });
    }
  });

  it("bounds ordinary batched reads at 30 seconds by default", async () => {
    const transport = pendingFetch();
    const client = new TodouClient({ fetch: transport.fetch, batch: true });
    const rejected = expect(client.me()).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(transport.calls[0]?.signal.aborted).toBe(true);
  });

  it("leaves ordinary CLI reads and writes without an unsolicited deadline", async () => {
    const transport = pendingFetch();
    const client = new TodouClient({ fetch: transport.fetch });
    const read = client.me();
    const write = client.request("POST", "/write");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.calls.every(({ signal }) => !signal.aborted)).toBe(true);
    transport.calls[0]?.respond(Response.json({ id: 1 }));
    transport.calls[1]?.respond(new Response(null, { status: 204 }));
    await expect(read).resolves.toEqual({ id: 1 });
    await expect(write).resolves.toBeUndefined();
  });

  it("clears a completed read deadline before it can abort a later operation", async () => {
    const transport = pendingFetch();
    const client = new TodouClient({ fetch: transport.fetch, timeoutMs: 20 });
    const first = client.me();
    transport.calls[0]?.respond(Response.json({ id: 1 }));
    await first;
    await vi.advanceTimersByTimeAsync(20);
    expect(transport.calls[0]?.signal.aborted).toBe(false);
  });

  it("releases an abandoned resource only after its physical batch finishes", async () => {
    const transport = streamingFetch();
    const client = new TodouClient({ fetch: transport.fetch, batch: true });
    const controller = new AbortController();
    const released = vi.fn();
    const first = client
      .withContext({
        signal: controller.signal,
        onTransportSettled: released,
      })
      .me();
    const rejected = expect(first).rejects.toMatchObject({
      name: "AbortError",
    });
    const second = client.listProjects();
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejected;
    expect(released).not.toHaveBeenCalled();
    transport.item(0, "abandoned");
    await vi.advanceTimersByTimeAsync(0);
    expect(released).not.toHaveBeenCalled();
    transport.item(1, []);
    await second;
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toHaveBeenCalledTimes(1);
    expect(transport.calls[0]?.signal.aborted).toBe(true);
  });

  it("releases every physical slot at the batch deadline after logical timeouts", async () => {
    const transport = streamingFetch();
    const released = vi.fn();
    const client = new TodouClient({
      fetch: transport.fetch,
      batch: true,
      batchTimeoutMs: 40,
    });
    const short = client
      .withContext({ timeoutMs: 10, onTransportSettled: released })
      .me();
    const long = client
      .withContext({ timeoutMs: 100, onTransportSettled: released })
      .listProjects();
    const results = Promise.allSettled([short, long]);
    await vi.advanceTimersByTimeAsync(10);
    expect(released).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30);
    await results;
    expect(released).toHaveBeenCalledTimes(2);
    expect(transport.calls[0]?.signal.aborted).toBe(true);
  });

  it("releases a pre-dispatch cancellation exactly once", async () => {
    const transport = pendingFetch();
    const released = vi.fn();
    const controller = new AbortController();
    const client = new TodouClient({ fetch: transport.fetch, batch: true });
    const pending = client
      .withContext({ signal: controller.signal, onTransportSettled: released })
      .me();
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toHaveBeenCalledTimes(1);
    expect(transport.calls).toHaveLength(0);
  });

  it("does not release a physical slot while a custom fetch ignores cancellation", async () => {
    let respond!: (response: Response) => void;
    const released = vi.fn();
    const controller = new AbortController();
    const client = new TodouClient({
      fetch: () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    });
    const pending = client
      .withContext({ signal: controller.signal, onTransportSettled: released })
      .me();
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await rejected;
    expect(released).not.toHaveBeenCalled();
    respond(new Response(null, { status: 204 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("physical completion notification failures cannot replace a request result", async () => {
    const client = new TodouClient({
      fetch: async () => Response.json({ id: 1 }),
    });
    await expect(
      client
        .withContext({
          onTransportSettled: () => {
            throw new Error("notification failed");
          },
        })
        .me(),
    ).resolves.toEqual({ id: 1 });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "rejects an invalid deadline (%s) without fetching",
    async (timeoutMs) => {
      const transport = pendingFetch();
      const client = new TodouClient({ fetch: transport.fetch });
      await expect(
        client.request("GET", "/me", { timeoutMs }),
      ).rejects.toBeInstanceOf(RangeError);
      expect(transport.calls).toHaveLength(0);
    },
  );
});
