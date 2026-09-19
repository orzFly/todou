import { setTimeout as delay } from "node:timers/promises";
import {
  type CompletionSource,
  completionStatus,
  currentCompletions,
  hasNextSnippetField,
  startCompletion,
} from "@codemirror/autocomplete";
import { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type {
  Member,
  Project,
  ReferenceConfig,
  ReferenceDirectory,
} from "@todou/shared";
import { describe, expect, it, vi } from "vitest";
import { membersQuery, projectsQuery } from "../src/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import { MarkdownEditor } from "../src/components/shared/markdown-editor.tsx";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { pendingSpaceAt } from "../src/lib/editor/completion-space.ts";
import { mentionCompletionSource } from "../src/lib/editor/mention-completion.ts";
import {
  completionWith,
  refCompletionSource,
} from "../src/lib/editor/ref-completion.ts";
import {
  cmGetValue,
  cmInput,
  cmPressKey,
  cmType,
  cmView,
  handleViewInput,
} from "./cm.ts";
import { renderWithProviders } from "./render.tsx";

vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({ items }: { items: Array<{ file: { contents: string } }> }) => (
    <pre>
      <code>{items.map((item) => item.file.contents).join("\n")}</code>
    </pre>
  ),
  MultiFileDiff: () => null,
}));

// Independent expected document: importing the production template would hide
// broken blank lines and field numbering from this assertion.
const BLOCK =
  "<details>\n<summary>\n\n标题\n\n</summary>\n\n正文\n\n</details>\n";
const settle = () => delay(200);

function editor(onCancel?: () => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(membersQuery("todou").queryKey, [
    {
      user: {
        id: 1,
        login: "alice",
        display_name: "Alice",
        kind: "human",
        avatar_url: null,
        owner: null,
      },
      role: "writer",
      owner_role: null,
      created_at: "2026-01-01T00:00:00Z",
    },
  ] satisfies Member[]);
  client.setQueryData(referenceConfigQuery("todou").queryKey, {
    format: { prefix: "T", history: [] },
    autolinks: [],
  } satisfies ReferenceConfig);
  const directory: ReferenceDirectory = { entries: [], contested: [] };
  client.setQueryData(referenceDirectoryQuery.queryKey, directory);
  client.setQueryData(projectsQuery.queryKey, [
    {
      id: 1,
      slug: "detour",
      name: "Detour",
      description: "",
      created_at: "2026-01-01T00:00:00Z",
    },
  ] satisfies Project[]);
  return render(
    <MarkdownEditor
      ariaLabel="Body"
      onCancel={onCancel}
      extensions={completionWith([
        refCompletionSource("todou", client),
        mentionCompletionSource("todou", client),
      ])}
    />,
  );
}

async function active(root: ParentNode) {
  await waitFor(() =>
    expect(completionStatus(cmView(root).state)).toBe("active"),
  );
  await settle(); // upstream typing + interaction delays
}

async function panelFor(root: ParentNode, text = "<") {
  act(() => cmType(root, text));
  await active(root);
}

function selected(root: ParentNode) {
  const { state } = cmView(root);
  const { from, to } = state.selection.main;
  return state.sliceDoc(from, to);
}

async function insertBlock(root: ParentNode, text = "<") {
  await panelFor(root, text);
  cmPressKey(root, "Tab");
}

async function preview(source: string) {
  const result = renderWithProviders(<MarkdownView>{source}</MarkdownView>);
  await waitFor(() =>
    expect(result.container.querySelector(".markdown-body")).not.toBeNull(),
  );
  return result.container;
}

