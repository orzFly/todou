import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { AnnotatedMarkdown } from "../src/components/spec/annotated-markdown.tsx";
import { renderWithProviders } from "./render.tsx";

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
});
