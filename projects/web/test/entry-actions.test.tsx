import type { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Issue, Project, TimelineComment } from "@todou/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentItem } from "../src/components/timeline/comment-item.tsx";
import {
  QuoteReplyProvider,
  useQuoteSink,
} from "../src/components/timeline/quote-reply.tsx";
import { BodyBlock } from "../src/pages/issue-detail.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  toast: { success: vi.fn(), error: vi.fn() },
}));
const { toast } = await import("sonner");

const author = {
  id: 2,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const BODY = "First paragraph.\n\nSecond **paragraph**.";

function comment(overrides: Partial<TimelineComment> = {}): TimelineComment {
  return {
    type: "comment",
    id: 1234,
    author,
    body: BODY,
    component: null,
    created_at: "2026-08-11T00:00:00Z",
    edited_at: null,
    resolved_at: null,
    hidden_at: null,
    agent_context: null,
    ...overrides,
  };
}

/** Stands in for the page's comment box, so quotes have somewhere to land. */
function Sink({ onQuote }: { onQuote: (markdown: string) => void }) {
  useQuoteSink(onQuote);
  return null;
}

function project(slug: string): Project {
  return {
    id: slug.length,
    slug,
    name: slug,
    description: "",
    created_at: "2026-01-01T00:00:00Z",
  };
}

/** Seeded so the submenu has somewhere to file the new card. */
function clientWith(projects: Project[]): QueryClient {
  const client = testQueryClient();
  client.setQueryData(["projects"], projects);
  return client;
}

function renderComment(
  options: {
    viewer?: { id: number; isAdmin: boolean; role?: "admin" | "writer" | null };
    onQuote?: (markdown: string) => void;
    comment?: TimelineComment;
    projects?: Project[];
  } = {},
) {
  return renderWithProviders(
    <QuoteReplyProvider>
      {options.onQuote && <Sink onQuote={options.onQuote} />}
      <CommentItem
        slug="p"
        issueNumber={7}
        comment={options.comment ?? comment()}
        viewer={options.viewer ?? null}
      />
    </QuoteReplyProvider>,
    clientWith(options.projects ?? [project("p"), project("other")]),
  );
}

type View = ReturnType<typeof renderComment>;

/**
 * Radix opens on pointerdown, which is also when the selection is read.
 *
 * `collapseSelection` supplies what a real browser does on that press and
 * happy-dom does not: the default action drops the selection. Without it the
 * menu's fallback read finds the selection still standing, and the capture on
 * pointerdown goes untested.
 */
async function openMenu(view: View, { collapseSelection = false } = {}) {
  const trigger = await waitFor(() =>
    within(view.container).getByRole("button", { name: "comment actions" }),
  );
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  if (collapseSelection) window.getSelection()?.removeAllRanges();
  await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
  return trigger;
}

function itemNames(): string[] {
  return within(screen.getByRole("menu"))
    .getAllByRole("menuitem")
    .map((el) => el.textContent ?? "");
}

function menuItem(name: string): HTMLElement {
  return within(screen.getByRole("menu")).getByRole("menuitem", { name });
}

/** Select the rendered body's second block, source lines 3-3. */
async function selectSecondParagraph(view: View) {
  const second = await waitFor(() => {
    const blocks = view.container.querySelectorAll("p[data-loc]");
    if (blocks.length < 2) throw new Error("body not stamped yet");
    return blocks[1] as HTMLElement;
  });
  const range = document.createRange();
  range.selectNodeContents(second);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  vi.clearAllMocks();
});

