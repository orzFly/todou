import { QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import type {
  Attachment,
  Project,
  ReferenceConfig,
  ReferenceDirectory,
} from "@todou/shared";
import { describe, expect, it, vi } from "vitest";
import {
  attachmentsQuery,
  attachmentTextQuery,
} from "../src/api/attachments.ts";
import { projectsQuery } from "../src/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import {
  AnnotatedMarkdown,
  anchorForSelection,
} from "../src/components/spec/annotated-markdown.tsx";
import type * as BaselineTreeModule from "../src/lib/spec-baseline-tree.ts";
import { buildSegmentIndex } from "../src/lib/spec-source-index.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const { buildBaselineTreeSpy } = vi.hoisted(() => ({
  buildBaselineTreeSpy: vi.fn(),
}));

vi.mock("../src/lib/spec-baseline-tree.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof BaselineTreeModule>();
  buildBaselineTreeSpy.mockImplementation(actual.buildBaselineTree);
  return { ...actual, buildBaselineTree: buildBaselineTreeSpy };
});

vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({ items }: { items: Array<{ file: { contents: string } }> }) => (
    <pre>{items.map((item) => item.file.contents).join("\n")}</pre>
  ),
  MultiFileDiff: () => <div data-testid="code-diff" />,
}));

const old = "1. Alpha\n2. Beta\n3. Gamma\n4. Delta\n5. Epsilon\n";
const current = "1. Alpha\n2. Gamma\n3. Delta\n4. Epsilon\n";

async function renderCompared(before: string, after: string) {
  const view = renderWithProviders(
    <AnnotatedMarkdown
      slug="p"
      issueNumber={1}
      body={after}
      baselineBody={before}
      annotations={[]}
      onStage={() => {}}
      onEditDraft={() => {}}
      onRemoveDraft={() => {}}
      onResolve={() => {}}
    />,
  );
  return await waitFor(() => {
    const container = view.getByTestId("annotated-markdown");
    if (container.querySelector("ol") === null)
      throw new Error("not rendered yet");
    return container;
  });
}
async function renderComparedText(
  before: string,
  after: string,
  expected: string,
) {
  const view = renderWithProviders(
    <AnnotatedMarkdown
      slug="p"
      issueNumber={1}
      body={after}
      baselineBody={before}
      annotations={[]}
      onStage={() => {}}
      onEditDraft={() => {}}
      onRemoveDraft={() => {}}
      onResolve={() => {}}
    />,
  );
  const container = await waitFor(() => {
    const rendered = view.container.querySelector<HTMLElement>(
      '[data-testid="annotated-markdown"]',
    );
    expect(rendered).not.toBeNull();
    if (rendered === null) throw new Error("annotated markdown did not mount");
    expect(rendered.textContent).toContain(expected);
    return rendered;
  });
  return { view, container };
}

