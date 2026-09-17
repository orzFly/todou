import type { QueryClient } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import type { ReferenceConfig } from "@todou/shared";
import { describe, expect, it, vi } from "vitest";
import { referenceConfigQuery } from "../src/api/references.ts";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { AnnotatedMarkdown } from "../src/components/spec/annotated-markdown.tsx";
import { changedLineRanges } from "../src/lib/spec-changes.ts";
import { buildSegmentIndex } from "../src/lib/spec-source-index.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";

vi.mock("@pierre/diffs/react", () => ({
  CodeView: () => null,
  MultiFileDiff: () => null,
}));

/** A project spelling its refs `F-1`, so `#N` has something to resolve to. */
const refConfig: ReferenceConfig = {
  format: { prefix: "F", history: [] },
  autolinks: [],
};

function seededClient(slug: string): QueryClient {
  const client = testQueryClient();
  client.setQueryData(referenceConfigQuery(slug).queryKey, refConfig);
  return client;
}

async function mount(
  source: string,
  { slug, preview = false }: { slug?: string; preview?: boolean } = {},
): Promise<HTMLElement> {
  const { container } = renderWithProviders(
    <MarkdownView slug={slug} preview={preview}>
      {source}
    </MarkdownView>,
    slug === undefined ? testQueryClient() : seededClient(slug),
  );
  await waitFor(() => {
    expect(container.querySelector(".markdown-body")).not.toBeNull();
  });
  return container;
}

describe("links whose protocol the renderer refuses", () => {
  it.each([
    ["javascript:", "[a](javascript:alert(1))"],
    ["mixed case", "[a](JaVaScRiPt:alert(1))"],
    ["vbscript:", "[a](vbscript:msgbox(1))"],
    ["data:", "[a](data:text/html,<b>x</b>)"],
  ])("renders a %s link as its source", async (_name, source) => {
    const container = await mount(`${source}\n`);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain(source);
  });

  it("renders a rejected image as its source", async () => {
    const container = await mount("![x](javascript:alert(1))\n");
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("![x](javascript:alert(1))");
  });

  it("renders a reference whose definition is rejected as its source", async () => {
    const container = await mount("[a][r]\n\n[r]: javascript:alert(1)\n");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("[a][r]");
    // The definition line is not rendered by markdown at all, so the URL is
    // no more visible than it is today.
    expect(container.textContent).not.toContain("javascript:alert(1)");
  });

  it.each([
    ["a relative path", "[a](/foo)", "/foo"],
    ["an https URL", "[a](https://example.com/x)", "https://example.com/x"],
    ["a mailto", "[a](mailto:a@example.com)", "mailto:a@example.com"],
  ])("leaves %s alone", async (_name, source, href) => {
    const container = await mount(`${source}\n`);
    expect(container.querySelector("a")?.getAttribute("href")).toBe(href);
  });

  it("leaves the links the ref tokenizer builds alone", async () => {
    const container = await mount("see F-12 for context\n", {
      slug: "demo",
      preview: true,
    });
    const link = await waitFor(() => {
      const el = container.querySelector("a");
      if (el === null) throw new Error("no ref link yet");
      return el;
    });
    expect(link.getAttribute("href")).toBe("/projects/demo/issues/12");
  });
});

describe("the segment index and the renderer agree about a rejected link", () => {
  // The two processors have to stay one list. Let them differ and the index
  // reads the block as a link the width of its label while the page shows the
  // whole construct: every offset after it is wrong, column anchoring bails
  // out to whole lines, and `rehypeDecorations` drops what it cannot place
  // without saying so.
  it("flattens the block to exactly what the page shows", async () => {
    const body = "前言 [a](javascript:alert(1)) 结论。\n";
    const container = await mount(body);
    expect(container.querySelector("p")?.textContent).toBe(
      buildSegmentIndex(body).text,
    );
  });

  it("keeps a decoration on the words it was computed for", async () => {
    // The link sits before the changed word: its rendered length grows from
    // the label to the whole construct, so an index that still reads it as a
    // link puts the mark that many characters early.
    const before = "前言 [a](javascript:alert(1)) 结论原样。\n";
    const after = "前言 [a](javascript:alert(1)) 结论改写。\n";
    const view = renderWithProviders(
      <AnnotatedMarkdown
        slug="p"
        issueNumber={1}
        body={after}
        baselineBody={before}
        annotations={[]}
        changedRanges={changedLineRanges(before, after)}
        onStage={() => {}}
        onEditDraft={() => {}}
        onRemoveDraft={() => {}}
        onResolve={() => {}}
      />,
    );
    const container = await waitFor(() => {
      const el = view.getByTestId("annotated-markdown");
      if (el.querySelector(".spec-ins") === null) {
        throw new Error("not decorated yet");
      }
      return el;
    });
    expect(container.querySelector(".spec-ins")?.textContent).toBe("改写");
    expect(container.textContent).toContain("[a](javascript:alert(1))");
  });
});