describe("details completion and snippet fields", () => {
  it("inserts the exact rich-text template and traverses title, body and exit in both directions", async () => {
    const { container } = editor();
    await panelFor(container);
    expect(
      currentCompletions(cmView(container).state).map((item) => item.label),
    ).toEqual(["<details>"]);
    cmPressKey(container, "Tab");
    expect(cmGetValue(container)).toBe(BLOCK);
    expect(selected(container)).toBe("标题");
    cmPressKey(container, "Tab");
    expect(selected(container)).toBe("正文");
    cmPressKey(container, "Tab", { shiftKey: true });
    expect(selected(container)).toBe("标题");
    cmPressKey(container, "Tab");
    cmPressKey(container, "Tab");
    expect(cmView(container).state.selection.main.head).toBe(BLOCK.length);
    expect(hasNextSnippetField(cmView(container).state)).toBe(false);
    expect(cmPressKey(container, "Tab").defaultPrevented).toBe(false);
    expect(
      cmPressKey(container, "Tab", { shiftKey: true }).defaultPrevented,
    ).toBe(false);
  });

  it.each(["<details", "<DETAILS", "<details>\n<", "<details>\n\nbody\n\n<"])(
    "offers the template in HTML context %j",
    async (text) => {
      const { container } = editor();
      await panelFor(container, text);
      expect(
        currentCompletions(cmView(container).state).map((item) => item.label),
      ).toContain("<details>");
    },
  );

  it("keeps a matching project row and selects the tag first", async () => {
    const { container } = editor();
    await panelFor(container, "<det");
    const labels = currentCompletions(cmView(container).state).map(
      (item) => item.label,
    );
    expect(labels[0]).toBe("<details>");
    expect(labels).toContain("detour/");
    cmPressKey(container, "Enter");
    expect(cmGetValue(container)).toBe(BLOCK);
  });

  it("ignores boost for unfiltered sources and preserves their relative order", async () => {
    // Deliberately oppose boost and source order. An upstream switch to boost
    // must fail here even if <details> still happens to render first.
    const sources: CompletionSource[] = [-99, 99, 0].map(
      (boost, index) => (context) => ({
        from: 0,
        to: context.pos,
        filter: false,
        options: [{ label: `candidate-${index}`, boost }],
      }),
    );
    const { container } = render(
      <MarkdownEditor extensions={completionWith(sources)} />,
    );
    await panelFor(container, "candidate");
    expect(
      currentCompletions(cmView(container).state).map((item) => item.label),
    ).toEqual(["candidate-0", "candidate-1", "candidate-2"]);
  });

  it("renders Markdown in both filled fields", async () => {
    const { container } = editor();
    await insertBlock(container);
    act(() => cmInput(container, "**bold** and `code`"));
    cmPressKey(container, "Tab");
    act(() => cmInput(container, "**body**"));
    const rendered = await preview(cmGetValue(container));
    expect(rendered.querySelector("summary strong")?.textContent).toBe("bold");
    expect(rendered.querySelector("summary code")?.textContent).toBe("code");
    expect(rendered.querySelector("details > p strong")?.textContent).toBe(
      "body",
    );
  });

  it.each(["- item\n  <", "1. item\n   <", "- outer\n  - inner\n    <"])(
    "renders one fold in a list continuation %j",
    async (text) => {
      const { container } = editor();
      await insertBlock(container, text);
      const rendered = await preview(cmGetValue(container));
      expect(rendered.querySelectorAll("details")).toHaveLength(1);
      expect(rendered.querySelector("li details > p")?.textContent).toBe(
        "正文",
      );
      expect(
        rendered.querySelector("li details summary")?.textContent,
      ).toContain("标题");
    },
  );

  it("accepts a title mention before Tab moves the snippet and preserves pending-space punctuation", async () => {
    const { container } = editor();
    await insertBlock(container);
    act(() => cmInput(container, "@ali"));
    await active(container);
    cmPressKey(container, "Tab");
    expect(cmGetValue(container)).toBe(BLOCK.replace("标题", "@alice "));
    expect(pendingSpaceAt(cmView(container).state)).not.toBeNull();
    act(() => expect(cmInput(container, "，")).toBe(true));
    expect(cmGetValue(container)).toBe(BLOCK.replace("标题", "@alice，"));
    cmPressKey(container, "Tab");
    expect(selected(container)).toBe("正文");
  });

  it("still trims a pending mention space on Enter inside the template", async () => {
    const { container } = editor();
    await insertBlock(container);
    act(() => cmInput(container, "@ali"));
    await active(container);
    cmPressKey(container, "Enter");
    expect(cmGetValue(container)).toBe(BLOCK.replace("标题", "@alice "));
    cmPressKey(container, "Enter");
    expect(cmGetValue(container)).toBe(BLOCK.replace("标题", "@alice\n"));
  });

  it("spends Escape on the panel, then snippet, then the enclosing cancel action", async () => {
    const cancel = vi.fn();
    const { container } = editor(cancel);
    await insertBlock(container);
    act(() => cmInput(container, "@ali"));
    await active(container);
    cmPressKey(container, "Escape");
    expect(completionStatus(cmView(container).state)).toBeNull();
    expect(hasNextSnippetField(cmView(container).state)).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    cmPressKey(container, "Escape");
    expect(hasNextSnippetField(cmView(container).state)).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    cmPressKey(container, "Escape");
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("ordinary Markdown outside the tag trigger", () => {
  it.each([
    "```html\n<",
    "~~~\n<",
    "- item\n  ```html\n  <",
    "    <",
    "\t<",
    "<!--\n<",
    "<!-- comment\n<",
    "a < b",
    "x<",
    "a <",
    "- <",
    "> <",
    "| <",
    "\\<",
    "\u00a0<",
    "<https://example.com",
    "<HARD",
    "<details>",
  ])("leaves %j unchanged without a tag candidate", async (text) => {
    const { container } = editor();
    act(() => cmType(container, text));
    await settle();
    expect(
      currentCompletions(cmView(container).state).some(
        (item) => item.type === "tag",
      ),
    ).toBe(false);
    expect(completionStatus(cmView(container).state)).toBeNull();
    expect(cmGetValue(container)).toBe(text);
  });

  it("does not offer a template before existing line content", async () => {
    const { container } = editor();
    act(() =>
      cmView(container).dispatch({
        changes: { from: 0, insert: "<tail" },
        selection: { anchor: 1 },
        userEvent: "input.type",
      }),
    );
    await settle();
    expect(completionStatus(cmView(container).state)).toBeNull();
    expect(cmGetValue(container)).toBe("<tail");
  });

  it("closes the tag panel when ordinary HTML or an autolink continues", async () => {
    const { container } = editor();
    await panelFor(container);
    act(() => cmInput(container, "https://example.com>"));
    await settle();
    expect(completionStatus(cmView(container).state)).toBeNull();
    expect(cmGetValue(container)).toBe("<https://example.com>");
  });

  it("leaves a literal < followed by a newline after Escape", async () => {
    const { container } = editor();
    await panelFor(container);
    cmPressKey(container, "Escape");
    cmPressKey(container, "Enter");
    expect(cmGetValue(container)).toBe("<\n");
  });

  it("does not open on paste, even when the cursor is after the first <", async () => {
    const { container } = editor();
    const text = "<details>\n<summary>x</summary>\n";
    act(() =>
      cmView(container).dispatch({
        changes: { from: 0, insert: text },
        selection: { anchor: 1 },
        userEvent: "input.paste",
      }),
    );
    await settle();
    expect(completionStatus(cmView(container).state)).toBeNull();
    expect(cmGetValue(container)).toBe(text);
  });

  it("does not intercept the composing DOM input path or accept a snippet during composition", async () => {
    const { container } = editor();
    const view = cmView(container);
    fireEvent.compositionStart(view.contentDOM);
    expect(view.composing).toBe(false);
    const dispatch = vi.spyOn(view, "dispatch");
    expect(handleViewInput(view, "<")).toBe(false);
    expect(view.composing).toBe(true); // helper increment matches applyDOMChangeInner
    expect(dispatch).not.toHaveBeenCalled();
    dispatch.mockRestore();
    // This is the default DOM input transaction after handlers decline it.
    act(() =>
      view.dispatch({
        changes: { from: 0, insert: "<" },
        selection: { anchor: 1 },
        userEvent: "input.type.compose",
      }),
    );
    cmPressKey(container, "Enter");
    expect(cmGetValue(container)).toBe("<");
    fireEvent.compositionEnd(view.contentDOM);
    // After composition the ordinary source is usable; no custom IME state
    // machine or proactive snippet insertion lives in the input handler.
    act(() => startCompletion(view));
    await active(container);
    expect(currentCompletions(view.state).map((item) => item.label)).toContain(
      "<details>",
    );
  });
});