describe("T-405 structural deletions in the rendered document", () => {
  it("keeps old item 2 in its list before new item 2, without renumbering survivors", async () => {
    const before = renderWithProviders(
      <MarkdownView>{old}</MarkdownView>,
    ).container;
    const after = renderWithProviders(
      <MarkdownView>{current}</MarkdownView>,
    ).container;
    await waitFor(() => {
      expect(
        [...before.querySelectorAll("ol > li")].map((li) => li.textContent),
      ).toEqual(["Alpha", "Beta", "Gamma", "Delta", "Epsilon"]);
      expect(
        [...after.querySelectorAll("ol > li")].map((li) => li.textContent),
      ).toEqual(["Alpha", "Gamma", "Delta", "Epsilon"]);
    });

    const container = await renderCompared(old, current);
    const list = container.querySelector("ol");
    expect(list).not.toBeNull();
    if (list === null) throw new Error("no ordered list");
    const items = [...list.children].filter((node) => node.tagName === "LI");
    expect(items).toHaveLength(5);
    expect(items.map((li) => li.textContent)).toEqual([
      "1. Alpha",
      "2. Beta",
      "2. Gamma",
      "3. Delta",
      "4. Epsilon",
    ]);
    expect(items.map((li) => li.getAttribute("value"))).toEqual([
      "1",
      "2",
      "2",
      "3",
      "4",
    ]);
    expect(items[1]?.classList.contains("spec-del-structure")).toBe(true);
    expect(items[1]?.querySelector(".spec-list-number")?.textContent).toBe(
      "2. ",
    );
    expect(container.querySelectorAll(".spec-list-number")).toHaveLength(5);
    expect(container.querySelector("del.spec-del-block")).toBeNull();
  });

  it("keeps both old and new list starts independent of arbitrary later source numerals", async () => {
    const container = await renderCompared(
      "7. Alpha\n9. Beta\n10. Gamma\n1. Delta\n",
      "7. Alpha\n42. Gamma\n1. Delta\n",
    );
    const items = [...container.querySelectorAll("ol > li")];
    expect(items.map((li) => li.textContent)).toEqual([
      "7. Alpha",
      "8. Beta",
      "8. Gamma",
      "9. Delta",
    ]);
    expect(items.map((li) => li.getAttribute("value"))).toEqual([
      "7",
      "8",
      "8",
      "9",
    ]);
    expect(container.querySelectorAll(".spec-del-structure")).toHaveLength(1);
  });

  it("locates a tight paragraph predecessor for a nested list", async () => {
    const { container } = await renderComparedText(
      "- Parent\n  - Child\n",
      "- Parent\n",
      "Child",
    );
    expect(
      container
        .querySelector("li > ul.spec-del-structure")
        ?.textContent?.trim(),
    ).toBe("Child");
    expect(container.querySelector("del.spec-del-block")).toBeNull();
  });
  it("locates a tight paragraph predecessor for a deleted loose paragraph", async () => {
    const { container } = await renderComparedText(
      "- Alpha\n\n  **removed**\n",
      "- Alpha\n",
      "removed",
    );
    expect(
      container.querySelector("li > p.spec-del-structure strong")?.textContent,
    ).toBe("removed");
    expect(container.querySelector("del.spec-del-block")).toBeNull();
  });

  it("keeps a details deletion in its semantic container and opens it", async () => {
    const before =
      "<details>\n<summary>S</summary>\n\nKeep.\n\nRemoved **bold**.\n\n</details>\n";
    const after = "<details>\n<summary>S</summary>\n\nKeep.\n\n</details>\n";
    const { container } = await renderComparedText(before, after, "Removed");
    expect(
      container.querySelector("details p.spec-del-structure strong")
        ?.textContent,
    ).toBe("bold");
    expect(container.querySelector("details")?.open).toBe(true);
    expect(container.querySelector("del.spec-del-block")).toBeNull();
  });

  it("does not pull a root deletion after a details element into the fold", async () => {
    const before =
      "<details>\n<summary>S</summary>\n\nKeep.\n\n</details>\n\nRemoved root.\n";
    const after = "<details>\n<summary>S</summary>\n\nKeep.\n\n</details>\n";
    const { container } = await renderComparedText(
      before,
      after,
      "Removed root.",
    );
    expect(container.querySelector("details p.spec-del-structure")).toBeNull();
    expect(container.querySelector("del.spec-del-block")?.textContent).toBe(
      "Removed root.",
    );
  });

  it("restores an inline image at its source seam between prose", async () => {
    const { container } = await renderComparedText(
      "Before ![old](/old.png) after.\n",
      "Before  after.\n",
      "Before",
    );
    const paragraph = container.querySelector("p");
    expect(paragraph?.firstChild?.textContent).toBe("Before ");
    expect(paragraph?.childNodes[1]).toBe(
      container.querySelector("img.spec-del-structure"),
    );
    expect(paragraph?.lastChild?.textContent).toBe(" after.");
  });

  it("keeps an old ordered number when the current list is unordered", async () => {
    const { container } = await renderComparedText(
      "7. Alpha\n8. Beta\n9. Gamma\n",
      "- Alpha\n- Gamma\n",
      "Beta",
    );
    const oldItem = container.querySelector("ul > li.spec-del-structure");
    expect(oldItem?.textContent).toBe("8. Beta");
    expect(oldItem?.getAttribute("value")).toBe("8");
    expect(oldItem?.classList.contains("spec-old-ordered-item")).toBe(true);
    expect(oldItem?.querySelector(".spec-list-number-old")?.textContent).toBe(
      "8. ",
    );
  });

  it("keeps a first-paragraph deletion in the second sibling details", async () => {
    const { container } = await renderComparedText(
      "<details>\n<summary>A</summary>\n\nKeep A.\n\n</details>\n\n<details>\n<summary>B</summary>\n\nRemoved B.\n\nKeep B.\n\n</details>\n",
      "<details>\n<summary>A</summary>\n\nKeep A.\n\n</details>\n\n<details>\n<summary>B</summary>\n\nKeep B.\n\n</details>\n",
      "Removed B.",
    );
    const folds = container.querySelectorAll("details");
    expect(folds).toHaveLength(2);
    expect(folds[0]?.querySelector(".spec-del-structure")).toBeNull();
    expect(folds[1]?.querySelector("p.spec-del-structure")?.textContent).toBe(
      "Removed B.",
    );
  });

  it("keeps multiple inline image deletions at distinct source seams", async () => {
    const { container } = await renderComparedText(
      "A ![x](/x.png) B ![y](/y.png) C.\n",
      "A  B  C.\n",
      "A",
    );
    const paragraph = container.querySelector("p");
    expect(
      [...(paragraph?.childNodes ?? [])].map((node) =>
        node.nodeType === Node.ELEMENT_NODE
          ? (node as Element).getAttribute("src")
          : node.textContent,
      ),
    ).toEqual(["A ", "/x.png", " B ", "/y.png", " C."]);
  });

  it("freezes current ordered numbers when restoring an old unordered item", async () => {
    const { container } = await renderComparedText(
      "- A\n- B\n- C\n",
      "7. A\n8. C\n",
      "B",
    );
    const items = container.querySelectorAll("ol > li");
    expect(items[0]?.getAttribute("value")).toBe("7");
    expect(items[2]?.getAttribute("value")).toBe("8");
    expect(items[1]?.classList.contains("spec-old-unordered-item")).toBe(true);
    expect(items[1]?.querySelector(".spec-list-number")).toBeNull();
  });

  it("locates an inline image after decoded entities by rendered prose", async () => {
    const { container } = await renderComparedText(
      "A &amp; ![x](/x.png) B.\n",
      "A &amp;  B.\n",
      "A",
    );
    const paragraph = container.querySelector("p");
    expect(paragraph?.childNodes[0]?.textContent).toBe("A & ");
    expect(paragraph?.childNodes[1]).toBe(
      container.querySelector("img.spec-del-structure"),
    );
    expect(paragraph?.childNodes[2]?.textContent).toBe(" B.");
  });

  it("keeps attachment replacements inside the old selection boundary", async () => {
    const current = "Read  here.\n";
    const url = "/api/projects/p/attachments/1/download/note.md";
    const attachment: Attachment = {
      id: 1,
      filename: "note.md",
      content_type: "text/markdown",
      size: 8,
      url,
      uploader: {
        id: 1,
        login: "user",
        display_name: "User",
        kind: "human",
        avatar_url: null,
        owner: null,
      },
      created_at: "2026-01-01T00:00:00.000Z",
      aliases: [],
    };
    const client = testQueryClient();
    client.setQueryData(attachmentsQuery("p", 1).queryKey, [attachment]);
    client.setQueryData(attachmentTextQuery(url).queryKey, "document");
    const view = renderWithProviders(
      <AnnotatedMarkdown
        slug="p"
        issueNumber={1}
        body={current}
        baselineBody={`Read ![old](${url}) here.\n`}
        annotations={[]}
        onStage={() => {}}
        onEditDraft={() => {}}
        onRemoveDraft={() => {}}
        onResolve={() => {}}
      />,
      client,
    );
    const container = await waitFor(() => {
      const rendered = view.container.querySelector<HTMLElement>(
        '[data-testid="annotated-markdown"]',
      );
      expect(rendered).not.toBeNull();
      if (rendered === null)
        throw new Error("annotated markdown did not mount");
      expect(
        rendered.querySelector("section.spec-del-structure"),
      ).not.toBeNull();
      return rendered;
    });
    const link = container.querySelector<HTMLAnchorElement>(
      'section.spec-del-structure a[href$="note.md"]',
    );
    expect(link).not.toBeNull();
    const text = link?.firstChild ?? null;
    if (text === null) throw new Error("attachment link has no live text node");
    expect(
      anchorForSelection(container, buildSegmentIndex(current), {
        start: { node: text, offset: 0 },
        end: { node: text, offset: 7 },
        collapsed: false,
      }),
    ).toBeNull();
  });

  const stableClient = () => {
    const client = testQueryClient();
    const config: ReferenceConfig = {
      format: { prefix: null, history: [] },
      autolinks: [],
    };
    const directory: ReferenceDirectory = { entries: [], contested: [] };
    const project: Project = {
      id: 1,
      slug: "p",
      name: "P",
      description: "",
      created_at: "2026-01-01T00:00:00.000Z",
    };
    client.setQueryData(referenceConfigQuery("p").queryKey, config);
    client.setQueryData(referenceDirectoryQuery.queryKey, directory);
    client.setQueryData(projectsQuery.queryKey, [project]);
    return client;
  };

  it("builds the baseline once across parent rerenders and comparison close", async () => {
    buildBaselineTreeSpy.mockClear();
    const before = "Alpha.\n\nRemoved.\n";
    const after = "Alpha.\n";
    const client = stableClient();
    const tree = (baselineBody?: string) => (
      <QueryClientProvider client={client}>
        <AnnotatedMarkdown
          slug="p"
          issueNumber={1}
          body={after}
          baselineBody={baselineBody}
          annotations={[]}
          onStage={() => {}}
          onEditDraft={() => {}}
          onRemoveDraft={() => {}}
          onResolve={() => {}}
        />
      </QueryClientProvider>
    );
    const view = render(tree(before));
    await waitFor(() => {
      expect(view.getByText("Removed.")).not.toBeNull();
      expect(buildBaselineTreeSpy).toHaveBeenCalledTimes(1);
    });
    view.rerender(tree(before));
    expect(buildBaselineTreeSpy).toHaveBeenCalledTimes(1);
    view.rerender(tree());
    await waitFor(() => {
      expect(view.queryByText("Removed.")).toBeNull();
    });
    expect(buildBaselineTreeSpy).toHaveBeenCalledTimes(1);
    expect(
      view.container.querySelector(".spec-del-structure, .spec-list-number"),
    ).toBeNull();
  });

  it("does not build a baseline tree without structural deletions", async () => {
    buildBaselineTreeSpy.mockClear();
    const { container } = await renderComparedText(
      "Alpha old omega.\n",
      "Alpha omega.\n",
      "old",
    );
    expect(container.querySelector("del.spec-del")).not.toBeNull();
    expect(buildBaselineTreeSpy).not.toHaveBeenCalled();
  });
});
