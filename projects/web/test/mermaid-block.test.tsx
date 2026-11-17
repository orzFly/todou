import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { errorSummary, viewBoxSize } from "../src/lib/mermaid.ts";
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

// mermaid itself cannot lay anything out under happy-dom (no getBBox), so the
// renderer is the seam: these cases pin what the block does with each answer.
type Result =
  | { ok: true; svg: string; width: number; height: number }
  | { ok: false; error: string };
const render = vi.hoisted(() => ({
  next: { ok: true, svg: "", width: 0, height: 0 } as Result,
  // Answers by source, for a comparison whose two sides differ.
  bySource: new Map<string, Result>(),
}));
const renderDiagram = vi.hoisted(() =>
  vi.fn(async (source: string) => render.bySource.get(source) ?? render.next),
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
  render.bySource.clear();
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
    render.next = { ok: true, svg: SVG, width: 1360, height: 164 };
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

  it("keeps its toolbar up once drawn, and copies the source (T-706)", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    try {
      render.next = { ok: true, svg: SVG, width: 1360, height: 164 };
      const container = await mount(FENCE);
      await waitFor(() => {
        expect(container.querySelector(".mermaid-diagram svg")).not.toBeNull();
      });
      const tools = container.querySelector(".fence-tools");
      expect(tools?.hasAttribute("data-always")).toBe(true);
      expect(
        within(tools as HTMLElement).getByRole("button", { name: "Source" }),
      ).toBeTruthy();
      expect(container.querySelectorAll(".fence-frame")).toHaveLength(1);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      });
      expect(writeText).toHaveBeenCalledWith(DIAGRAM);
    } finally {
      vi.unstubAllGlobals();
    }
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
    render.next = { ok: true, svg: SVG, width: 1360, height: 164 };
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

  it("leaves other fences as code", async () => {
    await mount("```ts\nconst x = 1;\n```\n");
    expect((await screen.findByTestId("code")).textContent).toContain(
      "const x = 1;",
    );
    expect(renderDiagram).not.toHaveBeenCalled();
  });
});

describe("changed diagrams in a compare view (T-724)", () => {
  const OLD = "flowchart LR\n  A[旧]";
  const OLD_SVG =
    '<svg id="mermaid-2" viewBox="0 0 552 328"><text>旧</text></svg>';
  const PARSE_ERROR =
    "Parse error on line 2:\n...\n---^\nExpecting 'SQE', got 'PS'";
  const compare = () => mount(FENCE, new Map([[1, OLD]]));
  const drawn = (container: HTMLElement) =>
    container.querySelectorAll(".mermaid-compare-diagram svg");

  beforeEach(() => {
    render.bySource.set(OLD, {
      ok: true,
      svg: OLD_SVG,
      width: 552,
      height: 328,
    });
    render.next = { ok: true, svg: SVG, width: 1360, height: 164 };
  });

  it("draws both versions side by side, and copies the new source", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    try {
      const container = await compare();
      await waitFor(() => expect(drawn(container)).toHaveLength(2));
      expect(renderDiagram.mock.calls.map(([source]) => source).sort()).toEqual(
        [DIAGRAM, OLD].sort(),
      );
      expect(screen.queryByTestId("fence-diff")).toBeNull();
      expect(
        container.querySelector('fieldset[aria-label="Comparison"]'),
      ).toBeNull();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      });
      expect(writeText).toHaveBeenCalledWith(DIAGRAM);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("switches to the source diff and back", async () => {
    const container = await compare();
    await waitFor(() => expect(drawn(container)).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(await screen.findByTestId("fence-diff")).toBeTruthy();
    expect(drawn(container)).toHaveLength(0);
    const back = screen.getByRole("button", { name: "Diagram" });
    expect(back.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(back);
    expect(drawn(container)).toHaveLength(2);
    expect(screen.queryByTestId("fence-diff")).toBeNull();
  });

  it("shows the side that does not parse as its error and source", async () => {
    render.bySource.set(OLD, { ok: false, error: PARSE_ERROR });
    const container = await compare();
    await waitFor(() => expect(drawn(container)).toHaveLength(1));
    const old = container.querySelector('[data-side="before"]') as HTMLElement;
    expect(
      within(old).getByText("Parse error on line 2: Expecting 'SQE', got 'PS'"),
    ).toBeTruthy();
    expect(within(old).getByTestId("code").textContent).toContain("旧");
    expect(
      container.querySelector('[data-side="after"] .mermaid-compare-diagram'),
    ).not.toBeNull();
  });

  it("is the source diff with the error under it when neither parses", async () => {
    render.bySource.set(OLD, { ok: false, error: PARSE_ERROR });
    render.next = { ok: false, error: "No diagram type detected" };
    const container = await compare();
    expect(await screen.findByText("No diagram type detected")).toBeTruthy();
    expect(screen.getByTestId("fence-diff")).toBeTruthy();
    expect(drawn(container)).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Source" })).toBeNull();
  });

  it("is the source diff until both renders are back", async () => {
    renderDiagram.mockImplementation(() => new Promise(() => {}));
    try {
      const container = await compare();
      expect(await screen.findByTestId("fence-diff")).toBeTruthy();
      expect(drawn(container)).toHaveLength(0);
      expect(screen.queryByRole("button", { name: "Source" })).toBeNull();
    } finally {
      renderDiagram.mockImplementation(
        async (source: string) => render.bySource.get(source) ?? render.next,
      );
    }
  });

  it("keeps the fence's diff class and source-line stamp", async () => {
    const container = await compare();
    await waitFor(() => expect(drawn(container)).toHaveLength(2));
    const fence = container.querySelector(".markdown-fence");
    expect(fence?.classList.contains("spec-fence-diff")).toBe(true);
    expect(fence?.getAttribute("data-loc")).toBe("1-4");
  });
});

describe("mermaid helpers", () => {
  it("reads the natural size off the viewBox", () => {
    expect(viewBoxSize('<svg viewBox="4 4 1360.5 164">')).toEqual({
      width: 1360.5,
      height: 164,
    });
    expect(viewBoxSize("<svg>")).toEqual({ width: 0, height: 0 });
  });

  it("keeps a single-line error as it is", () => {
    expect(errorSummary("No diagram type detected")).toBe(
      "No diagram type detected",
    );
  });
});
