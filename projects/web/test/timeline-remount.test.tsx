import type { QueryClient } from "@tanstack/react-query";
import { fireEvent, waitFor } from "@testing-library/react";
import type {
  TimelineComment,
  TimelineItem,
  TimelinePage,
} from "@todou/shared";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RevealedRunsProvider } from "../src/components/timeline/revealed-runs.tsx";
import { Timeline } from "../src/components/timeline/timeline.tsx";
import { cmCount } from "./cm.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";

/**
 * `Timeline` keyed by card (T-324).
 *
 * The key's job is to stop a row outliving the card it was rendered for: the
 * row keys inside `Timeline` carry no card, so a jump whose destination shares
 * a comment id hands the surviving instance the new card's props, and the
 * mutations it closed over follow them. What the key adds over sealing the
 * mutations is the scope — it also covers `spec-comment-card.tsx` and
 * `questions-card.tsx`, which still read their card from a closure.
 *
 * The reuse needs the destination card's timeline to be **already cached**:
 * `useTimelineTail` is keyed by card and sets no `placeholderData`, so on a
 * cold cache `items` empties for the commit that changes the params and the
 * rows unmount on their own. The warm cache is the ordinary case — a card
 * visited before, or one the SSE feed has already invalidated — and it is the
 * one `CardPage` below seeds. `the same page without the key` is the control
 * proving these assertions measure the key and not the fixture.
 */

const author = {
  id: 1,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const comment = (id: number, body: string): TimelineComment => ({
  type: "comment",
  id,
  author,
  body,
  component: null,
  created_at: "2026-09-08T10:00:00Z",
  edited_at: null,
  resolved_at: null,
  hidden_at: null,
  agent_context: null,
});

const page = (items: TimelineItem[]): TimelinePage => ({
  items,
  prev_cursor: null,
  next_cursor: "c1",
  total_count: items.length,
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** Every reply a mounted timeline and its rows ask for. */
function stubTimelineFetch(): void {
  vi.stubGlobal("fetch", (async (input: unknown) => {
    const url = String(input);
    if (url.includes("/references/config")) {
      return json({ format: { prefix: "T", history: [] }, autolinks: [] });
    }
    if (url.includes("/reference-directory")) {
      return json({ entries: [], contested: [], slug_entries: [] });
    }
    if (url.includes("/timeline")) {
      const card = Number(/issues\/(\d+)\/timeline/.exec(url)?.[1]);
      return json(page([comment(11, `card ${card} body`)]));
    }
    return json([]);
  }) as unknown as typeof fetch);
}

/**
 * A client with **both** cards already cached, which is what lets the rows be
 * reused: `node_modules` aside, this is the only difference between the
 * unkeyed page reusing a row and it not.
 */
function warmBothCards(): QueryClient {
  const client = testQueryClient();
  for (const card of [7, 8]) {
    client.setQueryData(["timeline", "p", card, "tail"], {
      pages: [page([comment(11, `card ${card} body`)])],
      pageParams: [{ dir: "init" }],
    });
  }
  return client;
}

afterEach(() => vi.unstubAllGlobals());

/** The page as `issue-detail.tsx` builds it: the provider above a keyed Timeline. */
function CardPage({ keyed }: { keyed: boolean }) {
  const [number, setNumber] = useState(7);
  return (
    <>
      <button type="button" onClick={() => setNumber(8)}>
        the next card
      </button>
      <RevealedRunsProvider>
        <Timeline
          {...(keyed ? { key: `p/${number}` } : {})}
          slug="p"
          issueNumber={number}
          pendingComments={[]}
          viewer={{ id: 1, isAdmin: false, role: "writer" }}
        />
      </RevealedRunsProvider>
    </>
  );
}

describe("a timeline keyed by card", () => {
  it("does not hand the next card's props to the row it left behind", async () => {
    stubTimelineFetch();
    const view = renderWithProviders(<CardPage keyed />, warmBothCards());

    fireEvent.click(await view.findByLabelText("edit comment"));
    await waitFor(() => expect(cmCount(view.container)).toBe(1));

    fireEvent.click(view.getByText("the next card"));

    await waitFor(() => expect(view.getByText("card 8 body")).toBeTruthy());
    expect(cmCount(view.container)).toBe(0);
  });

  it("does not keep the next card from scrolling to its newest entry", async () => {
    stubTimelineFetch();
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const view = renderWithProviders(<CardPage keyed />, warmBothCards());
    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    const afterFirstCard = scrollTo.mock.calls.length;

    fireEvent.click(view.getByText("the next card"));

    // `didInitialScroll` is a ref, so only a remount resets it: without the key
    // the arrival at card 8 skipped the chat-style landing entirely.
    await waitFor(() => expect(view.getByText("card 8 body")).toBeTruthy());
    await waitFor(() =>
      expect(scrollTo.mock.calls.length).toBeGreaterThan(afterFirstCard),
    );
  });
});

describe("the same page without the key", () => {
  it("hands the next card's props to the row it left behind", async () => {
    stubTimelineFetch();
    const view = renderWithProviders(
      <CardPage keyed={false} />,
      warmBothCards(),
    );

    fireEvent.click(await view.findByLabelText("edit comment"));
    await waitFor(() => expect(cmCount(view.container)).toBe(1));

    const row = view.getByLabelText("comment actions").closest("[id]");
    fireEvent.click(view.getByText("the next card"));

    // The row instance survives on its `comment-11` key and takes card 8's
    // props with the editor still open on it — the reuse the key removes.
    // Note what is *not* asserted: card 8's body, which the surviving editor
    // is covering, and which is exactly the state the key prevents.
    await waitFor(() => expect(view.getByText("the next card")).toBeTruthy());
    expect(cmCount(view.container)).toBe(1);
    expect(view.getByLabelText("comment actions").closest("[id]")).toBe(row);
  });
});
