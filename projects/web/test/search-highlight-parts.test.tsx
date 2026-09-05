import { render } from "@testing-library/react";
import { parseSearchQuery } from "@todou/shared";
import { describe, expect, it } from "vitest";
import {
  highlightParts,
  type KnownValues,
  verdictOf,
} from "../src/components/search/highlight.tsx";

const KNOWN: KnownValues = {
  label: ["area:web", "kind:bug"],
  status: ["Todo", "In Progress"],
  assignee: ["alice"],
};

/** The mirror's spans, as `[text, className]`, in document order. */
function spans(q: string, known: KnownValues = KNOWN): Array<[string, string]> {
  // A wrapper, not a fragment: the spans are what gets queried, and render()
  // needs one element to put them in.
  const { container } = render(
    <div>{highlightParts(q, parseSearchQuery(q), known)}</div>,
  );
  return [...container.querySelectorAll("span")].map((s) => [
    s.textContent ?? "",
    s.getAttribute("class") ?? "",
  ]);
}

describe("the mirror layer", () => {
  it("reproduces the query character for character", () => {
    for (const q of [
      "部署",
      "harness:codex is:comment 部署",
      '-label:"kind:bug",area:web 慢',
      "status:",
      'ab"cd"',
      "  a\tb  ",
    ]) {
      expect(spans(q).reduce((all, [text]) => all + text, "")).toBe(q);
    }
  });

  it("adds nothing that could take up width", () => {
    // Any padding, margin or border in here slides the mirror out of step
    // with the input it lies under, and the caret with it.
    for (const [, className] of spans('-label:"kind:bug",area:web 慢')) {
      expect(className).not.toMatch(/\b(p|m|border)[xytrbl]?-/);
    }
  });

  it("colours the key, the punctuation and the value apart", () => {
    expect(spans("harness:codex")).toEqual([
      ["harness", expect.stringContaining("text-primary")],
      [":", expect.stringContaining("text-muted-foreground")],
      ["codex", expect.any(String)],
    ]);
  });

  it("marks a value the project does not have", () => {
    const [, , value] = spans("label:不存在");
    expect(value?.[0]).toBe("不存在");
    expect(value?.[1]).toMatch(/decoration-wavy/);
  });

  it("leaves an unknown key looking like the plain text it is", () => {
    expect(spans("kind:bug")).toEqual([["kind:bug", ""]]);
    expect(spans("https://example.com")).toEqual([["https://example.com", ""]]);
  });
});

describe("verdictOf", () => {
  it("resolves a closed set without asking the project", () => {
    expect(verdictOf("is", "comments", {})).toBe("valid");
    expect(verdictOf("is", "pr", {})).toBe("invalid");
    expect(verdictOf("state", "OPEN", {})).toBe("valid");
  });

  it("knows the values that stand for themselves", () => {
    expect(verdictOf("assignee", "@me", KNOWN)).toBe("special");
    expect(verdictOf("harness", "none", {})).toBe("special");
  });

  it("compares a project name case-insensitively", () => {
    expect(verdictOf("status", "in progress", KNOWN)).toBe("valid");
    expect(verdictOf("label", "AREA:WEB", KNOWN)).toBe("valid");
    expect(verdictOf("label", "nope", KNOWN)).toBe("invalid");
  });

  it("stays quiet while the names are still loading", () => {
    // Flashing every value amber and back as the labels arrive is worse than
    // being briefly non-committal.
    expect(verdictOf("label", "anything", {})).toBe("unknown");
    // A free-form key has no list to wait for.
    expect(verdictOf("harness", "whatever", {})).toBe("valid");
    expect(verdictOf("session", "abc", {})).toBe("valid");
  });
});
