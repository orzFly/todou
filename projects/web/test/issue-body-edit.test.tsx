import { fireEvent, waitFor } from "@testing-library/react";
import type { Issue } from "@todou/shared";
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
  moves: [],
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

    cmSetValue(view.container, "the second draft");
    cmPressKey(view.container, "Enter", { ctrlKey: true });

    await waitFor(() => expect(updateIssue).toHaveBeenCalledOnce());
    expect(updateIssue.mock.calls[0]?.[2]).toEqual({
      body: "the second draft",
    });
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
