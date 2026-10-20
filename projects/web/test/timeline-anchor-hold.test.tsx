import { act, fireEvent, waitFor } from "@testing-library/react";
import type { TimelineComment, TimelinePage } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Timeline } from "../src/components/timeline/timeline.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

/**
 * A `#comment-` landing stays put while the card goes on loading (T-520).
 * happy-dom lays nothing out, so what is observable is that a resize of the
 * page asks for the target to be revealed again; how far the page would have
 * drifted without it is measured in a browser.
 */

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  fire() {
    // The real one never fires past disconnect().
    if (this.disconnected) return;
    this.callback([], this as unknown as ResizeObserver);
  }
}

const author = {
  id: 1,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const comment = (id: number): TimelineComment => ({
  type: "comment",
  id,
  author,
  body: `body ${id}`,
  component: null,
  created_at: "2026-09-08T10:00:00Z",
  edited_at: null,
  resolved_at: null,
  hidden_at: null,
  agent_context: null,
});

function stubFetch() {
  const page: TimelinePage = {
    items: [comment(101), comment(102), comment(103)],
    prev_cursor: null,
    next_cursor: "c1",
    total_count: 3,
  };
  vi.stubGlobal("fetch", (async (input: unknown) => {
    const url = String(input);
    const reply = url.includes("/timeline")
      ? page
      : url.includes("/references/config")
        ? { format: { prefix: "T", history: [] }, autolinks: [] }
        : url.includes("/reference-directory")
          ? { entries: [], contested: [], slug_entries: [] }
          : [];
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeResizeObserver.instances = [];
});

/** The landing on `#comment-102`, and every reveal of it from then on. */
async function land() {
  stubFetch();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  const reveals: Element[] = [];
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (
    this: Element,
  ) {
    if (this.id === "comment-102") reveals.push(this);
  });
  const view = renderWithProviders(
    <Timeline
      slug="p"
      issueNumber={7}
      pendingComments={[]}
      viewer={{ id: 1, isAdmin: false, role: "writer" }}
    />,
    testQueryClient(),
    { initialEntry: "/#comment-102" },
  );
  await waitFor(() => expect(reveals.length).toBe(1));
  const page = FakeResizeObserver.instances.find((o) =>
    o.observed.includes(document.body),
  );
  return { view, reveals, page };
}

describe("a #comment- landing on a card still loading (T-520)", () => {
  it("lands again each time the page above it grows", async () => {
    const { reveals, page } = await land();
    expect(page).toBeDefined();
    page?.fire();
    page?.fire();
    expect(reveals.length).toBe(3);
  });

  it.each([
    ["wheel", () => fireEvent.wheel(window)],
    ["touchstart", () => fireEvent.touchStart(window)],
    ["pointerdown", () => fireEvent.pointerDown(window)],
    ["keydown", () => fireEvent.keyDown(window, { key: "ArrowDown" })],
  ])("hands the viewport back at the first %s", async (_, input) => {
    const { reveals, page } = await land();
    input();
    expect(page?.disconnected).toBe(true);
    page?.fire();
    expect(reveals.length).toBe(1);
  });

  it("lets go when the hash leaves the comment", async () => {
    const { view, page } = await land();
    await act(() => view.router.navigate({ to: "/", hash: "" }));
    expect(page?.disconnected).toBe(true);
  });

  it("lets go when the timeline unmounts", async () => {
    const { view, page } = await land();
    view.unmount();
    expect(page?.disconnected).toBe(true);
  });
});
