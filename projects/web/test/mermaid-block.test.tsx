import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { errorSummary, viewBoxWidth } from "../src/lib/mermaid.ts";
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
}));

// mermaid itself cannot lay anything out under happy-dom (no getBBox), so the
// renderer is the seam: these cases pin what the block does with each answer.
const render = vi.hoisted(() => ({
  next: { ok: true, svg: "", width: 0 } as
    | { ok: true; svg: string; width: number }
    | { ok: false; error: string },
}));
const renderDiagram = vi.hoisted(() =>
  vi.fn(async (_source: string) => render.next),
);
vi.mock("../src/lib/mermaid.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/mermaid.ts")>()),
  renderDiagram,
}));

const SVG =
  '<svg id="mermaid-1" viewBox="0 0 1360 164"><text>游戏连接或回放</text></svg>';
const DIAGRAM = "flowchart LR\n  A[游戏连接或回放] --> B[应用级服务]";
const FENCE = `\`\`\`mermaid\n${DIAGRAM}\n\`\`\`\n`;

// beforeEach, not afterEach: resetting the theme re-renders whichever block is
// still mounted, and that call must land before the count is cleared.
beforeEach(() => {
  delete document.documentElement.dataset.theme;
  renderDiagram.mockClear();
});

async function mount(source: string, fenceBaselines?: Map<number, string>) {
  const { container } = renderWithProviders(
    <MarkdownView
      rehypePlugins={[rehypeSourceLines]}
      fenceBaselines={fenceBaselines}
    >
      {source}
    </MarkdownView>,
  );
  await waitFor(() => {
    expect(container.querySelector(".markdown-body")).not.toBeNull();
  });
  return container;
}

describe("mermaid fences (T-523)", () => {
  it("draws the diagram, with its source one toggle away", async () => {
    render.next = { ok: true, svg: SVG, width: 1360 };
    const container = await mount(FENCE);
    await waitFor(() => {
      expect(container.querySelector(".mermaid-diagram svg")).not.toBeNull();
    });
    expect(renderDiagram).toHaveBeenCalledWith(
      DIAGRAM,
      expect.anything(),
      expect.anything(),
    );
    const diagram = container.querySelector<HTMLElement>(".mermaid-diagram");
    expect(diagram?.style.getPropertyValue("--diagram-width")).toBe("1360px");
    // The source-line stamp survives the swap, so spec annotation still
    // anchors a selection inside the diagram to its fence.
    expect(diagram?.closest("[data-loc]")?.getAttribute("data-loc")).toBe(
      "1-4",
    );
    expect(screen.queryByTestId("code")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect((await screen.findByTestId("code")).textContent).toContain(
      "游戏连接或回放",
    );
    expect(container.querySelector(".mermaid-diagram")).toBeNull();
    const back = screen.getByRole("button", { name: "Diagram" });
    expect(back.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(back);
    expect(container.querySelector(".mermaid-diagram svg")).not.toBeNull();
  });

  it("keeps a diagram that does not parse as source, with the error under it", async () => {
    render.next = {
      ok: false,
      error:
        "Parse error on line 2:\n...hart LR  A[开始 --> B[[结束\n----------------------^\nExpecting 'SQE', got 'SUBROUTINESTART'",
    };
    const container = await mount(FENCE);
    expect(
      await screen.findByText(
        "Parse error on line 2: Expecting 'SQE', got 'SUBROUTINESTART'",
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("code").textContent).toContain("游戏连接或回放");
    expect(container.querySelector(".mermaid-diagram")).toBeNull();
    expect(screen.queryByRole("button", { name: "Source" })).toBeNull();
  });

  it("shows the source while the renderer is still loading", async () => {
    renderDiagram.mockImplementationOnce(() => new Promise(() => {}));
    const container = await mount(FENCE);
    expect((await screen.findByTestId("code")).textContent).toContain(
      "游戏连接或回放",
    );
    expect(container.querySelector(".mermaid-diagram")).toBeNull();
  });

  it("re-renders when the resolved theme changes", async () => {
    render.next = { ok: true, svg: SVG, width: 1360 };
    const container = await mount(FENCE);
    await waitFor(() => {
      expect(container.querySelector(".mermaid-diagram svg")).not.toBeNull();
    });
    const calls = renderDiagram.mock.calls.length;
    await act(async () => {
      document.documentElement.dataset.theme = "solarized-dark";
    });
    await waitFor(() => {
      expect(renderDiagram.mock.calls.length).toBe(calls + 1);
    });
  });

  it("leaves other fences, and changed diagrams in a compare view, as code", async () => {
    await mount("```ts\nconst x = 1;\n```\n");
    expect((await screen.findByTestId("code")).textContent).toContain(
      "const x = 1;",
    );

    const changed = await mount(FENCE, new Map([[1, "flowchart LR\n  A"]]));
    expect((await screen.findByTestId("fence-diff")).textContent).toContain(
      "游戏连接或回放",
    );
    expect(changed.querySelector(".mermaid-diagram")).toBeNull();
    expect(renderDiagram).not.toHaveBeenCalled();
  });
});

describe("mermaid helpers", () => {
  it("reads the natural width off the viewBox", () => {
    expect(viewBoxWidth('<svg viewBox="4 4 1360.5 164">')).toBe(1360.5);
    expect(viewBoxWidth("<svg>")).toBe(0);
  });

  it("keeps a single-line error as it is", () => {
    expect(errorSummary("No diagram type detected")).toBe(
      "No diagram type detected",
    );
  });
});
