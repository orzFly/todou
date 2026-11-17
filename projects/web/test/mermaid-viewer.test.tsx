import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Attachment } from "@todou/shared";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachmentsQuery } from "../src/api/attachments.ts";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { AnnotatedMarkdown } from "../src/components/spec/annotated-markdown.tsx";
import { resetCompareMode } from "../src/lib/compare-mode.ts";
import { rehypeSourceLines } from "../src/lib/rehype-source-lines.ts";
import { changedLineRanges } from "../src/lib/spec-changes.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";

vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({ items }: { items: Array<{ file: { contents: string } }> }) => (
    <pre data-testid="code">
      <code>{items.map((item) => item.file.contents).join("\n")}</code>
    </pre>
  ),
  MultiFileDiff: ({ newFile }: { newFile: { contents: string } }) => (
    <pre data-testid="fence-diff">{newFile.contents}</pre>
  ),
  File: () => <div data-testid="file-view" />,
  WorkerPoolContextProvider: ({ children }: { children: ReactNode }) =>
    children,
  useWorkerPool: () => undefined,
}));

// mermaid cannot lay anything out under happy-dom, so the renderer is the
// seam, answering by source (see mermaid-block.test.tsx).
type Result =
  | { ok: true; svg: string; width: number; height: number }
  | { ok: false; error: string };
const results = vi.hoisted(() => new Map<string, Result>());
const renderDiagram = vi.hoisted(() =>
  vi.fn(
    async (source: string): Promise<Result> =>
      results.get(source) ?? { ok: false, error: "No diagram type detected" },
  ),
);
vi.mock("../src/lib/mermaid.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/mermaid.ts")>()),
  renderDiagram,
}));

const OLD = "sequenceDiagram\n  A->>B: hi";
const NEW = "sequenceDiagram\n  A->>B: hello";
const svg = (id: string, text: string) =>
  `<svg id="${id}" viewBox="0 0 400 200" aria-roledescription="sequence"><text>${text}</text></svg>`;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  results.clear();
  results.set(OLD, { ok: true, svg: svg("m1", "hi"), width: 400, height: 200 });
  results.set(NEW, {
    ok: true,
    svg: svg("m2", "hello"),
    width: 420,
    height: 200,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetCompareMode();
});

const fence = (source: string) =>
  `\`\`\`mermaid title="flow.mmd"\n${source}\n\`\`\``;

const uploader = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};
const file = (id: number, filename: string): Attachment => ({
  id,
  filename,
  content_type: "image/png",
  size: 1024 * id,
  url: `/api/projects/p/attachments/${id}/download/${filename}`,
  uploader,
  created_at: "2026-01-01T00:00:00.000Z",
  aliases: [],
});
const FILES = [file(1, "login-v1.png"), file(2, "login-v2.png")];
const img = (a: Attachment) => `![${a.filename}](${a.url})`;

/**
 * A spec page: a changed diagram, then a swapped image. Ready once the
 * diagram has drawn `sides` of its sides.
 */
async function renderPage(sides = 2) {
  const before = `${fence(OLD)}\n\nBetween.\n\n${img(FILES[0])}\n`;
  const after = `${fence(NEW)}\n\nBetween.\n\n${img(FILES[1])}\n`;
  const client = testQueryClient();
  client.setQueryData(attachmentsQuery("p", 1).queryKey, FILES);
  const view = renderWithProviders(
    <AnnotatedMarkdown
      slug="p"
      issueNumber={1}
      body={after}
      baselineBody={before}
      annotations={[]}
      compareLabels={{ before: "v1", after: "v2" }}
      changedRanges={changedLineRanges(before, after)}
      onStage={() => {}}
      onEditDraft={() => {}}
      onRemoveDraft={() => {}}
      onResolve={() => {}}
    />,
    client,
  );
  return waitFor(() => {
    const el = view.getByTestId("annotated-markdown");
    const blocks = [...el.querySelectorAll<HTMLElement>(".media-compare")];
    if (
      blocks.length < 2 ||
      blocks[0]?.querySelectorAll(".mermaid-compare-diagram svg").length !==
        sides
    )
      throw new Error("not rendered yet");
    return blocks as [HTMLElement, HTMLElement];
  });
}

function load(block: HTMLElement, side: string) {
  const image = block.querySelector<HTMLImageElement>(
    `[data-side="${side}"] img`,
  );
  if (image === null) throw new Error(`no ${side} image`);
  Object.defineProperty(image, "naturalWidth", { value: 720 });
  Object.defineProperty(image, "naturalHeight", { value: 400 });
  fireEvent.load(image);
}

const heading = (dialog: HTMLElement) =>
  within(dialog).getByRole("heading").textContent;

describe("a changed diagram in the viewer (T-773)", () => {
  it("opens from its toolbar button or either picture, and pages to images in document order", async () => {
    const [diagram, image] = await renderPage();
    load(image, "before");
    load(image, "after");
    const opens = within(diagram).getAllByRole("button", {
      name: "Open in the viewer",
    });
    // The toolbar's, then one per side.
    expect(opens).toHaveLength(3);
    expect(
      opens.slice(1).every((b) => b.classList.contains("media-compare-open")),
    ).toBe(true);

    fireEvent.click(opens[2] as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    expect(heading(dialog)).toBe("flow.mmd");
    expect(within(dialog).getByText("1 / 2")).toBeTruthy();
    expect(within(dialog).getByText("mermaid · sequence")).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Copy v1 source" }),
    ).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "next comparison" }),
    );
    expect(heading(dialog)).toBe("login-v1.png → login-v2.png");
    expect(within(dialog).getByText("2 / 2")).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "next comparison" }),
    );
    expect(heading(dialog)).toBe("flow.mmd");
  });

  it("offers no viewer for a diagram with a side that does not parse, and leaves it out of paging", async () => {
    results.set(OLD, { ok: false, error: "No diagram type detected" });
    const [diagram, image] = await renderPage(1);
    expect(
      within(diagram).queryByRole("button", { name: "Open in the viewer" }),
    ).toBeNull();
    load(image, "before");
    load(image, "after");
    fireEvent.click(
      within(image).getByRole("button", { name: "Open in the viewer" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(heading(dialog)).toBe("login-v1.png → login-v2.png");
    expect(
      within(dialog).queryByRole("button", { name: "next comparison" }),
    ).toBeNull();
  });
});

describe("a lone diagram in the viewer (T-773)", () => {
  async function mount(markdown: string) {
    const { container } = renderWithProviders(
      <MarkdownView rehypePlugins={[rehypeSourceLines]}>
        {markdown}
      </MarkdownView>,
    );
    await waitFor(() => {
      expect(container.querySelector(".markdown-body")).not.toBeNull();
    });
    return container;
  }

  it("opens from its button or the picture, with nothing to page", async () => {
    const container = await mount(fence(NEW));
    await waitFor(() => {
      expect(container.querySelector(".mermaid-diagram svg")).not.toBeNull();
    });
    const opens = screen.getAllByRole("button", { name: "Open in the viewer" });
    expect(opens).toHaveLength(2);
    fireEvent.click(opens[1] as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    expect(heading(dialog)).toBe("flow.mmd");
    expect(within(dialog).getByTestId("diagram-canvas")).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Copy source" }),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/\d+ \/ \d+/)).toBeNull();
  });

  it("has no viewer for a diagram that does not parse", async () => {
    await mount(fence("not a diagram"));
    expect(await screen.findByText("No diagram type detected")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Open in the viewer" }),
    ).toBeNull();
  });
});
