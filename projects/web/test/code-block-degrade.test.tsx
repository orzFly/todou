import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeBlock, CodeDiffBlock } from "../src/components/shared/pierre.tsx";

const STACK = "InternalError: too much recursion\n  at regexConstructor@bundle";

// The suite drives one mock through four postures, so the factory reads the
// mode at render time rather than capturing it.
const mock = vi.hoisted(() => ({
  mode: "ready" as "ready" | "pending" | "paints-error" | "throws",
}));

/**
 * Stands in for pierre closely enough for both lifecycle signals: each
 * surface owns a shadow root, then onPostRender runs with either no line, a
 * rendered line, or pierre's error wrapper inside it.
 */
vi.mock("@pierre/diffs/react", () => {
  type Options = {
    onPostRender?: (
      node: HTMLElement,
      instance: unknown,
      phase: string,
    ) => void;
  };
  const renderShadow = (node: HTMLDivElement | null, options: Options) => {
    if (node === null) return;
    const inner = document.createElement("diffs-container");
    node.appendChild(inner);
    const shadow = inner.attachShadow({ mode: "open" });
    if (mock.mode === "paints-error") {
      const wrapper = document.createElement("div");
      wrapper.dataset.errorWrapper = "";
      const stack = document.createElement("pre");
      stack.dataset.errorStack = "";
      stack.textContent = STACK;
      wrapper.appendChild(stack);
      shadow.appendChild(wrapper);
    } else if (mock.mode === "ready") {
      const line = document.createElement("div");
      line.dataset.line = "1";
      shadow.appendChild(line);
    }
    options.onPostRender?.(inner, {}, "mount");
  };
  return {
    CodeView: ({
      items,
      options,
      containerRef,
    }: {
      items: Array<{ file: { contents: string } }>;
      options: Options;
      containerRef?: (node: HTMLDivElement | null) => void;
    }) => {
      if (mock.mode === "throws") throw new Error("chunk boom");
      const attach = (node: HTMLDivElement | null) => {
        containerRef?.(node);
        renderShadow(node, options);
      };
      return (
        <div ref={attach} data-testid="code-view">
          {items.map((item) => item.file.contents).join("\n")}
        </div>
      );
    },
    MultiFileDiff: ({
      newFile,
      options,
    }: {
      newFile: { contents: string };
      options: Options;
    }) => (
      <div ref={(node) => renderShadow(node, options)} data-testid="fence-diff">
        {newFile.contents}
      </div>
    ),
  };
});

/** Text as the reader can reach it, shadow roots included. */
function deepText(root: Element | DocumentFragment): string {
  const parts = [root.textContent ?? ""];
  for (const el of root.querySelectorAll("*")) {
    if (el.shadowRoot !== null) parts.push(deepText(el.shadowRoot));
  }
  return parts.join("\n");
}

afterEach(() => {
  mock.mode = "ready";
  vi.restoreAllMocks();
});

const TS_SNIPPET = "/** 取消，返回上一层… */\nexport function cancel(): void;";

describe("CodeBlock highlighting failures", () => {
  it("renders the code through CodeView when highlighting works", async () => {
    render(<CodeBlock filename="snippet.ts" contents={TS_SNIPPET} />);
    const view = await screen.findByTestId("code-view");
    expect(view.textContent).toContain("cancel");
  });
  it("keeps readable plain text while pierre has rendered no lines", async () => {
    mock.mode = "pending";
    const { container } = render(
      <CodeBlock filename="snippet.ts" contents={TS_SNIPPET} />,
    );
    const view = await screen.findByTestId("code-view");
    expect(container.querySelector("pre code")?.textContent).toBe(TS_SNIPPET);
    expect(view.parentElement?.style.visibility).toBe("hidden");
  });

  it("removes the fallback and reveals CodeView after its first line", async () => {
    const { container } = render(
      <CodeBlock filename="snippet.ts" contents={TS_SNIPPET} />,
    );
    const view = await screen.findByTestId("code-view");
    await waitFor(() => {
      expect(container.querySelector("pre code")).toBeNull();
    });
    expect(view.parentElement?.style.visibility).toBe("");
  });

  it("does not leave an empty fence waiting for a line", async () => {
    mock.mode = "pending";
    const { container } = render(
      <CodeBlock filename="snippet.txt" contents="" />,
    );
    const view = await screen.findByTestId("code-view");
    expect(container.querySelector("pre code")).toBeNull();
    expect(view.parentElement?.style.visibility).toBe("");
  });

  it("keeps a fence diff readable until pierre renders its first line", async () => {
    mock.mode = "pending";
    const { container, rerender } = render(
      <CodeDiffBlock filename="snippet.ts" before="old" after="new" />,
    );
    expect(container.querySelector("pre code")?.textContent).toBe("new");
    expect(
      (await screen.findByTestId("fence-diff")).parentElement?.style.visibility,
    ).toBe("hidden");

    mock.mode = "ready";
    rerender(
      <CodeDiffBlock filename="snippet.ts" before="old" after="newer" />,
    );
    await waitFor(() => {
      expect(container.querySelector("pre code")).toBeNull();
    });
    expect(
      screen.getByTestId("fence-diff").parentElement?.style.visibility,
    ).toBe("");
  });

  it("swaps in plain text when pierre paints an error into the shadow root", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mock.mode = "paints-error";
    const { container } = render(
      <CodeBlock filename="snippet.ts" contents={TS_SNIPPET} />,
    );
    await waitFor(() => {
      expect(screen.queryByTestId("code-view")).toBeNull();
    });
    expect(container.querySelector("pre code")?.textContent).toBe(TS_SNIPPET);
    expect(deepText(document.body)).not.toContain("too much recursion");
    expect(deepText(document.body)).not.toContain("regexConstructor");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("snippet.ts");
  });

  it("falls back to plain text when CodeView throws outright", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mock.mode = "throws";
    const { container } = render(
      <CodeBlock filename="snippet.ts" contents={TS_SNIPPET} />,
    );
    await waitFor(() => {
      expect(container.querySelector("pre code")?.textContent).toBe(TS_SNIPPET);
    });
    expect(screen.queryByTestId("code-view")).toBeNull();
    expect(deepText(document.body)).not.toContain("chunk boom");
    expect(warn).toHaveBeenCalled();
  });
});
