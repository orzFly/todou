import { describe, expect, it } from "vitest";
import {
  BODY_PREVIEW_MAX,
  bodyPreview,
  displayTitle,
} from "../src/body-preview.ts";
import { ActivityCard } from "../src/schemas/activity-calendar.ts";
import { Issue } from "../src/schemas/issue.ts";
import { MutedIssue } from "../src/schemas/mute.ts";
import { SearchIssueRef } from "../src/schemas/search.ts";

describe("bodyPreview", () => {
  it.each([
    [
      "heading",
      "# Crash on save\n\nDetails here",
      "Crash on save Details here",
    ],
    ["deep heading", "### Steps", "Steps"],
    ["hashtag is text", "#hashtag stays", "#hashtag stays"],
    ["quote", "> quoted\n> > nested", "quoted nested"],
    [
      "nested list",
      "- one\n  - two\n    * three\n+ four",
      "one two three four",
    ],
    ["ordered list", "1. first\n2) second", "first second"],
    ["task boxes", "- [ ] todo\n- [x] done\n- [X] also", "todo done also"],
    ["link", "see [the docs](https://example.com) now", "see the docs now"],
    ["reference link", "see [the docs][1] now", "see the docs now"],
    [
      "image",
      "![screenshot of crash](/a.png) after",
      "screenshot of crash after",
    ],
    ["autolink", "at <https://todou.example/x>", "at https://todou.example/x"],
    ["html tags", "a <b>bold</b> <br/> word", "a bold word"],
    ["html comment", "<!-- hidden -->visible", "visible"],
    ["unterminated comment", "visible <!-- hidden\nstill hidden", "visible"],
    [
      "fence keeps code",
      "```ts\nconst a = 1;\n```\nafter",
      "const a = 1; after",
    ],
    ["tilde fence", "~~~\ncode\n~~~", "code"],
    ["frontmatter", "---\nkey: value\n---\nbody text", "body text"],
    ["thematic break", "above\n\n***\n\nbelow", "above below"],
    ["table", "| a | b |\n|---|:--:|\n| 1 | 2 |", "a b 1 2"],
    [
      "emphasis",
      "**bold** *it* ~~gone~~ `code` _under_",
      "bold it gone code under",
    ],
    ["snake_case survives", "call snake_case_name", "call snake_case_name"],
    ["escapes", "a \\* b \\| c \\_d", "a * b | c _d"],
    ["refs stay literal", "fixes T-12 and acme#3", "fixes T-12 and acme#3"],
    ["CJK", "## 保存时崩溃\n\n复现步骤", "保存时崩溃 复现步骤"],
    ["whitespace collapse", "  a \n\n\t b  ", "a b"],
    ["empty result", "<!-- only a comment -->\n\n---\n", ""],
    ["empty", "", ""],
  ])("%s", (_name, body, expected) => {
    expect(bodyPreview(body)).toBe(expected);
  });

  it("keeps exactly BODY_PREVIEW_MAX code points uncut", () => {
    const body = `${"a".repeat(BODY_PREVIEW_MAX - 1)}😀`;
    expect(bodyPreview(body)).toBe(body);
  });

  it("cuts by code point, so an astral character at the cut stays whole", () => {
    const body = `${"a".repeat(BODY_PREVIEW_MAX - 1)}😀b`;
    const out = bodyPreview(body);
    expect(out).toBe(`${"a".repeat(BODY_PREVIEW_MAX - 1)}😀…`);
    expect(Array.from(out)).toHaveLength(BODY_PREVIEW_MAX + 1);
  });

  it("trims whitespace before the ellipsis", () => {
    const body = `${"a".repeat(BODY_PREVIEW_MAX - 1)} bcd`;
    expect(bodyPreview(body)).toBe(`${"a".repeat(BODY_PREVIEW_MAX - 1)}…`);
  });

  it("cuts CJK by character", () => {
    const out = bodyPreview("字".repeat(200));
    expect(out).toBe(`${"字".repeat(BODY_PREVIEW_MAX)}…`);
  });
});

describe("displayTitle", () => {
  it("returns a real title as is", () => {
    expect(displayTitle({ title: "Crash", body_preview: null })).toEqual({
      text: "Crash",
      untitled: false,
    });
  });
  it("returns the preview for an untitled card", () => {
    expect(displayTitle({ title: "", body_preview: "first line" })).toEqual({
      text: "first line",
      untitled: true,
    });
  });
  it("returns empty text when the preview is empty or absent", () => {
    expect(displayTitle({ title: "", body_preview: "" })).toEqual({
      text: "",
      untitled: true,
    });
    expect(displayTitle({ title: "" })).toEqual({ text: "", untitled: true });
  });
});

describe("body_preview on payloads from older servers", () => {
  const status = {
    id: 2,
    name: "Todo",
    category: "open",
    color: "#aabbcc",
    position: 0,
    is_default: true,
  };
  const user = {
    id: 1,
    login: "alice",
    display_name: "Alice",
    kind: "human",
    avatar_url: null,
    owner: null,
  };
  const ts = "2026-01-02T00:00:00.000Z";

  it("defaults to null on Issue", () => {
    const parsed = Issue.parse({
      id: 1,
      number: 1,
      title: "x",
      body: "",
      status,
      author: user,
      assignees: [],
      labels: [],
      created_at: ts,
      updated_at: ts,
      body_edited_at: null,
    });
    expect(parsed.body_preview).toBeNull();
  });
  it("defaults to null on SearchIssueRef", () => {
    expect(
      SearchIssueRef.parse({ number: 1, title: "x", status }).body_preview,
    ).toBeNull();
  });
  it("defaults to null on ActivityCard", () => {
    const parsed = ActivityCard.parse({
      project: { id: 1, slug: "demo", name: "Demo", issue_prefix: null },
      issue_id: 3,
      number: 7,
      title: "x",
      status,
      url: "/projects/demo/issues/7",
      last_active_at: ts,
    });
    expect(parsed.body_preview).toBeNull();
  });
  it("defaults to null on MutedIssue", () => {
    const parsed = MutedIssue.parse({
      project: { slug: "demo", name: "Demo" },
      number: 1,
      title: "x",
      mode: "forever",
      muted_at: ts,
    });
    expect(parsed.body_preview).toBeNull();
  });
});
