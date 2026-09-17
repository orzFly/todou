import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { rehypeSourceLines } from "../src/lib/rehype-source-lines.ts";
import { renderWithProviders } from "./render.tsx";

// Fences render through the lazily-imported pierre CodeView (T-31); pin it to
// a plain pre>code so the DOM is deterministic no matter when the lazy chunk
// would resolve.
vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({ items }: { items: Array<{ file: { contents: string } }> }) => (
    <pre>
      <code>{items.map((item) => item.file.contents).join("\n")}</code>
    </pre>
  ),
  MultiFileDiff: () => null,
}));

/** Mount one markdown body and wait for the router to hand it over. */
async function mount(
  source: string,
  { stamped = false }: { stamped?: boolean } = {},
): Promise<HTMLElement> {
  const { container } = renderWithProviders(
    <MarkdownView rehypePlugins={stamped ? [rehypeSourceLines] : undefined}>
      {source}
    </MarkdownView>,
  );
  await waitFor(() => {
    expect(container.querySelector(".markdown-body")).not.toBeNull();
  });
  return container;
}

const BLOCK =
  "<details>\n<summary>Summary text</summary>\n\nBody copy.\n\n</details>\n";

describe("<details> folds", () => {
  it("builds a fold out of the block form", async () => {
    const container = await mount(BLOCK);
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.querySelector(":scope > summary")?.textContent).toBe(
      "Summary text",
    );
    const body = container.querySelector("p");
    expect(body?.textContent).toBe("Body copy.");
    expect(details?.contains(body ?? null)).toBe(true);
  });

  it("honours <details open>", async () => {
    const container = await mount(BLOCK.replace("<details>", "<details open>"));
    expect(container.querySelector("details")?.hasAttribute("open")).toBe(true);
    // The unadorned form must not carry it, or the assertion above proves
    // nothing about which literal matched.
    const plain = await mount(BLOCK);
    expect(plain.querySelector("details")?.hasAttribute("open")).toBe(false);
  });

  it("gives a fold no attribute but `open`", async () => {
    const names = (el: Element | null) =>
      [...(el?.attributes ?? [])].map((attribute) => attribute.name);
    const plain = await mount(BLOCK);
    expect(names(plain.querySelector("details"))).toEqual([]);
    expect(names(plain.querySelector("summary"))).toEqual([]);
    const expanded = await mount(BLOCK.replace("<details>", "<details open>"));
    expect(names(expanded.querySelector("details"))).toEqual(["open"]);
  });

  it("nests", async () => {
    const container = await mount(
      "<details>\n<summary>outer</summary>\n\n" +
        "<details>\n<summary>inner</summary>\n\ndeep\n\n</details>\n\n" +
        "</details>\n",
    );
    const outer = container.querySelector("details");
    const inner = container.querySelector("details details");
    expect(outer).not.toBeNull();
    expect(inner).not.toBeNull();
    expect(outer?.querySelector(":scope > summary")?.textContent).toBe("outer");
    expect(inner?.querySelector(":scope > summary")?.textContent).toBe("inner");
    expect(container.querySelectorAll("details")).toHaveLength(2);
  });

  it.each([
    [
      "blockquote",
      "> <details>\n> <summary>s</summary>\n>\n> quoted body\n>\n> </details>\n",
      "blockquote > details",
    ],
    [
      "list item",
      "- <details>\n  <summary>s</summary>\n\n  listed body\n\n  </details>\n",
      "li > details",
    ],
    [
      "table cell",
      "| head |\n|---|\n| <details><summary>s</summary>celled body</details> |\n",
      "td > details",
    ],
  ])("forms inside a %s", async (_name, source, selector) => {
    const container = await mount(source);
    const details = container.querySelector(selector);
    expect(details).not.toBeNull();
    expect(details?.querySelector("summary")?.textContent).toBe("s");
    expect(details?.textContent).toContain("body");
  });

  it("leaves an unclosed <details> as source", async () => {
    const container = await mount("<details>\n<summary>s</summary>\n");
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).toContain("<details>");
    expect(container.textContent).toContain("<summary>s</summary>");
  });

  it("leaves a stray </details> as source", async () => {
    const container = await mount("before\n\n</details>\n\nafter\n");
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).toContain("</details>");
  });

  it("keeps a malformed close as source without inventing its tags", async () => {
    const container = await mount(
      "<details><summary>a</summary><p>b</details>\n",
    );
    // The pair that IS whitelisted still forms; `<p>` was never a candidate
    // and has to reach the reader as the four characters they typed.
    expect(container.querySelector("details > summary")?.textContent).toBe("a");
    expect(container.querySelector("p")).toBeNull();
    expect(container.textContent).toContain("<p>b");
  });

  it("rejects an open tag carrying an event handler", async () => {
    const container = await mount(
      "<details onclick=alert(1)>\n<summary>s</summary>\n\nbody\n\n</details>\n",
    );
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector("summary")).toBeNull();
    expect(container.textContent).toContain("<details onclick=alert(1)>");
  });

  it.each([
    [
      '<details class="x">',
      '<details class="x">\n<summary>s</summary>\n\nb\n\n</details>\n',
    ],
    [
      '<details open="open">',
      '<details open="open">\n<summary>s</summary>\n\nb\n\n</details>\n',
    ],
    ["<details/>", "<details/>\n<summary>s</summary>\n\nb\n\n</details>\n"],
    [
      "<detailsfoo>",
      "<detailsfoo>\n<summary>s</summary>\n\nb\n\n</detailsfoo>\n",
    ],
    ["< details>", "< details>\n<summary>s</summary>\n\nb\n\n</details>\n"],
  ])("builds nothing from %s", async (literal, source) => {
    const container = await mount(source);
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector("summary")).toBeNull();
    expect(container.textContent).toContain(literal);
  });

  it("matches the tag names case-insensitively", async () => {
    const container = await mount(
      "<DETAILS>\n<SUMMARY>shouty</SUMMARY>\n\nbody\n\n</DETAILS>\n",
    );
    expect(container.querySelector("details > summary")?.textContent).toBe(
      "shouty",
    );
  });

  it("allows whitespace before the closing angle bracket", async () => {
    const container = await mount(
      "<details >\n<summary >s</summary >\n\nbody\n\n</details >\n",
    );
    expect(container.querySelector("details > summary")?.textContent).toBe("s");
  });

  it("recognises nothing inside an indented code block", async () => {
    const container = await mount(
      "    <details>\n    <summary>s</summary>\n    </details>\n",
    );
    expect(container.querySelector("details")).toBeNull();
    const code = container.querySelector("pre > code");
    expect(code?.textContent).toContain("<details>");
    expect(code?.textContent).toContain("</details>");
  });

  it("leaves a body with no blank line around it literal", async () => {
    const container = await mount(
      "<details>\n<summary>s</summary>\n**body** here\n</details>\n",
    );
    expect(container.querySelector("details > summary")?.textContent).toBe("s");
    expect(container.querySelector("strong")).toBeNull();
    expect(container.textContent).toContain("**body** here");
  });

  it("leaves a <summary> outside any fold as source", async () => {
    const container = await mount("<summary>x</summary>\n");
    expect(container.querySelector("summary")).toBeNull();
    expect(container.textContent).toContain("<summary>x</summary>");
  });

  it("recognises nothing in an inline position", async () => {
    const container = await mount("text <details>x</details> more\n");
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).toContain("<details>x</details>");
  });

  it("keeps unsupported tags inside a fold escaped", async () => {
    const container = await mount(
      "<details>\n<summary>s</summary>\n\n" +
        "<iframe src=x></iframe>\n\n<script>alert(1)</script>\n\n</details>\n",
    );
    expect(container.querySelector("details")).not.toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<iframe src=x></iframe>");
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("parses a summary that stands on its own line as markdown", async () => {
    const container = await mount(
      "<details>\n<summary>\n\n**bold** with `code`\n\n</summary>\n\nbody\n\n</details>\n",
    );
    const summary = container.querySelector("details > summary");
    expect(summary).not.toBeNull();
    expect(summary?.querySelector("strong")?.textContent).toBe("bold");
    expect(summary?.querySelector("code")?.textContent).toBe("code");
  });

  it("lets a fence inside a fold keep its own rendering", async () => {
    const container = await mount(
      "<details>\n<summary>s</summary>\n\n```ts\nconst a = 1;\n```\n\n</details>\n",
      { stamped: true },
    );
    const details = container.querySelector("details");
    // The fence spans source lines 4-6 and its contents open on line 5.
    const wrapper = details?.querySelector("[data-loc-content-start]");
    expect(wrapper?.getAttribute("data-loc")).toBe("4-6");
    expect(wrapper?.getAttribute("data-loc-content-start")).toBe("5");
    expect(wrapper?.querySelector("code")?.textContent).toContain(
      "const a = 1;",
    );
  });
});

describe("source-line stamps around a fold", () => {
  it("stamps the paragraphs inside a fold with their own source lines", async () => {
    const container = await mount(BLOCK, { stamped: true });
    const body = container.querySelector("details p");
    expect(body?.textContent).toBe("Body copy.");
    expect(body?.getAttribute("data-loc")).toBe("4-4");
  });

  it("stamps the fold itself from its open tag to its close tag", async () => {
    const container = await mount(BLOCK, { stamped: true });
    expect(container.querySelector("details")?.getAttribute("data-loc")).toBe(
      "1-6",
    );
  });
});
