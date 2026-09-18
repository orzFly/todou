import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeBlock, CodeDiffBlock } from "../src/components/shared/pierre.tsx";

const STACK = "InternalError: too much recursion\n  at regexConstructor@bundle";

// The suite drives one mock through four postures and both notification
// timings, so the factory reads them at render time rather than capturing them.
const mock = vi.hoisted(() => ({
  mode: "ready" as "ready" | "pending" | "paints-error" | "throws",
  notification: "sync" as "sync" | "microtask",
}));

/**
 * Stands in for pierre closely enough for both lifecycle signals: each
 * surface owns a shadow root, then onPostRender runs with either no line,
 * rendered lines, or pierre's error wrapper inside it. A warmed diff cache
 * can render and notify synchronously from the child's ref callback.
 */
vi.mock("@pierre/diffs/react", () => {
  type Options = {
    onPostRender?: (
      node: HTMLElement,
      instance: unknown,
      phase: string,
    ) => void;
  };
  const renderShadow = (
    node: HTMLDivElement | null,
    options: Options,
    contents: string[],
  ) => {
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
      for (const [index, content] of contents.entries()) {
        const line = document.createElement("div");
        line.dataset.line = String(index + 1);
        line.textContent = content;
        shadow.appendChild(line);
      }
    }
    if (mock.notification === "microtask") {
      queueMicrotask(() => options.onPostRender?.(inner, {}, "mount"));
    } else {
      options.onPostRender?.(inner, {}, "mount");
    }
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
        renderShadow(node, options, [
          items.map((item) => item.file.contents).join("\n"),
        ]);
      };
      return (
        <div ref={attach} data-testid="code-view">
          {items.map((item) => item.file.contents).join("\n")}
        </div>
      );
    },
    MultiFileDiff: ({
      oldFile,
      newFile,
      options,
    }: {
      oldFile: { contents: string };
      newFile: { contents: string };
      options: Options;
    }) => (
      <div
        ref={(node) =>
          renderShadow(node, options, [oldFile.contents, newFile.contents])
        }
        data-testid="fence-diff"
      >
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
  mock.notification = "sync";
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

  it("reveals a synchronously rendered fence diff after a hot-cache remount", async () => {
    const before = "const oldValue = 1;";
    const after = "const newValue = 2;";
    mock.notification = "microtask";
    const view = render(
      <CodeDiffBlock
        key="cold"
        filename="snippet.ts"
        before={before}
        after={after}
      />,
    );
    await waitFor(() => {
      expect(view.container.querySelector("pre code")).toBeNull();
    });

    mock.notification = "sync";
    view.rerender(
      <CodeDiffBlock
        key="warm"
        filename="snippet.ts"
        before={before}
        after={after}
      />,
    );
    const diff = await screen.findByTestId("fence-diff");
    const host = diff.querySelector("diffs-container");
    expect(
      [...(host?.shadowRoot?.querySelectorAll("[data-line]") ?? [])].map(
        (line) => line.textContent?.trim(),
      ),
    ).toEqual([before, after]);
    await waitFor(() => {
      expect(view.container.querySelector("pre code")).toBeNull();
    });
    expect(diff.parentElement?.style.visibility).toBe("");
  });

  it("degrades a synchronously failed fence diff after a hot-cache remount", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mock.notification = "microtask";
    const view = render(
      <CodeDiffBlock
        key="cold"
        filename="snippet.ts"
        before="const oldValue = 1;"
        after="const newValue = 2;"
      />,
    );
    await waitFor(() => {
      expect(view.container.querySelector("pre code")).toBeNull();
    });

    mock.mode = "paints-error";
    mock.notification = "sync";
    view.rerender(
      <CodeDiffBlock
        key="warm"
        filename="snippet.ts"
        before="const oldValue = 1;"
        after="const newValue = 2;"
      />,
    );
    await waitFor(() => {
      expect(screen.queryByTestId("fence-diff")).toBeNull();
    });
    expect(view.container.querySelector("pre code")?.textContent).toBe(
      "const newValue = 2;",
    );
    expect(deepText(document.body)).not.toContain("too much recursion");
    expect(deepText(document.body)).not.toContain("regexConstructor");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("snippet.ts");
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
