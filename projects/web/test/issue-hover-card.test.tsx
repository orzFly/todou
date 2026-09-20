import { type QueryClient, QueryObserver } from "@tanstack/react-query";
import { act, fireEvent, waitFor } from "@testing-library/react";
import type {
  BlockRef,
  IssueListItem,
  MePrefs,
  ReferenceConfig,
  ReferenceDirectory,
} from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueRefQuery } from "../src/api/issue-refs.ts";
import { issueQuery } from "../src/api/issues.ts";
import { prefsQuery } from "../src/api/prefs.ts";
import { projectQuery, projectsQuery } from "../src/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import { BlocksSection } from "../src/components/issue/blocks-section.tsx";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

/**
 * The issue preview (T-408). Its whole cost model rests on the card's
 * contents not mounting until it opens, so the counting tests here are the
 * criterion, not decoration.
 */

afterEach(() => vi.restoreAllMocks());

const author = {
  id: 1,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const refItem = (number: number, title: string): IssueListItem => ({
  id: number,
  number,
  title,
  status: {
    id: 1,
    name: "In Progress",
    category: "open",
    color: "#6b7280",
    position: 0,
    is_default: true,
  },
  author,
  assignees: [],
  labels: [],
  created_at: "2026-08-12T00:00:00Z",
  updated_at: "2026-08-12T00:00:00Z",
  body_edited_at: null,
  open_questions: 0,
  spec_version: null,
  spec_review_status: null,
  spec_unresolved_comments: 0,
  deleted_at: null,
  deleted_by: null,
  unread: false,
  unread_comments: 0,
  muted: null,
  blocked_by: [],
  blocks: [],
  moves: [],
});

const config: ReferenceConfig = {
  format: { prefix: "T", history: [] },
  autolinks: [],
};

const directory: ReferenceDirectory = { entries: [], contested: [] };

const PREFS: MePrefs = {
  show_weak_unread: true,
  ref_placement_list: "before",
  ref_placement_board: "own_line",
  ref_placement_detail: "before",
  ref_placement_reference: "before",
  boxed_ref_links: true,
  truncate_ref_title: true,
  show_repeated_ref_title: false,
};

const BODY = "the card's own body, only fetched on open";

const REF = "see [T-7](/projects/todou/issues/7)";

function seeded(overrides: Partial<MePrefs> = {}): QueryClient {
  const client = testQueryClient();
  client.setQueryData(referenceConfigQuery("todou").queryKey, config);
  // Every query the preview's own MarkdownView mounts, so a cache miss cannot
  // be mistaken for a request the hover itself made.
  client.setQueryData(referenceDirectoryQuery.queryKey, directory);
  client.setQueryData(projectsQuery.queryKey, [
    {
      id: 1,
      slug: "todou",
      name: "todou",
      description: "",
      created_at: "2026-08-12T00:00:00Z",
    },
  ]);
  client.setQueryData(projectQuery("todou").queryKey, {
    id: 1,
    slug: "todou",
    name: "todou",
    description: "",
    created_at: "2026-08-12T00:00:00Z",
    viewer_role: "writer",
  });
  client.setQueryData(issueRefQuery("todou", 7).queryKey, refItem(7, "Target"));
  client.setQueryData(issueRefQuery("todou", 8).queryKey, refItem(8, "Other"));
  client.setQueryData(prefsQuery.queryKey, { ...PREFS, ...overrides });
  // Request-count tests leave issueQuery empty; cache-sharing tests seed it
  // explicitly so they also exercise a body already read on the detail page.
  return client;
}

/**
 * Answers the card read and records every URL asked for, so "how many times"
 * is a question about this array rather than about the component.
 */
function countingFetch(body = BODY) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/api/projects/todou/issues/7")) {
      return new Response(JSON.stringify({ ...refItem(7, "Target"), body }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: { code: "not_found" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  });
  return {
    reads: () => urls.filter((url) => url.includes("/issues/7")),
  };
}

// React synthesizes onPointerEnter from the pointerover/pointerout pair, so
// firing `pointerEnter` itself reaches no handler.
const hover = (el: Element) => {
  fireEvent.pointerOver(el, { pointerType: "mouse", bubbles: true });
};

const unhover = (el: Element) => {
  fireEvent.pointerOut(el, {
    pointerType: "mouse",
    bubbles: true,
    relatedTarget: document.body,
  });
};

/** The card is portalled out of the render container. */
const cards = () =>
  document.querySelectorAll("[data-slot='hover-card-content']");

const opened = () =>
  waitFor(() => {
    const el = cards()[0];
    expect(el).toBeDefined();
    return el as HTMLElement;
  });

const closed = () => waitFor(() => expect(cards()).toHaveLength(0));

/** Long enough that an open would have happened, for the negative cases. */
const pastTheDelay = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 700)));

