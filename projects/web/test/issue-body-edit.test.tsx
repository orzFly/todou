import { fireEvent, waitFor } from "@testing-library/react";
import type { Attachment, Issue } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { BodyBlock } from "../src/pages/issue-detail.tsx";
import { cmGetValue, cmPressKey, cmSetValue, cmView } from "./cm.ts";
import { renderWithProviders } from "./render.tsx";

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
