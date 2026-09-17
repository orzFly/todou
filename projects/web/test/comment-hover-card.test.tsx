import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, waitFor } from "@testing-library/react";
import type {
  Attachment,
  IssueListItem,
  MePrefs,
  ReferenceConfig,
  ReferenceDirectory,
  TimelineComment,
  TimelineEvent,
} from "@todou/shared";
import { describe, expect, it, vi } from "vitest";
import {
  attachmentsQuery,
  attachmentTextQuery,
} from "../src/api/attachments.ts";
import { commentRefQuery, issueRefQuery } from "../src/api/issue-refs.ts";
import { prefsQuery } from "../src/api/prefs.ts";
import { projectsQuery } from "../src/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { EventRow } from "../src/components/timeline/event-row.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

// A `.txt` document card renders through CodeBlock, whose real pierre CodeView
// is lazy and paints into a shadow root.
vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({ items }: { items: Array<{ file: { contents: string } }> }) => (
    <pre>
      <code>{items.map((item) => item.file.contents).join("\n")}</code>
    </pre>
  ),
  MultiFileDiff: () => null,
}));

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
    name: "Todo",
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

const commentOf = (
  id: number,
  body: string,
  hiddenAt: string | null = null,
): TimelineComment => ({
  type: "comment",
  id,
  author,
  body,
  created_at: "2026-08-12T00:00:00Z",
  component: null,
  edited_at: null,
  resolved_at: null,
  hidden_at: hiddenAt,
  agent_context: null,
});

const config: ReferenceConfig = {
  format: { prefix: "T", history: [] },
  autolinks: [],
};

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

const BODY = "the preview body, in full";

const directory: ReferenceDirectory = { entries: [], contested: [] };

function seeded(comment: TimelineComment = commentOf(42, BODY)): QueryClient {
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
  client.setQueryData(issueRefQuery("todou", 7).queryKey, refItem(7, "Target"));
  client.setQueryData(
    commentRefQuery("todou", 7, comment.id).queryKey,
    comment,
  );
  client.setQueryData(prefsQuery.queryKey, PREFS);
  return client;
}

// React synthesizes onPointerEnter from the pointerover/pointerout pair, so
// firing `pointerEnter` itself reaches no handler.
const hover = (el: Element, pointerType: "mouse" | "touch" = "mouse") => {
  fireEvent.pointerOver(el, { pointerType, bubbles: true });
};

/** The card is portalled out of the render container. */
const cards = () =>
  document.querySelectorAll("[data-slot='hover-card-content']");

/**
 * Real timers throughout: the open delay is a Radix `setTimeout`, and a fake
 * clock has to be advanced from outside the `waitFor` that is watching for
 * the result, which deadlocks the two against each other.
 */
const opened = () =>
  waitFor(() => {
    const el = cards()[0];
    expect(el).toBeDefined();
    return el as HTMLElement;
  });

/** Long enough that an open would have happened, for the negative cases. */
const pastTheDelay = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 700)));