const linkToSeven = (root: ParentNode) =>
  waitFor(() => {
    const el = root.querySelector("a[data-issue-link='7']");
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });

describe("issue hover preview (T-408)", () => {
  it("asks for nothing until the reader stops on the link", async () => {
    const fetches = countingFetch();
    const view = renderWithProviders(
      <MarkdownView slug="todou">{REF}</MarkdownView>,
      seeded(),
    );
    await linkToSeven(view.container);
    await pastTheDelay();
    expect(fetches.reads()).toEqual([]);
  });

  it("fetches the body once when the card opens", async () => {
    const fetches = countingFetch();
    const view = renderWithProviders(
      <MarkdownView slug="todou">{REF}</MarkdownView>,
      seeded(),
    );
    hover(await linkToSeven(view.container));
    const card = await opened();
    await waitFor(() => expect(card.textContent).toContain(BODY));
    expect(card.textContent).toContain("In Progress");
    expect(card.textContent).toContain("Target");
    expect(fetches.reads()).toHaveLength(1);
  });

  it("does not fetch the body again when the same card reopens", async () => {
    const fetches = countingFetch();
    const view = renderWithProviders(
      <MarkdownView slug="todou">{REF}</MarkdownView>,
      seeded(),
    );
    const link = await linkToSeven(view.container);
    hover(link);
    const card = await opened();
    await waitFor(() => expect(card.textContent).toContain(BODY));
    unhover(link);
    await closed();
    hover(link);
    const again = await opened();
    await waitFor(() => expect(again.textContent).toContain(BODY));
    expect(fetches.reads()).toHaveLength(1);
  });

  it.each(["save", "invalidate"] as const)(
    "shows the updated detail body on rehover after %s (T-467)",
    async (update) => {
      const updatedBody = "the body the reader just saved";
      const fetches = countingFetch(updatedBody);
      const client = seeded();
      const detail = issueQuery("todou", 7);
      client.setQueryData(detail.queryKey, {
        ...refItem(7, "Target"),
        body: BODY,
      });
      const view = renderWithProviders(
        <MarkdownView slug="todou">{REF}</MarkdownView>,
        client,
      );
      const link = await linkToSeven(view.container);
      hover(link);
      const card = await opened();
      await waitFor(() => expect(card.textContent).toContain(BODY));
      expect(fetches.reads()).toHaveLength(0);
      unhover(link);
      await closed();

      await act(async () => {
        if (update === "save") {
          client.setQueryData(detail.queryKey, {
            ...refItem(7, "Target"),
            body: updatedBody,
          });
        } else {
          await client.invalidateQueries({ queryKey: detail.queryKey });
        }
      });
      hover(link);
      const again = await opened();
      await waitFor(() => expect(again.textContent).toContain(updatedBody));
      expect(again.textContent).not.toContain(BODY);
      expect(fetches.reads()).toHaveLength(update === "save" ? 0 : 1);
    },
  );

  it("warms the detail cache without another fresh read (T-467)", async () => {
    const fetches = countingFetch();
    const client = seeded();
    // Match the production client's detail freshness window.
    client.setDefaultOptions({ queries: { retry: false, staleTime: 5_000 } });
    const view = renderWithProviders(
      <MarkdownView slug="todou">{REF}</MarkdownView>,
      client,
    );
    const link = await linkToSeven(view.container);
    hover(link);
    const card = await opened();
    await waitFor(() => expect(card.textContent).toContain(BODY));
    unhover(link);
    await closed();

    const detail = new QueryObserver(client, issueQuery("todou", 7));
    const unsubscribe = detail.subscribe(() => {});
    try {
      expect(detail.getCurrentResult().data?.body).toBe(BODY);
      expect(detail.getCurrentResult().fetchStatus).toBe("idle");
      expect(fetches.reads()).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it("opens on a sidebar blocks row, which renders the same link", async () => {
    countingFetch();
    const ref: BlockRef = {
      edge_id: 5,
      project_id: 1,
      project: "todou",
      number: 7,
      ref: "T-7",
      hidden: false,
      cleared_at: null,
      blocker_deleted: false,
    };
    const view = renderWithProviders(
      <BlocksSection
        slug="todou"
        issue={{ number: 1, blocked_by: [ref], blocks: [] }}
        trashed={false}
      />,
      seeded(),
    );
    hover(await linkToSeven(view.container));
    const card = await opened();
    await waitFor(() => expect(card.textContent).toContain(BODY));
  });

  it("stops at one level: a reference inside the preview is not a trigger", async () => {
    countingFetch("and then [T-8](/projects/todou/issues/8)");
    const view = renderWithProviders(
      <MarkdownView slug="todou">{REF}</MarkdownView>,
      seeded(),
    );
    hover(await linkToSeven(view.container));
    const card = await opened();
    const inner = await waitFor(() => {
      const el = card.querySelector("a[data-issue-link='8']");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(inner.getAttribute("data-state")).toBeNull();
    hover(inner);
    await pastTheDelay();
    expect(cards()).toHaveLength(1);
  });

  it("never previews the card being read, whatever the title preference says", async () => {
    for (const showRepeated of [false, true]) {
      const fetches = countingFetch();
      const view = renderWithProviders(
        <MarkdownView slug="todou" issueNumber={7}>
          {REF}
        </MarkdownView>,
        seeded({ show_repeated_ref_title: showRepeated }),
      );
      const link = await linkToSeven(view.container);
      expect(link.getAttribute("data-state")).toBeNull();
      hover(link);
      await pastTheDelay();
      expect(cards()).toHaveLength(0);
      expect(fetches.reads()).toEqual([]);
      view.unmount();
    }
  });

  it("has nothing to hover when the reference resolves to nothing", async () => {
    countingFetch();
    const client = seeded();
    client.setQueryData(issueRefQuery("todou", 7).queryKey, null);
    const view = renderWithProviders(
      <MarkdownView slug="todou">{REF}</MarkdownView>,
      client,
    );
    await waitFor(() => {
      expect(view.container.textContent).toContain("T-7");
    });
    expect(view.container.querySelector("a[data-issue-link]")).toBeNull();
    await pastTheDelay();
    expect(cards()).toHaveLength(0);
  });
});

describe("the preview's assignees reach their own pages (T-391)", () => {
  it("links them, and outside the reference anchor the reader is on", async () => {
    const bob = {
      id: 2,
      login: "bob",
      display_name: "Bob Ray",
      kind: "human" as const,
      avatar_url: null,
      owner: null,
    };
    const target: IssueListItem = {
      ...refItem(7, "Target"),
      assignees: [bob],
    };
    const client = seeded();
    client.setQueryData(issueRefQuery("todou", 7).queryKey, target);
    countingFetch();
    const view = renderWithProviders(
      <MarkdownView slug="todou">{REF}</MarkdownView>,
      client,
    );
    const trigger = await linkToSeven(view.container);
    hover(trigger);
    const card = await opened();

    // The card's whole anchor list: its author is plain text, so the one
    // assignee's chip is the only user link the preview should hold.
    expect(
      [...card.querySelectorAll('a[href^="/users/"]')].map((a) =>
        a.getAttribute("href"),
      ),
    ).toEqual(["/users/bob"]);
    // `HoverCardContent` goes through a portal, so this anchor is not a
    // descendant of the reference anchor being hovered — nesting one inside
    // the other would be invalid content and an ambiguous click.
    expect(trigger.contains(card)).toBe(false);
  });
});
