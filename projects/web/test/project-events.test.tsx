import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INVALIDATE_COALESCE_MS,
  invalidationsFor,
  pageContainsIssue,
  RECONNECT_BASE_MS,
  reconnectInvalidations,
  STALL_TIMEOUT_MS,
  useProjectEvents,
} from "../src/api/useProjectEvents.ts";

describe("invalidationsFor (SSE → invalidation descriptors)", () => {
  it("maps issue events to broad refetches (status may move columns)", () => {
    expect(
      invalidationsFor(
        { entity: "issue", id: 1, action: "updated", issue_number: 42 },
        "todou",
      ),
    ).toEqual([
      { key: ["issues", "todou"], scope: "refetch" },
      { key: ["issue", "todou", 42], scope: "refetch" },
      { key: ["timeline", "todou", 42], scope: "refetch" },
    ]);
  });

  it("scopes timeline events' list refetch to pages containing the issue", () => {
    expect(
      invalidationsFor(
        { entity: "timeline", id: 5, action: "created", issue_number: 7 },
        "todou",
      ),
    ).toEqual([
      { key: ["timeline", "todou", 7], scope: "refetch" },
      { key: ["questions", "todou", 7], scope: "refetch" },
      // Unread markers (T-46) ride the list payload, but a comment cannot
      // move an issue between pages — containment is enough.
      { key: ["issues", "todou"], scope: { contains: 7 } },
    ]);
  });

  it("maps config entities to their lists plus issues", () => {
    expect(
      invalidationsFor({ entity: "status", id: 1, action: "updated" }, "p"),
    ).toEqual([
      { key: ["statuses", "p"], scope: "refetch" },
      { key: ["issues", "p"], scope: "refetch" },
    ]);
    expect(
      invalidationsFor({ entity: "member", id: 1, action: "deleted" }, "p"),
    ).toEqual([{ key: ["members", "p"], scope: "refetch" }]);
  });

  it("covers reconnect compensation broadly", () => {
    expect(reconnectInvalidations("p").length).toBeGreaterThanOrEqual(6);
  });
});

describe("pageContainsIssue", () => {
  it("finds the row in a list page", () => {
    expect(pageContainsIssue({ items: [{ number: 7 }] }, 7)).toBe(true);
  });

  it("misses pages without the row", () => {
    expect(pageContainsIssue({ items: [{ number: 8 }] }, 7)).toBe(false);
  });

  it("rejects the counts shape (no items)", () => {
    expect(pageContainsIssue({ open: 3, closed: 4 }, 7)).toBe(false);
  });

  it("tolerates empty caches", () => {
    expect(pageContainsIssue(undefined, 7)).toBe(false);
  });
});

type Listener = (e: MessageEvent) => void;

class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: MockEventSource[] = [];
  url: string;
  readyState = MockEventSource.CONNECTING;
  listeners = new Map<string, Listener[]>();
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: string, data: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent);
    }
  }

  close() {
    this.closed = true;
    this.readyState = MockEventSource.CLOSED;
  }
}

