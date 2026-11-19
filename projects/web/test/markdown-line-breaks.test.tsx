import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { Attachment } from "@todou/shared";
import type { Element, ElementContent, Root } from "hast";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  attachmentsQuery,
  attachmentTextQuery,
} from "../src/api/attachments.ts";
import { DocumentCard } from "../src/components/shared/document-card.tsx";
import {
  MarkdownView,
  useMarkdownRemarkPlugins,
} from "../src/components/shared/markdown-view.tsx";
import { AnnotatedMarkdown } from "../src/components/spec/annotated-markdown.tsx";
import { rehypeBlockBreaks } from "../src/lib/rehype-block-breaks.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const h = (
  tagName: string,
  children: ElementContent[] = [],
  properties: Element["properties"] = {},
): Element => ({ type: "element", tagName, properties, children });

vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({ items }: { items: Array<{ file: { contents: string } }> }) => (
    <pre>
      <code>{items.map((item) => item.file.contents).join("\n")}</code>
    </pre>
  ),
  MultiFileDiff: () => null,
}));

const uploader = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};
const file = (id: number, filename: string, type: string): Attachment => ({
  id,
  filename,
  content_type: type,
  size: 4,
  url: `/api/projects/p/attachments/${id}/download/${filename}`,
  uploader,
  created_at: "2026-01-01T00:00:00.000Z",
  aliases: [],
});
const FILES = [
  file(1, "one.md", "text/markdown"),
  file(2, "two.md", "text/markdown"),
  file(3, "before.png", "image/png"),
  file(4, "after.png", "image/png"),
];
const ONE = `![one.md](${FILES[0].url})`;
const TWO = `![two.md](${FILES[1].url})`;
const PAIR = `![before](${FILES[2].url}) → ![after](${FILES[3].url})`;

function renderMarkdown(
  body: string,
  props: { slug?: string; issueNumber?: number; document?: boolean } = {},
) {
  const client = testQueryClient();
  client.setQueryData(attachmentsQuery("p", 1).queryKey, FILES);
  for (const f of FILES.slice(0, 2)) {
    client.setQueryData(attachmentTextQuery(f.url).queryKey, "a\nb");
  }
  return renderWithProviders(
    <MarkdownView {...props}>{body}</MarkdownView>,
    client,
  );
}

async function paragraph(container: HTMLElement, selector = "p") {
  return await waitFor(() => {
    const el = container.querySelector<HTMLElement>(
      `.markdown-body > ${selector}`,
    );
    if (el === null) throw new Error("not rendered yet");
    return el;
  });
}

/** Breaks in the paragraph itself, not inside a card it embeds. */
const ownBreaks = (el: HTMLElement) => el.querySelectorAll(":scope > br");

describe("a single newline (T-702)", () => {
  it.each([
    ["with a slug", { slug: "p" }],
    ["without a slug", {}],
  ])("is a line break in a message, %s", async (_, props) => {
    const view = renderMarkdown("a\nb", props);
    const p = await paragraph(view.container);
    expect(ownBreaks(p)).toHaveLength(1);
  });

  it.each([
    ["with a slug", { slug: "p" }],
    ["without a slug", {}],
  ])("stays a newline in a document, %s", async (_, props) => {
    const view = renderMarkdown("a\nb", { ...props, document: true });
    const p = await paragraph(view.container);
    expect(p.querySelector("br")).toBeNull();
    expect(p.textContent).toBe("a\nb");
  });
});

describe("useMarkdownRemarkPlugins (T-702)", () => {
  it.each([
    [undefined, {}],
    [undefined, { document: true }],
    ["p", {}],
    ["p", { document: true }],
  ] as const)(
    "keeps its reference across renders (slug %s, %o)",
    (slug, options) => {
      const client = testQueryClient();
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
      const { result, rerender } = renderHook(
        () => useMarkdownRemarkPlugins(slug, options),
        { wrapper },
      );
      const first = result.current;
      rerender();
      expect(result.current).toBe(first);
    },
  );
});

