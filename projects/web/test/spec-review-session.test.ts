import { describe, expect, it } from "vitest";
import type { SpecReviewDraft } from "../src/lib/spec-drafts.ts";
import {
  createSpecReviewSession,
  isCurrentSpecReviewSession,
  specReviewSessionSurvivesNavigation,
} from "../src/lib/spec-review-session.ts";

const ANCHOR = {
  path: "proposal.md",
  version: 1,
  lineStart: 3,
  lineEnd: 4,
  colStart: null,
  colEnd: null,
  quote: "keep this anchor",
};

const DRAFT: SpecReviewDraft = {
  id: "d1",
  anchor: {
    path: ANCHOR.path,
    version: ANCHOR.version,
    line_start: ANCHOR.lineStart,
    line_end: ANCHOR.lineEnd,
    col_start: ANCHOR.colStart,
    col_end: ANCHOR.colEnd,
  },
  quote: ANCHOR.quote,
  body: "original draft",
};

describe("the stable spec review session", () => {
  it("keeps live text and the original anchor while the reading target changes", () => {
    const session = createSpecReviewSession({ slug: "p", issueNumber: 7 });
    session.retarget(ANCHOR);
    session.setComposerBody("whole composer marker");

    session.retarget({
      ...ANCHOR,
      path: "design.md",
      version: 2,
      lineStart: 8,
      lineEnd: 8,
      quote: "a new explicit selection",
    });

    expect(session.getSnapshot()).toMatchObject({
      composerBody: "whole composer marker",
      staging: {
        path: "design.md",
        version: 2,
        lineStart: 8,
        lineEnd: 8,
        quote: "a new explicit selection",
      },
    });
    expect(session.isDirty()).toBe(true);
  });

  it("separates a restored edit from its dirty baseline", () => {
    const session = createSpecReviewSession({ slug: "p", issueNumber: 7 });
    session.editDraft(DRAFT);
    expect(session.isDirty()).toBe(false);

    session.setComposerBody("original draft plus a change");
    expect(session.isDirty()).toBe(true);
    session.setComposerBody(DRAFT.body);
    expect(session.isDirty()).toBe(false);

    session.retarget({ ...ANCHOR, lineStart: 9, lineEnd: 9 });
    expect(session.isDirty()).toBe(true);
  });

  it("keeps hidden summary text dirty until the matching submit succeeds", () => {
    const session = createSpecReviewSession({ slug: "p", issueNumber: 7 });
    session.setFinishOpen(true);
    session.setSummary("summary marker");
    session.setFinishOpen(false);
    expect(session.getSnapshot().summary).toBe("summary marker");
    expect(session.isDirty()).toBe(true);

    const pending = session.beginSubmit("comment");
    expect(session.isDirty()).toBe(true);
    session.finishSubmit(pending.id, "summary marker");
    expect(session.getSnapshot()).toMatchObject({
      summary: "",
      finishOpen: false,
      pending: null,
    });
    expect(session.isDirty()).toBe(false);
  });

  it("does not let an old response clear text written after the click", () => {
    const session = createSpecReviewSession({ slug: "p", issueNumber: 7 });
    session.setSummary("submitted summary");
    const pending = session.beginSubmit("approve");
    session.setSummary("next review summary");

    session.finishSubmit(pending.id, "submitted summary");

    expect(session.getSnapshot()).toMatchObject({
      summary: "next review summary",
      pending: null,
    });
    expect(session.isDirty()).toBe(true);
  });

  it("updates dirty state synchronously before a React render", () => {
    const session = createSpecReviewSession({ slug: "p", issueNumber: 7 });
    session.retarget(ANCHOR);
    expect(session.isDirty()).toBe(false);
    session.setComposerBody("one keystroke");
    expect(session.isDirty()).toBe(true);
  });

  it("survives only a confirmed navigation within the same spec identity", () => {
    const identity = { slug: "p", issueNumber: 7 };
    const spec = (slug: string, number: string) => ({
      routeId: "/authed/projects/$slug/issues/$number/spec",
      params: { slug, number },
    });
    const current = spec("p", "7");

    expect(
      specReviewSessionSurvivesNavigation(identity, {
        current,
        next: spec("p", "7"),
      }),
    ).toBe(true);
    for (const next of [
      spec("p", "8"),
      spec("other", "7"),
      {
        routeId: "/authed/projects/$slug/issues/$number",
        params: { slug: "p", number: "7" },
      },
      { routeId: "__notFound__", params: {} },
    ]) {
      expect(
        specReviewSessionSurvivesNavigation(identity, { current, next }),
      ).toBe(false);
    }
  });

  it("isolates another card and a later visit to the same card", () => {
    const first = createSpecReviewSession({ slug: "p", issueNumber: 7 });
    first.setSummary("old visit");
    const other = createSpecReviewSession({ slug: "p", issueNumber: 8 });
    const returned = createSpecReviewSession({ slug: "p", issueNumber: 7 });

    expect(other.getSnapshot().summary).toBe("");
    expect(returned.getSnapshot().summary).toBe("");
    expect(returned.getSnapshot().token).not.toBe(first.getSnapshot().token);
    expect(
      isCurrentSpecReviewSession(
        first.getSnapshot().identity,
        first.getSnapshot().token,
      ),
    ).toBe(false);
    expect(
      isCurrentSpecReviewSession(
        returned.getSnapshot().identity,
        returned.getSnapshot().token,
      ),
    ).toBe(true);
  });
});