describe("EntryActionsMenu on a comment", () => {
  it("offers the four actions to a reader holding nothing", async () => {
    const view = renderComment({ onQuote: () => {} });
    await openMenu(view);
    expect(itemNames()).toEqual([
      "Copy link",
      "Copy Markdown",
      "Quote reply",
      "Reference in a new issue",
    ]);
    expect(
      document.querySelectorAll('[data-slot="dropdown-menu-separator"]'),
    ).toHaveLength(0);
  });

  it("puts Hide and Delete under a rule for a reader who holds them", async () => {
    const view = renderComment({
      viewer: { id: 2, isAdmin: true, role: "admin" },
      onQuote: () => {},
    });
    await openMenu(view);
    expect(itemNames()).toEqual([
      "Copy link",
      "Copy Markdown",
      "Quote reply",
      "Reference in a new issue",
      "Hide comment",
      "Delete comment…",
    ]);
    expect(
      document.querySelectorAll('[data-slot="dropdown-menu-separator"]'),
    ).toHaveLength(1);
  });

  it("copies an absolute permalink pointing at this comment", async () => {
    const view = renderComment();
    await openMenu(view);
    fireEvent.click(menuItem("Copy link"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledExactlyOnceWith(
        `${window.location.origin}/projects/p/issues/7#comment-1234`,
      ),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledOnce());
  });

  it("copies the stored markdown, not the rendered text", async () => {
    const view = renderComment();
    await openMenu(view);
    fireEvent.click(menuItem("Copy Markdown"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledExactlyOnceWith(BODY),
    );
  });

  it("says so when the browser has no clipboard", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    const view = renderComment();
    await openMenu(view);
    fireEvent.click(menuItem("Copy link"));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Clipboard is unavailable in this browser",
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("quotes the whole body when nothing is selected", async () => {
    const onQuote = vi.fn();
    const view = renderComment({ onQuote });
    await openMenu(view);
    fireEvent.click(menuItem("Quote reply"));
    await waitFor(() => expect(onQuote).toHaveBeenCalledExactlyOnceWith(BODY));
  });

  it("quotes only the selected blocks, in their source form", async () => {
    const onQuote = vi.fn();
    const view = renderComment({ onQuote });
    await selectSecondParagraph(view);

    await openMenu(view);
    fireEvent.click(menuItem("Quote reply"));
    await waitFor(() =>
      expect(onQuote).toHaveBeenCalledExactlyOnceWith("Second **paragraph**."),
    );
  });

  it("keeps the selection the press underneath it drops", async () => {
    const onQuote = vi.fn();
    const view = renderComment({ onQuote });
    await selectSecondParagraph(view);

    await openMenu(view, { collapseSelection: true });
    fireEvent.click(menuItem("Quote reply"));
    await waitFor(() =>
      expect(onQuote).toHaveBeenCalledExactlyOnceWith("Second **paragraph**."),
    );
  });

  it("drops Quote reply when the card has no comment box", async () => {
    const view = renderComment();
    await openMenu(view);
    expect(itemNames()).not.toContain("Quote reply");
  });

  it("drops both body actions when there is no body", async () => {
    const view = renderComment({
      comment: comment({ body: "   \n  " }),
      onQuote: () => {},
    });
    await openMenu(view);
    expect(itemNames()).toEqual(["Copy link", "Reference in a new issue"]);
  });

  it("keeps them for a body that renders as nothing but an HTML comment", async () => {
    // MarkdownView has no rehype-raw, so this is escaped and shown as text:
    // the reader can see it, and it is what Copy Markdown would hand over.
    const view = renderComment({
      comment: comment({ body: "<!-- a note to nobody -->" }),
      onQuote: () => {},
    });
    await openMenu(view);
    expect(itemNames()).toEqual([
      "Copy link",
      "Copy Markdown",
      "Quote reply",
      "Reference in a new issue",
    ]);
  });
});

/** Open the `…`, then the Reference submenu, and return its listbox. */
async function openQuoteTargets(view: View) {
  await openMenu(view);
  fireEvent.click(
    within(screen.getByRole("menu")).getByRole("menuitem", {
      name: "Reference in a new issue",
    }),
  );
  return waitFor(() =>
    screen.getByRole("listbox", { name: "Reference in a new issue" }),
  );
}

function quoteParams(option: HTMLElement): URLSearchParams {
  const href = option.getAttribute("href") ?? "";
  return new URLSearchParams(href.slice(href.indexOf("?")));
}

describe("Reference in a new issue", () => {
  it("offers every project as a real link carrying the quote source", async () => {
    const view = renderComment();
    const listbox = await openQuoteTargets(view);
    const options = within(listbox).getAllByRole("option");
    expect(options.map((el) => el.tagName)).toEqual(["A", "A"]);

    const other = options.find((el) => el.textContent?.includes("other"));
    if (other === undefined) throw new Error("no option for other");
    expect((other.getAttribute("href") ?? "").split("?")[0]).toBe(
      "/projects/other/issues/new",
    );
    const params = quoteParams(other);
    expect(params.get("quote_project")).toBe("p");
    expect(params.get("quote_issue")).toBe("7");
    expect(params.get("quote_comment")).toBe("1234");
  });

  it("puts focus in the search box the submenu opens with", async () => {
    const view = renderComment({
      projects: Array.from({ length: 9 }, (_, i) => project(`p${i}`)),
    });
    await openQuoteTargets(view);
    const input = screen.getByRole("combobox");
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("leaves ArrowLeft in the search box to the search box", async () => {
    const view = renderComment({
      projects: Array.from({ length: 9 }, (_, i) => project(`p${i}`)),
    });
    const listbox = await openQuoteTargets(view);
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    // Radix closes a submenu on ArrowLeft; inside a text box that key moves
    // the caret, so the menu has to stay standing.
    expect(listbox.isConnected).toBe(true);
    expect(
      screen.queryByRole("listbox", { name: "Reference in a new issue" }),
    ).toBeTruthy();
  });

  it("filters the destinations by name", async () => {
    const view = renderComment({
      projects: Array.from({ length: 9 }, (_, i) => project(`p${i}`)),
    });
    const listbox = await openQuoteTargets(view);
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "p7" },
    });
    await waitFor(() =>
      expect(within(listbox).getAllByRole("option")).toHaveLength(1),
    );
  });
});

const ISSUE: Issue = {
  id: 11,
  number: 7,
  title: "Fix the potato",
  body: BODY,
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
  created_at: "2026-09-08T09:00:00Z",
  updated_at: "2026-09-08T09:00:00Z",
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
  moves: [],
};

function renderBody(
  options: { readOnly?: boolean; withBox?: boolean; body?: string } = {},
) {
  return renderWithProviders(
    <QuoteReplyProvider>
      {options.withBox && <Sink onQuote={() => {}} />}
      <BodyBlock
        slug="p"
        issue={
          options.body === undefined ? ISSUE : { ...ISSUE, body: options.body }
        }
        readOnly={options.readOnly}
      />
    </QuoteReplyProvider>,
    clientWith([project("p"), project("other")]),
  );
}

async function openBodyMenu(view: View) {
  const trigger = await waitFor(() =>
    within(view.container).getByRole("button", { name: "description actions" }),
  );
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
}

describe("EntryActionsMenu on the issue body", () => {
  it("carries the same four actions", async () => {
    const view = renderBody({ withBox: true });
    await openBodyMenu(view);
    expect(itemNames()).toEqual([
      "Copy link",
      "Copy Markdown",
      "Quote reply",
      "Reference in a new issue",
    ]);
  });

  it("copies the card's own address, with no comment anchor", async () => {
    const view = renderBody();
    await openBodyMenu(view);
    fireEvent.click(menuItem("Copy link"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledExactlyOnceWith(
        `${window.location.origin}/projects/p/issues/7`,
      ),
    );
  });

  it("references the body rather than a comment", async () => {
    const view = renderBody();
    await openBodyMenu(view);
    fireEvent.click(menuItem("Reference in a new issue"));
    const listbox = await waitFor(() =>
      screen.getByRole("listbox", { name: "Reference in a new issue" }),
    );
    const params = quoteParams(within(listbox).getAllByRole("option")[0]);
    expect(params.get("quote_issue")).toBe("7");
    expect(params.has("quote_comment")).toBe(false);
  });

  it("offers nothing to copy or quote on a card with no description", async () => {
    const view = renderBody({ withBox: true, body: "" });
    // The reported case: the body block says `No description.` and the two
    // body actions would produce an empty clipboard and a lone `>`.
    await within(view.container).findByText("No description.");
    await openBodyMenu(view);
    expect(itemNames()).toEqual(["Copy link", "Reference in a new issue"]);
  });

  it("keeps the menu on a trashed card, minus Quote reply", async () => {
    const view = renderBody({ readOnly: true });
    await openBodyMenu(view);
    expect(
      within(view.container).queryByRole("button", { name: "edit body" }),
    ).toBeNull();
    expect(itemNames()).toEqual([
      "Copy link",
      "Copy Markdown",
      "Reference in a new issue",
    ]);
  });
});

describe("who gets the menu", () => {
  it("renders it for a reader with no hide or edit rights", async () => {
    const view = renderComment();
    expect(
      await within(view.container).findByRole("button", {
        name: "comment actions",
      }),
    ).toBeTruthy();
  });

  it("leaves a comment still being sent without one", async () => {
    const view = renderWithProviders(
      <QuoteReplyProvider>
        <CommentItem slug="p" issueNumber={7} comment={comment()} pending />
      </QuoteReplyProvider>,
    );
    await within(view.container).findByText("sending…");
    expect(
      within(view.container).queryByRole("button", { name: "comment actions" }),
    ).toBeNull();
  });
});