describe("useProjectEvents", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    MockEventSource.instances = [];
  });

  function setup() {
    vi.stubGlobal("EventSource", MockEventSource);
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const hook = renderHook(() => useProjectEvents("todou"), { wrapper });
    return { spy, hook };
  }

  it("subscribes to the project feed and invalidates on change events", async () => {
    const { spy } = setup();
    const source = MockEventSource.instances[0];
    expect(source?.url).toBe("/api/projects/todou/events");

    source?.emit("change", {
      entity: "timeline",
      id: 9,
      action: "created",
      issue_number: 3,
    });
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ queryKey: ["timeline", "todou", 3] }),
    );
  });

  it("ignores malformed payloads", () => {
    const { spy } = setup();
    const source = MockEventSource.instances[0];
    for (const listener of source?.listeners.get("change") ?? []) {
      listener({ data: "not json" } as MessageEvent);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("coalesces an event burst into one flush without duplicates", () => {
    vi.useFakeTimers();
    const { spy } = setup();
    const source = MockEventSource.instances[0];
    const event = {
      entity: "timeline",
      id: 9,
      action: "created",
      issue_number: 3,
    };
    source?.emit("change", event);
    source?.emit("change", { ...event, id: 10 });
    expect(spy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(INVALIDATE_COALESCE_MS);
    const timelineCalls = spy.mock.calls.filter(
      (call) =>
        JSON.stringify(call[0]?.queryKey) ===
        JSON.stringify(["timeline", "todou", 3]),
    );
    expect(timelineCalls).toHaveLength(1);
  });

  it("lets a broad issues refetch subsume a contains-scope in the same window", () => {
    vi.useFakeTimers();
    const { spy } = setup();
    const source = MockEventSource.instances[0];
    source?.emit("change", {
      entity: "timeline",
      id: 9,
      action: "created",
      issue_number: 3,
    });
    source?.emit("change", {
      entity: "issue",
      id: 3,
      action: "updated",
      issue_number: 3,
    });

    vi.advanceTimersByTime(INVALIDATE_COALESCE_MS);
    const issuesCalls = spy.mock.calls.filter(
      (call) =>
        JSON.stringify(call[0]?.queryKey) ===
        JSON.stringify(["issues", "todou"]),
    );
    // One broad refetch; no stale-mark/predicate pair from the contains path.
    expect(issuesCalls).toHaveLength(1);
    expect(issuesCalls[0]?.[0]).toEqual({ queryKey: ["issues", "todou"] });
  });

  it("compensates with broad invalidation after a reconnect", async () => {
    const { spy } = setup();
    const source = MockEventSource.instances[0];
    source?.onerror?.();
    source?.onopen?.();
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ queryKey: ["issues", "todou"] }),
    );
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(6);
  });

  it("closes the stream on unmount", () => {
    const { hook } = setup();
    hook.unmount();
    expect(MockEventSource.instances[0]?.closed).toBe(true);
  });

  it("rebuilds the stream after EventSource gives up permanently", () => {
    vi.useFakeTimers();
    const { spy } = setup();
    const first = MockEventSource.instances[0] as MockEventSource;

    // A reconnect attempt answered with a non-200 (proxy 502 during a server
    // restart) leaves the browser at CLOSED with no further retries.
    first.readyState = MockEventSource.CLOSED;
    first.onerror?.();
    expect(MockEventSource.instances).toHaveLength(1);

    vi.advanceTimersByTime(RECONNECT_BASE_MS);
    expect(MockEventSource.instances).toHaveLength(2);

    const second = MockEventSource.instances[1] as MockEventSource;
    second.readyState = MockEventSource.OPEN;
    second.onopen?.();
    expect(spy).toHaveBeenCalledWith({ queryKey: ["issues", "todou"] });
  });

  it("keeps backing off while reconnect attempts keep failing", () => {
    vi.useFakeTimers();
    setup();

    for (let i = 0; i < 3; i++) {
      const current = MockEventSource.instances.at(-1) as MockEventSource;
      current.readyState = MockEventSource.CLOSED;
      current.onerror?.();
      vi.advanceTimersByTime(RECONNECT_BASE_MS * 2 ** i);
      expect(MockEventSource.instances).toHaveLength(i + 2);
    }
  });

  it("force-reconnects a silently dead stream after missed heartbeats", () => {
    vi.useFakeTimers();
    const { spy } = setup();
    const first = MockEventSource.instances[0] as MockEventSource;
    first.readyState = MockEventSource.OPEN;
    first.onopen?.();

    // Heartbeats keep the watchdog fed…
    vi.advanceTimersByTime(STALL_TIMEOUT_MS - 1_000);
    first.emit("ping", {});
    vi.advanceTimersByTime(STALL_TIMEOUT_MS - 1_000);
    expect(MockEventSource.instances).toHaveLength(1);

    // …until the stream goes silent past the stall window (dev proxy holds
    // the connection open after the upstream died, so no error ever fires).
    vi.advanceTimersByTime(STALL_TIMEOUT_MS + RECONNECT_BASE_MS);
    expect(first.closed).toBe(true);
    expect(MockEventSource.instances).toHaveLength(2);

    const second = MockEventSource.instances[1] as MockEventSource;
    second.readyState = MockEventSource.OPEN;
    second.onopen?.();
    expect(spy).toHaveBeenCalledWith({ queryKey: ["issues", "todou"] });
  });
});
