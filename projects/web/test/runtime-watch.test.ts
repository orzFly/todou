import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../src/api/runtime/deferred.ts";
import { defineProjection } from "../src/api/runtime/projections.ts";
import { resource } from "../src/api/runtime/resources.ts";
import { ResourceRuntime } from "../src/api/runtime/runtime.ts";
import { RuntimeSessionHost } from "../src/api/runtime/session.ts";
import { RuntimeWatch, watchTargets } from "../src/api/runtime/watch.ts";
import { hello, identity, issueProjection, settle } from "./runtime-harness.ts";

const disposals: (() => void)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.useRealTimers();
});

function watchHarness(visible = true) {
  const network = vi.fn(async () => ({ title: "server" }));
  const runtime = new ResourceRuntime({ network });
  const frame = vi.fn();
  const fetcher = vi.fn(
    (_input: RequestInfo | URL, _init?: RequestInit) =>
      deferred<Response>().promise,
  );
  const watch = new RuntimeWatch({
    runtime,
    url: "/api/events",
    fetch: fetcher,
    random: () => 0.5,
    onFrame: frame,
  });
  disposals.push(
    () => watch.dispose(),
    () => runtime.dispose(),
  );
  watch.setDemand({ connected: true, visible, epoch: 1 });
  return { network, runtime, frame, fetcher, watch };
}

const change = (number = 1) =>
  JSON.stringify({
    project: "example",
    entity: "issue",
    action: "updated",
    id: number,
    issue_number: number,
  });

describe("worker watch", () => {
  it("coalesces a burst and ignores unrelated issue content", async () => {
    const { runtime, network, watch } = watchHarness();
    const unsubscribe = runtime.subscribe(
      "page:issue",
      issueProjection,
      { enabled: true, visible: true },
      () => {},
    );
    disposals.push(unsubscribe);
    await settle();
    network.mockClear();
    watch.accept("hello", "{}");
    watch.accept("change", change(42));
    await vi.advanceTimersByTimeAsync(300);
    expect(network).not.toHaveBeenCalled();
    watch.accept("change", change());
    watch.accept("change", change());
    await vi.advanceTimersByTimeAsync(299);
    expect(network).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("marks hidden content dirty without fetching, then validates on visible demand", async () => {
    const { runtime, network, watch } = watchHarness(false);
    await runtime.readProjection(issueProjection);
    runtime.subscribe(
      "hidden",
      issueProjection,
      { enabled: true, visible: false },
      () => {},
    );
    network.mockClear();
    watch.accept("change", change());
    await vi.advanceTimersByTimeAsync(300);
    expect(network).not.toHaveBeenCalled();
    runtime.subscribe(
      "hidden",
      issueProjection,
      { enabled: true, visible: true },
      () => {},
    );
    await settle();
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("applies me-origin invalidation globally but filters the duplicate page frame", async () => {
    const { runtime, watch } = watchHarness();
    const host = new RuntimeSessionHost({
      runtime,
      onlineIdentity: async () => identity(),
      apiMount: "/api",
      pageOrigin: "https://todou.example",
    });
    disposals.push(() => host.dispose());
    const a = await hello(host, "writer");
    const b = await hello(host, "reader");
    a.send("AUTH_BOOTSTRAP");
    b.send("AUTH_BOOTSTRAP");
    await settle();
    const invalidation = vi.spyOn(runtime, "invalidate");
    const observed = vi.fn();
    const ownWatch = new RuntimeWatch({
      runtime,
      url: "/api/events",
      fetch: () => deferred<Response>().promise,
      onFrame: (frame) => {
        observed(frame);
        host.frame(frame);
      },
    });
    disposals.push(() => ownWatch.dispose());
    ownWatch.setDemand({ connected: true, visible: true, epoch: 0 });
    ownWatch.accept("me", JSON.stringify({ kind: "prefs", origin: "writer" }));
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(invalidation).toHaveBeenCalled();
    expect(observed).toHaveBeenCalled();
    expect(a.page.received.some((message) => message.type === "FRAME")).toBe(
      false,
    );
    expect(b.page.received.some((message) => message.type === "FRAME")).toBe(
      true,
    );
    watch.dispose();
  });

  it("preserves inbox content-only dirty semantics and metadata equality", async () => {
    const { runtime } = watchHarness();
    const metadata = defineProjection({
      kind: "direct",
      version: 1,
      queryKey: ["issue-metadata", "example", 1],
      queryHash: "metadata",
      resources: [
        resource("network-only", "/projects/example/issues/1/metadata"),
      ],
    });
    runtime.subscribe(
      "metadata",
      metadata,
      { enabled: false, visible: true },
      () => {},
    );
    const targets = watchTargets(runtime, [
      { key: ["unrelated"], scope: { inboxRows: [] } },
    ]);
    expect(targets).toEqual({ dirty: [], refresh: [] });
    expect(
      watchTargets(runtime, [
        { key: ["issue-metadata", "example", 1], scope: { metadataRows: [] } },
      ]),
    ).toEqual({ dirty: [], refresh: [] });
  });

  it("decodes split frames, ignores malformed data, aborts stalls, and compensates after reconnect", async () => {
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const runtime = new ResourceRuntime({ network: async () => ({}) });
    const onFrame = vi.fn();
    const watch = new RuntimeWatch({
      runtime,
      url: "/api/events",
      fetch: fetcher,
      random: () => 0.5,
      onFrame,
    });
    disposals.push(
      () => watch.dispose(),
      () => runtime.dispose(),
    );
    watch.setDemand({ connected: true, visible: true, epoch: 1 });
    await settle();
    const encoder = new TextEncoder();
    stream!.enqueue(
      encoder.encode(
        "event: hello\ndata: {}\n\nevent: change\ndata: {broken}\n\nevent: change\ndata: ",
      ),
    );
    stream!.enqueue(encoder.encode(change() + "\n"));
    await settle();
    await vi.advanceTimersByTimeAsync(300);
    expect(onFrame).not.toHaveBeenCalled();
    stream!.enqueue(encoder.encode("\n"));
    await settle();
    await vi.advanceTimersByTimeAsync(300);
    expect(onFrame).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(90_000);
    const signal = fetcher.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    stream!.enqueue(encoder.encode("event: hello\ndata: {}\n\n"));
    await settle();
    await vi.advanceTimersByTimeAsync(300);
    expect(
      onFrame.mock.calls.some(([frame]) => frame.eventType === "reconnect"),
    ).toBe(true);
  });

  it("stops and aborts the stream when the final authorized port disappears", () => {
    const { fetcher, watch } = watchHarness();
    watch.setDemand({ connected: false, visible: false, epoch: 1 });
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
