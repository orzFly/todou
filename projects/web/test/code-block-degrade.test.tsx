import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeBlock } from "../src/components/shared/pierre.tsx";

const STACK = "InternalError: too much recursion\n  at regexConstructor@bundle";

// The suite drives one mock through three postures, so the factory reads the
// mode at render time rather than capturing it.
const mock = vi.hoisted(() => ({
  mode: "ok" as "ok" | "paints-error" | "throws",
}));

/**
 * Stands in for pierre's CodeView closely enough for the failure posture:
 * a container div handed to `containerRef`, a <diffs-container> child owning
 * the shadow root, and the error wrapper pierre's `applyErrorToDOM` appends
 * there before `emitPostRender` runs.
 */
vi.mock("@pierre/diffs/react", () => ({
  MultiFileDiff: () => null,
  CodeView: ({
    items,
    options,
    containerRef,
  }: {
    items: Array<{ file: { contents: string } }>;
    options: {
      onPostRender?: (
        node: HTMLElement,
        instance: unknown,
        phase: string,
      ) => void;
    };
    containerRef?: (node: HTMLDivElement | null) => void;
  }) => {
    if (mock.mode === "throws") throw new Error("chunk boom");
    const attach = (node: HTMLDivElement | null) => {
      containerRef?.(node);
      if (node === null || mock.mode !== "paints-error") return;
      const inner = document.createElement("diffs-container");
      node.appendChild(inner);
      const wrapper = document.createElement("div");
      wrapper.dataset.errorWrapper = "";
      const stack = document.createElement("pre");
      stack.dataset.errorStack = "";
      stack.textContent = STACK;
      wrapper.appendChild(stack);
      inner.attachShadow({ mode: "open" }).appendChild(wrapper);
      options.onPostRender?.(inner, {}, "mount");
    };
    return (
      <div ref={attach} data-testid="code-view">
        {items.map((item) => item.file.contents).join("\n")}
      </div>
    );
  },
}));

/** Text as the reader can reach it, shadow roots included. */
function deepText(root: Element | DocumentFragment): string {
  const parts = [root.textContent ?? ""];
  for (const el of root.querySelectorAll("*")) {
    if (el.shadowRoot !== null) parts.push(deepText(el.shadowRoot));
  }
  return parts.join("\n");
}

afterEach(() => {
  mock.mode = "ok";
  vi.restoreAllMocks();
});

const TS_SNIPPET = "/** 取消，返回上一层… */\nexport function cancel(): void;";

describe("CodeBlock highlighting failures", () => {
  it("renders the code through CodeView when highlighting works", async () => {
    render(<CodeBlock filename="snippet.ts" contents={TS_SNIPPET} />);
    const view = await screen.findByTestId("code-view");
    expect(view.textContent).toContain("cancel");
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
