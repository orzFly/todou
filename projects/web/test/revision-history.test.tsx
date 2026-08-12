import { describe, expect, it } from "vitest";
import { toDiffFiles } from "../src/components/shared/revision-history.tsx";

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
