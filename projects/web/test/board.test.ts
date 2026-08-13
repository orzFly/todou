import type { IssueListPage, Status, UserRef } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { moveIssue } from "../src/api/board.ts";

const author: UserRef = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human",
  avatar_url: null,
  owner: null,
};

const status = (id: number, name: string): Status => ({
  id,
  name,
  category: "open",
  color: "#000000",
  position: id,
  is_default: false,
});

const page = (numbers: number[], s: Status): IssueListPage => ({
  items: numbers.map((n) => ({
    id: n * 10,
    number: n,
    title: `issue ${n}`,
    status: s,
    author,
    assignees: [],
    labels: [],
    created_at: "2026-08-11T00:00:00Z",
    updated_at: "2026-08-11T00:00:00Z",
    body_edited_at: null,
    open_questions: 0,
    spec_version: null,
    spec_review_status: null,
    spec_unresolved_comments: 0,
    unread: false,
    unread_comments: 0,
  })),
  next_cursor: null,
});

describe("moveIssue (optimistic kanban move)", () => {
  const todo = status(1, "Todo");
  const done = status(2, "Done");

  it("removes from source and prepends to target with the new status", () => {
    const result = moveIssue(page([1, 2], todo), page([3], done), 1, done);
    expect(result.source?.items.map((i) => i.number)).toEqual([2]);
    expect(result.target?.items.map((i) => i.number)).toEqual([1, 3]);
    expect(result.target?.items[0]?.status.name).toBe("Done");
  });

  it("is a no-op on the target when the issue is not cached in source", () => {
    const target = page([3], done);
    const result = moveIssue(page([2], todo), target, 99, done);
    expect(result.source?.items.map((i) => i.number)).toEqual([2]);
    expect(result.target).toBe(target);
  });

  it("tolerates missing caches", () => {
    const result = moveIssue(undefined, undefined, 1, done);
    expect(result.source).toBeUndefined();
    expect(result.target).toBeUndefined();
  });

  it("does not mutate the input pages (rollback safety)", () => {
    const source = page([1], todo);
    const target = page([], done);
    moveIssue(source, target, 1, done);
    expect(source.items).toHaveLength(1);
    expect(target.items).toHaveLength(0);
  });
});
