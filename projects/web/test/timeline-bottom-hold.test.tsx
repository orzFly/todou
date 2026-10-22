import { act, fireEvent, waitFor } from "@testing-library/react";
import type { TimelineComment, TimelinePage } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Timeline } from "../src/components/timeline/timeline.tsx";
import { FakeResizeObserver, resizePage } from "./fake-resize-observer.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";

/**
 * Every landing on the end of the timeline stays there while the card goes on
 * loading (T-527): opening the card, following a new item, and New messages.
 * happy-dom lays nothing out, so what is observable is that a resize of the
 * page asks for the end again; how far the page would have drifted without it
 * is measured in a browser.
 */

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

const HEIGHT = 10_000;
const VIEWPORT = 800;

/**
 * The card's timeline, with a page geometry to scroll in. `bottoms` counts the
 * scrolls to the end of the document; `readerAt` is the reader's own scroll,
 * gesture first, the way a browser delivers it.
 */
async function open(hash = "") {
  const items = [comment(101), comment(102), comment(103)];
  vi.stubGlobal("fetch", (async (input: unknown) => {
    const url = String(input);
    const page: TimelinePage = {
      items: [...items],
      prev_cursor: null,
      next_cursor: "c1",
      total_count: items.length,
    };
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
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  const state = { y: 0 };
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(VIEWPORT);
  vi.spyOn(window, "scrollY", "get").mockImplementation(() => state.y);
  vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(
    HEIGHT,
  );
  let bottoms = 0;
  vi.spyOn(window, "scrollTo").mockImplementation((...args: unknown[]) => {
    if (args[1] === HEIGHT) {
      bottoms += 1;
      state.y = HEIGHT - VIEWPORT;
    }
  });
  const reveals: string[] = [];
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (
    this: Element,
  ) {
    reveals.push(this.id);
  });
  const client = testQueryClient();
  const view = renderWithProviders(
    <Timeline
      slug="p"
      issueNumber={7}
      pendingComments={[]}
      viewer={{ id: 1, isAdmin: false, role: "writer" }}
    />,
    client,
    { initialEntry: `/${hash}` },
  );
  await view.findByText("body 103");
  const arrive = async (id: number) => {
    items.push(comment(id));
    await act(() =>
      client.refetchQueries({ queryKey: ["timeline", "p", 7, "tail"] }),
    );
    await view.findByText(`body ${id}`);
  };
  return {
    view,
    arrive,
    reveals,
    bottoms: () => bottoms,
    /** Where a reveal put the viewport, which is no gesture of the reader's. */
    revealedAt: (y: number) => {
      state.y = y;
      fireEvent.scroll(window);
    },
    readerAt: (y: number) => {
      fireEvent.wheel(window);
      state.y = y;
      fireEvent.scroll(window);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeResizeObserver.instances = [];
});

describe("landings on the end of the timeline (T-527)", () => {
  it("opening the card lands on the end again each time the page grows", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    resizePage();
    resizePage();
    expect(page.bottoms()).toBe(3);
  });

  it.each([
    ["wheel", () => fireEvent.wheel(window)],
    ["touchstart", () => fireEvent.touchStart(window)],
    ["pointerdown", () => fireEvent.pointerDown(window)],
    ["keydown", () => fireEvent.keyDown(window, { key: "ArrowUp" })],
  ])("hands the viewport back at the first %s", async (_, input) => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    input();
    resizePage();
    expect(page.bottoms()).toBe(1);
  });

  it("a reader who scrolled up is not pulled back as the page grows", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(2_000);
    resizePage();
    await page.arrive(104);
    resizePage();
    expect(page.bottoms()).toBe(1);
    expect(
      page.view.getByRole("button", { name: "New messages" }),
    ).toBeTruthy();
  });

  it("following a new item at the end holds the end too", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    // Still at the end, but no longer under the opening's hold.
    page.readerAt(HEIGHT - VIEWPORT);
    await page.arrive(104);
    await waitFor(() => expect(page.bottoms()).toBe(2));
    resizePage();
    expect(page.bottoms()).toBe(3);
  });

  it("New messages holds the end it jumps to", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(0);
    await page.arrive(104);
    const button = page.view.getByRole("button", { name: "New messages" });
    fireEvent.pointerDown(button);
    fireEvent.click(button);
    expect(page.bottoms()).toBe(2);
    resizePage();
    expect(page.bottoms()).toBe(3);
  });

  it("lets go when the timeline unmounts", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.view.unmount();
    resizePage();
    expect(page.bottoms()).toBe(1);
  });

  it("a held #comment- landing is not traded for the end when an item arrives", async () => {
    const page = await open("#comment-102");
    await waitFor(() => expect(page.reveals).toContain("comment-102"));
    // The anchor sits within a screen of the end: follow-bottom's own test.
    page.revealedAt(HEIGHT - VIEWPORT - 300);
    await page.arrive(104);
    resizePage();
    expect(page.bottoms()).toBe(0);
    expect(page.reveals.at(-1)).toBe("comment-102");
  });
});
