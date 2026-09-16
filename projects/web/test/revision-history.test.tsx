import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  RevisionHistory,
  toDiffFiles,
} from "../src/components/shared/revision-history.tsx";
import { renderWithProviders } from "./render.tsx";

const revision = {
  id: 3,
  actor: {
    id: 1,
    login: "user",
    display_name: "User",
    kind: "human" as const,
    avatar_url: null,
    owner: null,
  },
  created_at: "2026-08-12T10:00:00Z",
  body_before: "old text",
  body_after: "new text",
  agent_context: null,
};

describe("toDiffFiles", () => {
  it("maps a revision's sides onto named diff inputs", () => {
    expect(toDiffFiles(revision, "comment.md")).toEqual({
      oldFile: { name: "comment.md", contents: "old text" },
      newFile: { name: "comment.md", contents: "new text" },
    });
  });

  it("keeps both sides even when one is empty", () => {
    const emptied = { ...revision, body_after: "" };
    const { newFile } = toDiffFiles(emptied, "description.md");
    expect(newFile.contents).toBe("");
  });
});

describe("RevisionHistory · load failure (T-376)", () => {
  it("offers Retry inside the popover and lists revisions on success", async () => {
    const fetchRevisions = vi
      .fn()
      .mockRejectedValueOnce(new Error("history store gone"))
      .mockResolvedValueOnce({ items: [revision] });
    renderWithProviders(
      <RevisionHistory
        label="comment"
        editedAt="2026-08-12T10:00:00Z"
        filename="comment.md"
        queryKey={["revisions", "comment", 1]}
        fetchRevisions={fetchRevisions}
      />,
    );

    fireEvent.click(await screen.findByText("(edited)"));
    expect(
      (await screen.findByText(/Failed to load history/)).closest(
        '[role="status"]',
      )?.className,
    ).toContain("text-xs");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    // The refetch re-issues this section's own fetch — one more call, and
    // the recovered list renders the revision's author.
    await waitFor(() => expect(fetchRevisions).toHaveBeenCalledTimes(2));
    await screen.findByText("User");
    expect(screen.queryByText(/Failed to load history/)).toBeNull();
  });
});
