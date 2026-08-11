import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invalidationsFor,
  reconnectInvalidations,
  useProjectEvents,
} from "../src/api/useProjectEvents.ts";

describe("invalidationsFor (SSE → query keys)", () => {
  it("maps issue events to list, detail, and timeline", () => {
    expect(
      invalidationsFor(
        { entity: "issue", id: 1, action: "updated", issue_number: 42 },
        "todou",
      ),
    ).toEqual([
      ["issues", "todou"],
      ["issue", "todou", 42],
      ["timeline", "todou", 42],
    ]);
  });

  it("maps timeline events to that issue's timeline only", () => {
    expect(
      invalidationsFor(
        { entity: "timeline", id: 5, action: "created", issue_number: 7 },
        "todou",
      ),
    ).toEqual([["timeline", "todou", 7]]);
  });

  it("maps config entities to their lists plus issues", () => {
    expect(
      invalidationsFor({ entity: "status", id: 1, action: "updated" }, "p"),
    ).toEqual([
      ["statuses", "p"],
      ["issues", "p"],
    ]);
    expect(
      invalidationsFor({ entity: "member", id: 1, action: "deleted" }, "p"),
    ).toEqual([["members", "p"]]);
  });

  it("covers reconnect compensation broadly", () => {
    expect(reconnectInvalidations("p").length).toBeGreaterThanOrEqual(6);
  });
});

type Listener = (e: MessageEvent) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
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
  }
}

describe("useProjectEvents", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
});
