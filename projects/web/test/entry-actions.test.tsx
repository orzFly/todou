import type { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Issue, Project, TimelineComment } from "@todou/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectQuery } from "../src/api/queries.ts";
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

function project(slug: string, overrides: Partial<Project> = {}): Project {
  return {
    id: slug.length,
    slug,
    name: slug,
    description: "",
    created_at: "2026-01-01T00:00:00Z",
    // The picker keeps only the projects the reader may file a card in, so a
    // fixture with no role at all would empty every list here.
    viewer_role: "writer",
    ...overrides,
  };
}

/**
 * Seeded so the submenu has somewhere to file the new card. The single-project
 * query as well as the list: the pinned current row reads that one, and on a
 * real page `project-layout` has already fetched it.
 */
function clientWith(
  projects: Project[],
  current: Project = project("p"),
): QueryClient {
  const client = testQueryClient();
  client.setQueryData(["projects"], projects);
  client.setQueryData(projectQuery(current.slug).queryKey, current);
  return client;
}

function renderComment(
  options: {
    viewer?: { id: number; isAdmin: boolean; role?: "admin" | "writer" | null };
    onQuote?: (markdown: string) => void;
    comment?: TimelineComment;
    projects?: Project[];
    /** The project the comment lives in, as its own query answers for it. */
    current?: Project;
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
    clientWith(
      options.projects ?? [project("p"), project("other")],
      options.current,
    ),
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

function referenceRow(): HTMLElement {
  return within(screen.getByRole("menu")).getByRole("menuitem", {
    name: "Reference in a new issue",
  });
}

/**
 * Open the `…`, then the Reference submenu, and return its listbox.
 *
 * With `→`, not a click: a click on that row now files the card in this
 * project, which would send every caller of this helper somewhere else.
 */
async function openQuoteTargets(view: View) {
  await openMenu(view);
  fireEvent.keyDown(referenceRow(), { key: "ArrowRight" });
  return waitFor(() =>
    screen.getByRole("listbox", { name: "Reference in a new issue" }),
  );
}

function quoteParams(option: HTMLElement): URLSearchParams {
  const href = option.getAttribute("href") ?? "";
  return new URLSearchParams(href.slice(href.indexOf("?")));
}

/** Which project a row files the new card in, read off its own href. */
function targetSlug(option: HTMLElement): string {
  return (option.getAttribute("href") ?? "").split("/")[2] ?? "";
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

  it("puts this project first, marked (current), and only once", async () => {
    const view = renderComment();
    const listbox = await openQuoteTargets(view);
    const options = within(listbox).getAllByRole("option");

    expect(targetSlug(options[0])).toBe("p");
    expect(options[0].textContent).toContain("(current)");
    // Pinned means moved, not copied: the list it came in with holds it too.
    expect(options.map(targetSlug)).toEqual(["p", "other"]);
    for (const other of options.slice(1)) {
      expect(other.textContent).not.toContain("(current)");
    }
  });

  it("orders the rest the way the navbar switcher does", async () => {
    const view = renderComment({
      // Handed over oldest-first, so passing the list through unsorted cannot
      // produce the expected order. With no visit recorded, the frecency
      // comparator degrades to newest first.
      projects: [
        project("p"),
        project("older", { created_at: "2026-01-02T00:00:00Z" }),
        project("newest", { created_at: "2026-03-01T00:00:00Z" }),
        project("middle", { created_at: "2026-02-01T00:00:00Z" }),
      ],
      // Older than all of them, so a pinned row that got sorted along with
      // the rest would fall to the bottom instead of holding the top.
      current: project("p", { created_at: "2026-01-01T00:00:00Z" }),
    });
    const listbox = await openQuoteTargets(view);
    expect(within(listbox).getAllByRole("option").map(targetSlug)).toEqual([
      "p",
      "newest",
      "middle",
      "older",
    ]);
  });

  it("offers only the projects the reader may file a card in, plus this one", async () => {
    const view = renderComment({
      projects: [
        project("readable", { viewer_role: "reader" }),
        project("reportable", { viewer_role: "reporter" }),
        // A server predating the field sends no role at all.
        project("roleless", { viewer_role: undefined }),
      ],
      // The new-issue page renders for readers here as the navbar's button
      // does, so this row stays whatever the reader holds.
      current: project("p", { viewer_role: "reader" }),
    });
    const listbox = await openQuoteTargets(view);
    expect(within(listbox).getAllByRole("option").map(targetSlug)).toEqual([
      "p",
      "reportable",
    ]);
  });
});

/**
 * The row itself, whose gestures divide: what a mouse and a keyboard do with
 * it, and what still belongs to the submenu.
 *
 * Every one of these asserts the memory router's real location rather than an
 * href — an href that is right while the click does nothing is the shape this
 * goes wrong in, and only the location can tell the two apart.
 */
describe("the Reference row itself", () => {
  it("is a link to this project's new-issue page, carrying the quote", async () => {
    const view = renderComment();
    await openMenu(view);
    const row = referenceRow();

    expect(row.tagName).toBe("A");
    expect((row.getAttribute("href") ?? "").split("?")[0]).toBe(
      "/projects/p/issues/new",
    );
    const params = quoteParams(row);
    expect(params.get("quote_project")).toBe("p");
    expect(params.get("quote_issue")).toBe("7");
    expect(params.get("quote_comment")).toBe("1234");
  });

  it("files the card in this project when a mouse clicks it", async () => {
    const view = renderComment();
    await openMenu(view);
    fireEvent.click(referenceRow());

    // Read before awaiting the navigation: opening the submenu is synchronous,
    // while afterwards the whole tree is gone and nothing could be found.
    expect(
      screen.queryByRole("listbox", { name: "Reference in a new issue" }),
    ).toBeNull();
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe(
        "/projects/p/issues/new",
      ),
    );
    expect(view.router.state.location.searchStr).toContain("quote_issue=7");
  });

  it("files the card in this project on Enter", async () => {
    const view = renderComment();
    await openMenu(view);
    const row = referenceRow();
    row.focus();
    fireEvent.keyDown(row, { key: "Enter" });

    expect(
      screen.queryByRole("listbox", { name: "Reference in a new issue" }),
    ).toBeNull();
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe(
        "/projects/p/issues/new",
      ),
    );
  });

  it("opens the project list on ArrowRight, and goes nowhere", async () => {
    const view = renderComment();
    await openQuoteTargets(view);
    expect(view.router.state.location.pathname).toBe("/");
  });

  it("opens the project list on a tap, and goes nowhere", async () => {
    const view = renderComment();
    await openMenu(view);
    const row = referenceRow();
    // Touch never hovers, so this tap is the only way to the other projects.
    fireEvent.pointerDown(row, { pointerType: "touch" });
    fireEvent.click(row);

    await waitFor(() =>
      expect(
        screen.getByRole("listbox", { name: "Reference in a new issue" }),
      ).toBeTruthy(),
    );
    expect(view.router.state.location.pathname).toBe("/");
  });

  it("hands a ⌘-click to the browser, leaving the menu as it was", async () => {
    const view = renderComment();
    await openMenu(view);
    fireEvent.click(referenceRow(), { metaKey: true });

    expect(view.router.state.location.pathname).toBe("/");
    expect(screen.getByRole("menu")).toBeTruthy();
    // Radix would open the submenu on this click, and the list pulls focus
    // into its search box — out of the tab the reader is still standing in.
    expect(
      screen.queryByRole("listbox", { name: "Reference in a new issue" }),
    ).toBeNull();
  });

  // Nothing here resets the submenu when the menu closes, and nothing needs
  // to: Radix's own `Sub` pushes `onOpenChange(false)` at a controlled submenu
  // whenever its parent closes. This is the guard on that, not on our code —
  // drop the controlled state or meet a Radix that stops doing it, and a menu
  // reopens with the project list already standing.
  it("comes back with the project list closed", async () => {
    const view = renderComment();
    const trigger = await openMenu(view);
    fireEvent.keyDown(referenceRow(), { key: "ArrowRight" });
    await waitFor(() =>
      screen.getByRole("listbox", { name: "Reference in a new issue" }),
    );

    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());

    expect(
      screen.queryByRole("listbox", { name: "Reference in a new issue" }),
    ).toBeNull();
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
  blocked_by: [],
  blocks: [],
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
    const row = quoteParams(referenceRow());
    expect(row.get("quote_issue")).toBe("7");
    expect(row.has("quote_comment")).toBe(false);

    fireEvent.keyDown(referenceRow(), { key: "ArrowRight" });
    const listbox = await waitFor(() =>
      screen.getByRole("listbox", { name: "Reference in a new issue" }),
    );
    const option = quoteParams(within(listbox).getAllByRole("option")[0]);
    expect(option.get("quote_issue")).toBe("7");
    expect(option.has("quote_comment")).toBe(false);
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
