import { describe, expect, it } from "vitest";
import { parsePatchCommit } from "../src/lib/patch-commit.ts";

const FORMAT_PATCH = `From 1d5f092497ec921416c14ece859868c1dc4f11bf Mon Sep 17 00:00:00 2001
From: alice <noreply@example.com>
Date: Tue, 20 Oct 2026 16:04:27 +0000
Subject: [PATCH 1/2] fix(web): keep a #comment- landing in place while the
 card finishes loading (T-520)

The anchor revealed its target once.

Then it let go.
---
 projects/web/src/lib/scroll-insets.ts | 36 +++++
 1 file changed, 36 insertions(+)
`;

const GIT_SHOW = `commit 458c41c7e2c7160219e02a7cc4eadef9d0c012be
Author: bot-one <noreply@example.com>
Date:   Wed Oct 21 11:52:07 2026 +0000

    fix(web): keep opened folds open

    A staged comment no longer closes the fold.
`;

describe("parsePatchCommit (T-529)", () => {
  it("reads a format-patch header, unfolding the subject and dropping the stat", () => {
    expect(parsePatchCommit(FORMAT_PATCH)).toEqual({
      subject:
        "fix(web): keep a #comment- landing in place while the card finishes loading (T-520)",
      series: "1/2",
      author: "alice",
      date: "Tue, 20 Oct 2026 16:04:27 +0000",
      hash: "1d5f092497ec921416c14ece859868c1dc4f11bf",
      body: "The anchor revealed its target once.\n\nThen it let go.",
    });
  });

  it("reads git show output, the first message line as the subject", () => {
    expect(parsePatchCommit(GIT_SHOW)).toEqual({
      subject: "fix(web): keep opened folds open",
      author: "bot-one",
      date: "Wed Oct 21 11:52:07 2026 +0000",
      hash: "458c41c7e2c7160219e02a7cc4eadef9d0c012be",
      body: "A staged comment no longer closes the fold.",
    });
  });

  it("takes [PATCH] off a subject with no series number", () => {
    const commit = parsePatchCommit("Subject: [PATCH v2] fix: say deux\n");
    expect(commit?.subject).toBe("fix: say deux");
    expect(commit?.series).toBeUndefined();
  });

  it("names no commit for a bare diff command or Index banner", () => {
    expect(parsePatchCommit("diff -u a.txt b.txt")).toBeNull();
    expect(parsePatchCommit("Index: a.txt\n=================\n")).toBeNull();
    expect(parsePatchCommit("\n\n")).toBeNull();
  });

  it("keeps free text above a plain diff as a body without a subject", () => {
    expect(parsePatchCommit("Notes on the change\nsecond line\n")).toEqual({
      subject: "",
      body: "Notes on the change\nsecond line",
    });
  });
});
