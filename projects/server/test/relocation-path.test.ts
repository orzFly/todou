import { describe, expect, it } from "vitest";
import { relocatedRequestPath } from "../src/services/relocation.ts";

const card = { slug: "b", issueNumber: 7 };
const comment = { slug: "b", issueNumber: 7, commentId: 9 };

describe("relocatedRequestPath (T-245)", () => {
  it("leaves the card's own address spelled as it is today", () => {
    // The guard on getIssue: T-231's and T-242's 301 assertions all read this
    // one, so the new rule has to compute it byte for byte.
    expect(relocatedRequestPath("/api/projects/a/issues/1", "", card)).toBe(
      "/api/projects/b/issues/7",
    );
  });

  it("keeps a subresource tail and its query", () => {
    expect(
      relocatedRequestPath(
        "/api/projects/a/issues/1/spec/files",
        "?version=1",
        card,
      ),
    ).toBe("/api/projects/b/issues/7/spec/files?version=1");
  });

  it("falls back when a comment id has nothing to translate it", () => {
    expect(
      relocatedRequestPath("/api/projects/a/issues/1/comments/5", "", card),
    ).toBeNull();
  });

  it("substitutes a comment id the marker knows", () => {
    expect(
      relocatedRequestPath("/api/projects/a/issues/1/comments/5", "", comment),
    ).toBe("/api/projects/b/issues/7/comments/9");
  });

  it("substitutes a comment id under a further tail", () => {
    expect(
      relocatedRequestPath(
        "/api/projects/a/issues/1/comments/5/revisions",
        "",
        comment,
      ),
    ).toBe("/api/projects/b/issues/7/comments/9/revisions");
  });

  it("rewrites an issue number that lives in the query", () => {
    expect(
      relocatedRequestPath(
        "/api/projects/a/attachments",
        "?issue_number=1",
        card,
      ),
    ).toBe("/api/projects/b/attachments?issue_number=7");
  });

  it("falls back when the query holds no issue number to rewrite", () => {
    expect(
      relocatedRequestPath("/api/projects/a/attachments", "", card),
    ).toBeNull();
  });

  it("falls back for a bare comment address", () => {
    // locateComment's own Location is built by resolve(), which already
    // translated the id; this shape must not be rewritten a second time.
    expect(
      relocatedRequestPath("/api/projects/a/comments/5", "", comment),
    ).toBeNull();
  });

  it("falls back for an attachment blob address", () => {
    expect(
      relocatedRequestPath(
        "/api/projects/a/attachments/1/download/note.txt",
        "",
        card,
      ),
    ).toBeNull();
  });

  it("falls back for a path outside the API", () => {
    expect(relocatedRequestPath("/projects/a/issues/1", "", card)).toBeNull();
  });

  it("falls back for a subresource nobody has taught it yet", () => {
    // What "safe going forward" means in executable form: a subresource added
    // later with an id of its own falls back instead of pointing at a wrong
    // row, without anyone having to come back and edit this function.
    expect(
      relocatedRequestPath("/api/projects/a/issues/1/widgets/3", "", card),
    ).toBeNull();
  });

  it("rewrites a path that named its project by id (T-266)", () => {
    // Stored links are id-anchored, so a 301 now commonly starts from one.
    // The leftover-digits guard below never looks at the project segment,
    // which is why an id there was already safe: it is replaced outright.
    expect(relocatedRequestPath("/api/projects/12/issues/1", "", card)).toBe(
      "/api/projects/b/issues/7",
    );
    expect(
      relocatedRequestPath("/api/projects/12/issues/1/comments/5", "", comment),
    ).toBe("/api/projects/b/issues/7/comments/9");
  });

  it("falls back when the segment after /issues is not a number", () => {
    // Same invariant from the other side: the card's number has to land
    // somewhere, or the rewrite names a project and not a card.
    expect(
      relocatedRequestPath("/api/projects/a/issues/counts", "", card),
    ).toBeNull();
  });
});