describe("comment hover card (T-371)", () => {
  it("previews the comment on hover", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="todou">
        {"see [T-7#comment-42](/projects/todou/issues/7#comment-42)"}
      </MarkdownView>,
      seeded(),
    );
    const trigger = await waitFor(() => {
      const el = view.container.querySelector("a[data-comment-link='42']");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    hover(trigger);
    const card = await opened();
    expect(card.textContent).toContain(BODY);
    expect(card.textContent).toContain("Alice");
  });

  // The card's own header, not the card: the preview body can hold @mentions,
  // which render user links of their own and would answer for this one.
  // Nesting is not a worry here — the content is portalled out of the trigger
  // (T-391).
  it("links the previewed comment's author", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="todou">
        {"see [T-7#comment-42](/projects/todou/issues/7#comment-42)"}
      </MarkdownView>,
      seeded(),
    );
    const trigger = await waitFor(() => {
      const el = view.container.querySelector("a[data-comment-link='42']");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    hover(trigger);
    const header = (await opened()).firstElementChild as HTMLElement;

    expect(
      [...header.querySelectorAll('a[href^="/users/"]')].map((a) =>
        a.getAttribute("href"),
      ),
    ).toEqual(["/users/alice"]);
  });

  it("asks the server for nothing the link had not already fetched", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const view = renderWithProviders(
      <MarkdownView slug="todou">
        {"see [T-7#comment-42](/projects/todou/issues/7#comment-42)"}
      </MarkdownView>,
      seeded(),
    );
    const trigger = await waitFor(() => {
      const el = view.container.querySelector("a[data-comment-link='42']");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    const before = fetchSpy.mock.calls.map((call) => String(call[0]));
    hover(trigger);
    await opened();
    expect(fetchSpy.mock.calls.map((call) => String(call[0]))).toEqual(before);
    fetchSpy.mockRestore();
  });

  it("does not open for a touch pointer", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="todou">
        {"see [T-7#comment-42](/projects/todou/issues/7#comment-42)"}
      </MarkdownView>,
      seeded(),
    );
    const trigger = await waitFor(() => {
      const el = view.container.querySelector("a[data-comment-link='42']");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    hover(trigger, "touch");
    await pastTheDelay();
    expect(cards()).toHaveLength(0);
  });

  it("does not spread the hidden comment's body", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="todou">
        {"see [T-7#comment-42](/projects/todou/issues/7#comment-42)"}
      </MarkdownView>,
      seeded(commentOf(42, "kept out of sight", "2026-08-13T00:00:00Z")),
    );
    const trigger = await waitFor(() => {
      const el = view.container.querySelector("a[data-comment-link='42']");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    hover(trigger);
    const card = await opened();
    expect(card.textContent).not.toContain("kept out of sight");
    expect(card.textContent).toContain("hidden");
  });

  it("stops at one level: the preview's own comment link is not a trigger", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="todou">
        {"see [T-7#comment-42](/projects/todou/issues/7#comment-42)"}
      </MarkdownView>,
      seeded(
        commentOf(
          42,
          "again [T-7#comment-42](/projects/todou/issues/7#comment-42)",
        ),
      ),
    );
    const trigger = await waitFor(() => {
      const el = view.container.querySelector("a[data-comment-link='42']");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    hover(trigger);
    const card = await opened();
    const inner = card.querySelector("a[data-comment-link='42']");
    expect(inner).not.toBeNull();
    expect(inner?.getAttribute("data-state")).toBeNull();
    hover(inner as HTMLElement);
    await pastTheDelay();
    expect(cards()).toHaveLength(1);
  });

  it("works on a timeline event row's comment reference", async () => {
    const event: TimelineEvent = {
      type: "event",
      id: 1,
      event_type: "referenced",
      actor: author,
      agent_context: null,
      payload: { by_issue: 7, by_comment: 42 },
      created_at: "2026-08-12T00:00:00Z",
    };
    const view = renderWithProviders(
      <EventRow event={event} slug="todou" />,
      seeded(),
    );
    const trigger = await waitFor(() => {
      const el = view.container.querySelector("a[data-comment-link='42']");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    hover(trigger);
    const card = await opened();
    expect(card.textContent).toContain(BODY);
  });

  it("draws a text document embed as a link, not a broken image", async () => {
    const EMBED =
      "![notes.txt](/api/projects/todou/attachments/9/download/notes.txt)";
    const client = seeded(commentOf(42, EMBED));
    const view = renderWithProviders(
      <MarkdownView slug="todou">
        {"see [T-7#comment-42](/projects/todou/issues/7#comment-42)"}
      </MarkdownView>,
      client,
    );
    const trigger = await waitFor(() => {
      const el = view.container.querySelector("a[data-comment-link='42']");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    hover(trigger);
    const card = await opened();

    expect(card.querySelector("img")).toBeNull();
    const link = card.querySelector("a[href$='notes.txt']");
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe("notes.txt");
  });

  it("still renders the same embed as a document card in the body", async () => {
    const EMBED =
      "![notes.txt](/api/projects/todou/attachments/9/download/notes.txt)";
    const url = "/api/projects/todou/attachments/9/download/notes.txt";
    const client = seeded();
    client.setQueryData(attachmentsQuery("todou", 7).queryKey, [
      {
        id: 9,
        filename: "notes.txt",
        content_type: "text/plain",
        size: 12,
        url,
        uploader: author,
        created_at: "2026-08-12T00:00:00Z",
        aliases: [],
      } satisfies Attachment,
    ]);
    client.setQueryData(attachmentTextQuery(url).queryKey, "the document");
    const view = renderWithProviders(
      <MarkdownView slug="todou" issueNumber={7}>
        {EMBED}
      </MarkdownView>,
      client,
    );

    await waitFor(() => {
      expect(view.container.querySelector("section")).not.toBeNull();
    });
    expect(view.container.querySelector("img")).toBeNull();
  });
});