describe("a block embed in a message (T-702)", () => {
  const embedParagraph = (container: HTMLElement) =>
    paragraph(container, ".markdown-paragraph");

  it("leaves no break between two cards on consecutive lines", async () => {
    const view = renderMarkdown(`${ONE}\n${TWO}\n`, {
      slug: "p",
      issueNumber: 1,
    });
    const p = await embedParagraph(view.container);
    expect(ownBreaks(p)).toHaveLength(0);
  });

  it("leaves no break between a card and the text under it", async () => {
    const view = renderMarkdown(`${ONE}\nafter\n`, {
      slug: "p",
      issueNumber: 1,
    });
    const p = await embedParagraph(view.container);
    expect(ownBreaks(p)).toHaveLength(0);
    expect(p.textContent).toContain("after");
  });

  it("keeps the break between text and the card under it", async () => {
    const view = renderMarkdown(`before\n${ONE}\n`, {
      slug: "p",
      issueNumber: 1,
    });
    const p = await embedParagraph(view.container);
    expect(ownBreaks(p)).toHaveLength(1);
  });

  // A pair is a whole paragraph, so text on the next line unmakes it in a
  // message exactly as in a document ("text after" in image-pair-cases.ts);
  // the comparison case is the pass's own, below.
  it("keeps a pair followed by a line of text as two images and a break", async () => {
    const view = renderMarkdown(`${PAIR}\nafter\n`, {
      slug: "p",
      issueNumber: 1,
    });
    const p = await paragraph(view.container);
    expect(p.querySelector(".media-compare")).toBeNull();
    expect(ownBreaks(p)).toHaveLength(1);
  });

  it("drops the break after an image comparison", () => {
    const tree: Root = {
      type: "root",
      children: [
        h("p", [
          h("img", [], { src: "/b.png", dataSwapSrc: "/a.png" }),
          { type: "text", value: " " },
          h("br"),
          { type: "text", value: "\n" },
          { type: "text", value: "after" },
        ]),
      ],
    };
    rehypeBlockBreaks({ textEmbeds: false })(tree);
    const p = tree.children[0] as Element;
    expect(
      p.children.map((c) => (c.type === "element" ? c.tagName : c.type)),
    ).toEqual(["img", "text", "text", "text"]);
  });

  it("keeps the break between two links without an issue", async () => {
    const view = renderMarkdown(`${ONE}\n${TWO}\n`, { slug: "p" });
    const p = await paragraph(view.container);
    await waitFor(() => {
      expect(p.querySelectorAll("a")).toHaveLength(2);
    });
    expect(ownBreaks(p)).toHaveLength(1);
  });
});

describe("document surfaces (T-702)", () => {
  it("a markdown document card keeps a single newline a space", async () => {
    const view = renderWithProviders(
      <DocumentCard filename="notes.md" text={"a\nb"} />,
    );
    const body = await waitFor(() => {
      const el = view.container.querySelector(".markdown-body p");
      if (el === null) throw new Error("not rendered yet");
      return el;
    });
    expect(body.querySelector("br")).toBeNull();
    expect(body.textContent).toBe("a\nb");
  });

  it("an embedded .md in a message renders its own text as a document", async () => {
    const view = renderMarkdown(`${ONE}\n`, { slug: "p", issueNumber: 1 });
    const inner = await waitFor(() => {
      const el = view.container.querySelector(
        ".markdown-paragraph .markdown-body p",
      );
      if (el === null) throw new Error("not rendered yet");
      return el;
    });
    expect(inner.querySelector("br")).toBeNull();
  });

  it("the spec document view keeps a single newline a space", async () => {
    const view = renderWithProviders(
      <AnnotatedMarkdown
        slug="p"
        issueNumber={1}
        body={"a\nb\n"}
        annotations={[]}
        onStage={() => {}}
        onEditDraft={() => {}}
        onRemoveDraft={() => {}}
        onResolve={() => {}}
      />,
    );
    const p = await waitFor(() => {
      const el = view.getByTestId("annotated-markdown").querySelector("p");
      if (el === null) throw new Error("not rendered yet");
      return el;
    });
    expect(p.querySelector("br")).toBeNull();
  });
});
