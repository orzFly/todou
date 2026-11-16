import { screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { FENCE_COLLAPSE_LINES } from "../src/lib/fence-meta.ts";
import { rehypeSourceLines } from "../src/lib/rehype-source-lines.ts";
import { renderWithProviders } from "./render.tsx";

vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({ items }: { items: Array<{ file: { contents: string } }> }) => (
    <pre data-testid="code">
      <code>{items.map((item) => item.file.contents).join("\n")}</code>
    </pre>
  ),
  MultiFileDiff: ({ newFile }: { newFile: { contents: string } }) => (
    <pre data-testid="fence-diff">{newFile.contents}</pre>
  ),
  WorkerPoolContextProvider: ({ children }: { children: ReactNode }) =>
    children,
  useWorkerPool: () => undefined,
}));

async function mount(source: string, collapseLongFences?: boolean) {
  const { container } = renderWithProviders(
    <MarkdownView
      rehypePlugins={[rehypeSourceLines]}
      collapseLongFences={collapseLongFences}
    >
      {source}
    </MarkdownView>,
  );
  await waitFor(() => {
    expect(container.querySelector(".markdown-body")).not.toBeNull();
  });
  return container;
}

function lines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");
}

describe("fence frames (T-706)", () => {
  it("frames a fence inside its wrapper, with its language in the toolbar", async () => {
    const container = await mount("```ts\nconst a = 1;\n```\n");
    const frame = container.querySelector(".markdown-fence > .fence-frame");
    expect(frame).not.toBeNull();
    expect(
      frame?.querySelector(".fence-tools span.font-mono")?.textContent,
    ).toBe("ts");
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });

  const LONG = `\`\`\`\n${lines(FENCE_COLLAPSE_LINES + 1)}\n\`\`\`\n`;

  it(`collapses a fence of ${FENCE_COLLAPSE_LINES + 1} lines`, async () => {
    const container = await mount(LONG);
    expect(container.querySelector(".fence-scroll")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Expand" })).toBeTruthy();
  });

  it(`leaves a fence of ${FENCE_COLLAPSE_LINES} lines whole`, async () => {
    const container = await mount(
      `\`\`\`\n${lines(FENCE_COLLAPSE_LINES)}\n\`\`\`\n`,
    );
    expect(container.querySelector(".fence-scroll")).toBeNull();
    expect(screen.queryByRole("button", { name: "Expand" })).toBeNull();
  });

  it("leaves a long fence whole where collapsing is off", async () => {
    const container = await mount(LONG, false);
    expect(container.querySelector(".fence-scroll")).toBeNull();
    expect(screen.queryByRole("button", { name: "Expand" })).toBeNull();
  });

  it.each(["```yaml compose.yaml", '```yaml title="compose.yaml"'])(
    "heads %s with a download named after the file",
    async (opening) => {
      const container = await mount(`${opening}\nservices: {}\n\`\`\`\n`);
      expect(
        container.querySelector('.fence-head a[download="compose.yaml"]'),
      ).not.toBeNull();
      expect(container.querySelector(".fence-tools")).toBeNull();
    },
  );

  it("offers only Copy for a fence with no language", async () => {
    const container = await mount("```\nplain\n```\n");
    const tools = container.querySelector(".fence-tools");
    expect(tools?.querySelector("span.font-mono")).toBeNull();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });

  it("keeps the wrapper's source-line stamp and content start", async () => {
    const md = "intro\n\n```ts title=x.ts\nconst a = 1;\nconst b = 2;\n```\n";
    const container = await mount(md);
    const wrapper = container.querySelector("div.markdown-fence");
    expect(wrapper?.getAttribute("data-loc")).toBe("3-6");
    expect(wrapper?.getAttribute("data-loc-content-start")).toBe("4");
    expect(wrapper?.querySelector(".fence-head")).not.toBeNull();
  });
});
