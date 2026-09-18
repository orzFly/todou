import { fireEvent, waitFor } from "@testing-library/react";
import type { TimelineComment } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import {
  CommentItem,
  canEditComment,
} from "../src/components/timeline/comment-item.tsx";
import { cmGetValue, cmSetValue } from "./cm.ts";
import { renderWithProviders } from "./render.tsx";

const author = {
  id: 2,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const COMMENT: TimelineComment = {
  type: "comment",
  id: 1234,
  author,
  body: "the first draft",
  component: null,
  created_at: "2026-08-11T00:00:00Z",
  edited_at: null,
  resolved_at: null,
  hidden_at: null,
  agent_context: null,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("canEditComment", () => {
  it("allows the author", () => {
    expect(canEditComment({ id: 2, isAdmin: false }, 2)).toBe(true);
  });

  it("allows project admins on any comment", () => {
    expect(canEditComment({ id: 1, isAdmin: true }, 2)).toBe(true);
  });

  it("denies other members and anonymous viewers", () => {
    expect(canEditComment({ id: 3, isAdmin: false }, 2)).toBe(false);
    expect(canEditComment(null, 2)).toBe(false);
    expect(canEditComment(undefined, 2)).toBe(false);
  });
});

describe("the comment editor", () => {
  it("trims trailing whitespace without rewriting leading whitespace", async () => {
    const updateComment = vi
      .spyOn(api, "updateComment")
      .mockResolvedValue(COMMENT);
    const view = renderWithProviders(
      <CommentItem
        slug="todou"
        issueNumber={7}
        comment={COMMENT}
        viewer={{ id: author.id, isAdmin: false }}
      />,
    );

    fireEvent.click(await view.findByLabelText("edit comment"));
    await waitFor(() =>
      expect(cmGetValue(view.container)).toBe("the first draft"),
    );
    cmSetValue(view.container, "  the second draft \t\n");
    fireEvent.click(view.getByText("Save"));

    await waitFor(() => expect(updateComment).toHaveBeenCalledOnce());
    const patchedBody = updateComment.mock.calls[0]?.[3];
    expect(patchedBody).toBe("  the second draft");
    expect(patchedBody).not.toMatch(/\s$/);
  });
});
