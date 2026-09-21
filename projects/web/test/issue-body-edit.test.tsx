import type { QueryClient } from "@tanstack/react-query";
import { fireEvent, waitFor, within } from "@testing-library/react";
import type {
  Attachment,
  Issue,
  TimelineEvent,
  TimelineItem,
  TimelinePage,
} from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { BodyBlock } from "../src/pages/issue-detail.tsx";
import { cmGetValue, cmPressKey, cmSetValue, cmView } from "./cm.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const author = {
  id: 1,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const ISSUE: Issue = {
  id: 11,
  number: 7,
  title: "Fix the potato",
  body: "the first draft",
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

const ATTACHMENT: Attachment = {
  id: 12,
  filename: "notes.txt",
  content_type: "text/plain",
  size: 5,
  url: "/attachments/notes.txt",
  uploader: author,
  created_at: "2026-09-08T09:00:00Z",
  aliases: [],
};

afterEach(() => {
  vi.restoreAllMocks();
});

/** Into edit mode, which is what mounts the editor. */
async function openEditor() {
  const view = renderWithProviders(<BodyBlock slug="todou" issue={ISSUE} />);
  const edit = await view.findByLabelText("edit body");
  fireEvent.click(edit);
  await waitFor(() =>
    expect(cmGetValue(view.container)).toBe("the first draft"),
  );
  return view;
}

describe("the issue body editor", () => {
  it("saves the body on Ctrl-Enter", async () => {
    const updateIssue = vi.spyOn(api, "updateIssue").mockResolvedValue(ISSUE);
    const view = await openEditor();

    cmSetValue(view.container, "  the second draft \t\n");
    cmPressKey(view.container, "Enter", { ctrlKey: true });

    await waitFor(() => expect(updateIssue).toHaveBeenCalledOnce());
    const patchedBody = updateIssue.mock.calls[0]?.[2]?.body;
    expect(patchedBody).toBe("  the second draft");
    expect(patchedBody).not.toMatch(/\s$/);
  });

  it("trims the body before appending staged attachment markers", async () => {
    vi.spyOn(api, "uploadAttachment").mockResolvedValue(ATTACHMENT);
    const updateIssue = vi.spyOn(api, "updateIssue").mockResolvedValue(ISSUE);
    const view = await openEditor();

    cmSetValue(view.container, "\tthe second draft \t\n");
    fireEvent.drop(cmView(view.container).contentDOM, {
      dataTransfer: {
        files: [new File(["notes"], "notes.txt", { type: "text/plain" })],
        types: [],
        items: [],
        getData: () => "",
      } as unknown as DataTransfer,
    });
    await view.findByText("notes.txt");
    cmPressKey(view.container, "Enter", { ctrlKey: true });

    await waitFor(() => expect(updateIssue).toHaveBeenCalledOnce());
    const patchedBody = updateIssue.mock.calls[0]?.[2]?.body;
    expect(patchedBody).toBe(
      "\tthe second draft\n\n[notes.txt](/attachments/notes.txt)",
    );
    expect(patchedBody).not.toMatch(/\s$/);
  });

  it("leaves Alt-Enter to the editor, saving nothing", async () => {
    const updateIssue = vi.spyOn(api, "updateIssue").mockResolvedValue(ISSUE);
    const view = await openEditor();

    const editor = cmView(view.container);
    editor.dispatch({ selection: { anchor: editor.state.doc.length } });
    cmPressKey(view.container, "Enter", { altKey: true });

    expect(updateIssue).not.toHaveBeenCalled();
    expect(cmGetValue(view.container)).toBe("the first draft\n");
  });
});

describe("the issue body header's agent context", () => {
  const bot = {
    id: 2,
    login: "bot-one",
    display_name: "Bot One",
    kind: "machine" as const,
    avatar_url: null,
    owner: { id: 1, login: "alice" },
  };

  /** One tail page, as the card's own timeline query holds it. */
  function seedTimeline(client: QueryClient, items: TimelineItem[]) {
    client.setQueryData(["timeline", "todou", 7, "tail"], {
      pages: [
        {
          items,
          prev_cursor: null,
          next_cursor: null,
          total_count: items.length,
        } satisfies TimelinePage,
      ],
      pageParams: [{ dir: "init" }],
    });
  }

  const openedBy = (
    context: TimelineEvent["agent_context"],
  ): TimelineEvent => ({
    type: "event",
    id: 900,
    actor: bot,
    event_type: "opened",
    payload: {},
    created_at: "2026-09-08T09:00:00Z",
    agent_context: context,
  });

  const header = (view: { container: HTMLElement }) =>
    view.container.querySelector("div.rounded-lg")
      ?.firstElementChild as HTMLElement;

  it("wears the harness that opened the card, out of the timeline the page already reads", async () => {
    const client = testQueryClient();
    seedTimeline(client, [
      openedBy({ agent: "claude-code", model: "Opus 5", session_id: "s-1" }),
    ]);
    const fetched = vi.spyOn(globalThis, "fetch");
    const view = renderWithProviders(
      <BodyBlock slug="todou" issue={{ ...ISSUE, author: bot }} />,
      client,
    );
    await view.findByLabelText("edit body");

    const badge = within(header(view)).getByTestId("agent-context-badge");
    expect(badge.textContent).toContain("Opus 5");
    // The whole point of reading the cache rather than asking: the card's own
    // timeline is the only thing that may fetch this, and here it is already
    // read. The header's other reads (prefs, the ref prefix) are not this.
    expect(
      fetched.mock.calls.filter(([input]) =>
        String(input).includes("/timeline"),
      ),
    ).toEqual([]);
  });

  it("holds the badge's place while an agent's timeline is still coming", async () => {
    const client = testQueryClient();
    const view = renderWithProviders(
      <BodyBlock slug="todou" issue={{ ...ISSUE, author: bot }} />,
      client,
    );
    await view.findByLabelText("edit body");

    const placeholder = header(view).querySelector('[data-slot="skeleton"]');
    expect(placeholder).not.toBeNull();
    expect(
      within(header(view)).queryByTestId("agent-context-badge"),
    ).toBeNull();

    // The timeline lands, and the place is taken by the thing it was held for.
    seedTimeline(client, [
      openedBy({ agent: "claude-code", model: "Opus 5", session_id: "s-1" }),
    ]);
    await waitFor(() =>
      expect(
        within(header(view)).getByTestId("agent-context-badge").textContent,
      ).toContain("Opus 5"),
    );
    expect(header(view).querySelector('[data-slot="skeleton"]')).toBeNull();
  });

  it("holds no place on a human's card, whose badge is never coming", async () => {
    const view = renderWithProviders(
      <BodyBlock slug="todou" issue={ISSUE} />,
      testQueryClient(),
    );
    await view.findByLabelText("edit body");

    expect(header(view).querySelector('[data-slot="skeleton"]')).toBeNull();
  });

  it("drops the place once a settled timeline turns out to carry no context", async () => {
    const client = testQueryClient();
    // A card whose tail reached the start: nothing else is coming for it.
    seedTimeline(client, [openedBy(null)]);
    const view = renderWithProviders(
      <BodyBlock slug="todou" issue={{ ...ISSUE, author: bot }} />,
      client,
    );
    await view.findByLabelText("edit body");

    expect(header(view).querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(
      within(header(view)).queryByTestId("agent-context-badge"),
    ).toBeNull();
  });
});

describe("the issue body's author chip (T-391)", () => {
  it("links the author, and only the author", async () => {
    const view = renderWithProviders(
      // An @mention in the body would render a user link of its own; this
      // body holds one so the header-scoped query below has something to be
      // wrong about if it were asked of the whole block.
      <BodyBlock
        slug="todou"
        issue={{ ...ISSUE, body: "ask @bob about it" }}
      />,
    );
    await view.findByLabelText("edit body");

    const header = view.container.querySelector("div.rounded-lg")
      ?.firstElementChild as HTMLElement;
    expect(
      [...header.querySelectorAll('a[href^="/users/"]')].map((a) =>
        a.getAttribute("href"),
      ),
    ).toEqual(["/users/alice"]);
  });
});
