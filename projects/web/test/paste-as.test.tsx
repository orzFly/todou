import { undo } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import { act, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  type FileClipboardEvent,
  MarkdownEditor,
} from "../src/components/shared/markdown-editor.tsx";
import { prefetchPasteConverter } from "../src/lib/paste/load.ts";
import { cmGetValue, cmPressKey, cmView } from "./cm.ts";

const loader = vi.hoisted(() => ({ blocked: false }));
vi.mock("../src/lib/paste/load.ts", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../src/lib/paste/load.ts")>();
  return {
    ...real,
    pasteConverter: () => (loader.blocked ? null : real.pasteConverter()),
  };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const { toast } = await import("sonner");

beforeAll(async () => {
  await prefetchPasteConverter();
});

afterEach(() => {
  loader.blocked = false;
  vi.unstubAllGlobals();
  vi.mocked(toast.error).mockClear();
});

/** Clipboard types to their data, plus `files` for what a paste carries as files. */
type Clip = Record<string, string | File[]>;

function clipboardData(clip: Clip) {
  const { files = [], ...data } = clip;
  const list = Array.isArray(files) ? files : [];
  return {
    types: [...Object.keys(data), ...(list.length > 0 ? ["Files"] : [])],
    files: list,
    getData: (type: string) => {
      const value = data[type];
      return typeof value === "string" ? value : "";
    },
  };
}

/** A paste event as the browser raises it on the contenteditable. */
function paste(root: ParentNode, clip: Clip): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: clipboardData(clip) });
  act(() => {
    cmView(root).contentDOM.dispatchEvent(event);
  });
  return event;
}

/** Keys CodeMirror resolves through keyCode as well as key. */
function press(
  root: ParentNode,
  key: string,
  keyCode: number,
  modifiers: { ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean },
) {
  const event = new KeyboardEvent("keydown", {
    key,
    keyCode,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  } as KeyboardEventInit);
  act(() => {
    cmView(root).contentDOM.dispatchEvent(event);
  });
  return event;
}

function place(root: ParentNode, doc: string, at = doc.length) {
  const view = cmView(root);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: doc },
    selection: { anchor: at },
  });
}

function toolbar(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>('[role="toolbar"]');
}

function button(root: ParentNode, name: string): HTMLButtonElement {
  const found = [
    ...(toolbar(root)?.querySelectorAll<HTMLButtonElement>("button") ?? []),
  ].find((b) => b.textContent === name && !b.hidden);
  if (found === undefined) throw new Error(`no visible ${name} button`);
  return found;
}

const PAGE = {
  "text/plain": "See the guide first.\n\nThen run it.",
  "text/html":
    '<!--StartFragment--><p>See <a href="https://example.com/a">the guide</a> first.</p><p>Then run it.</p><!--EndFragment-->',
};
const PAGE_MD = "See [the guide](https://example.com/a) first.\n\nThen run it.";

const VSCODE = {
  "text/plain": "const a = 1;\nconst b = 2;",
  "text/html":
    '<div style="white-space: pre;"><div><span>const a = 1;</span></div><div><span>const b = 2;</span></div></div>',
  "vscode-editor-data": JSON.stringify({ version: 1, mode: "typescript" }),
};

describe("paste as Markdown", () => {
  it("turns formatted HTML into Markdown by default", () => {
    const view = render(<MarkdownEditor />);
    const event = paste(view.container, PAGE);
    expect(event.defaultPrevented).toBe(true);
    expect(cmGetValue(view.container)).toBe(PAGE_MD);
  });

  it("pastes exactly the plain text after Mod-Shift-V", () => {
    const view = render(<MarkdownEditor />);
    const key = press(view.container, "V", 86, {
      ctrlKey: true,
      shiftKey: true,
    });
    // The browser's own paste has to follow; the key is only noted.
    expect(key.defaultPrevented).toBe(false);
    paste(view.container, PAGE);
    expect(cmGetValue(view.container)).toBe(PAGE["text/plain"]);
  });

  it("keeps code from an editor as plain text, with a fence on offer", () => {
    const view = render(<MarkdownEditor />);
    paste(view.container, VSCODE);
    expect(cmGetValue(view.container)).toBe(VSCODE["text/plain"]);
    act(() => button(view.container, "Markdown").click());
    expect(cmGetValue(view.container)).toBe(
      "```typescript\nconst a = 1;\nconst b = 2;\n```",
    );
  });

  it("leaves a paste the staged-files handler took as files alone", () => {
    const onPaste = vi.fn((event: FileClipboardEvent) =>
      event.preventDefault(),
    );
    const view = render(<MarkdownEditor onPaste={onPaste} />);
    place(view.container, "draft");
    paste(view.container, {
      "text/html": '<img src="https://example.com/a.png">',
      files: [new File(["x"], "image.png", { type: "image/png" })],
    });
    expect(onPaste).toHaveBeenCalledOnce();
    expect(cmGetValue(view.container)).toBe("draft");
    expect(toolbar(view.container)).toBeNull();
  });

  it("pastes plain text while the converter is still loading", () => {
    loader.blocked = true;
    const view = render(<MarkdownEditor />);
    paste(view.container, PAGE);
    expect(cmGetValue(view.container)).toBe(PAGE["text/plain"]);
    expect(button(view.container, "Quote")).toBeDefined();
    expect(() => button(view.container, "Markdown")).toThrow();
  });

  it("keeps a one-line heading inline in the middle of a sentence", () => {
    const view = render(<MarkdownEditor />);
    place(view.container, "Read  today", 5);
    paste(view.container, {
      "text/plain": "Release notes",
      "text/html": "<h1>Release notes</h1>",
    });
    expect(cmGetValue(view.container)).toBe("Read Release notes today");
    expect(toolbar(view.container)).toBeNull();
  });
});

describe("block spacing", () => {
  it("sets a block off from the text on both sides of a mid-line paste", () => {
    const view = render(<MarkdownEditor />);
    place(view.container, "before after", 7);
    paste(view.container, PAGE);
    expect(cmGetValue(view.container)).toBe(`before \n\n${PAGE_MD}\n\nafter`);
  });

  it("leaves a blank line before a non-empty next line", () => {
    const view = render(<MarkdownEditor />);
    place(view.container, "\nnext", 0);
    paste(view.container, PAGE);
    expect(cmGetValue(view.container)).toBe(`${PAGE_MD}\n\nnext`);
  });

  it("never spaces plain text", () => {
    const view = render(<MarkdownEditor />);
    place(view.container, "before after", 7);
    paste(view.container, { "text/plain": "one\ntwo" });
    expect(cmGetValue(view.container)).toBe("before one\ntwoafter");
  });
});

describe("paste toolbar", () => {
  it("appears for a multi-line or formatted paste, not a single plain line", () => {
    const view = render(<MarkdownEditor />);
    paste(view.container, { "text/plain": "one line" });
    expect(toolbar(view.container)).toBeNull();
    paste(view.container, { "text/plain": "\ntwo\nlines" });
    expect(toolbar(view.container)?.getAttribute("aria-label")).toBe(
      "Paste options",
    );
  });

  it("replaces the whole paste on each switch, one undo step each", () => {
    const view = render(<MarkdownEditor />);
    place(view.container, "intro\n", 6);
    paste(view.container, PAGE);
    expect(cmGetValue(view.container)).toBe(`intro\n\n${PAGE_MD}`);

    act(() => button(view.container, "Plain text").click());
    expect(cmGetValue(view.container)).toBe(`intro\n${PAGE["text/plain"]}`);
    expect(
      button(view.container, "Plain text").getAttribute("aria-pressed"),
    ).toBe("true");

    act(() => button(view.container, "Quote").click());
    expect(cmGetValue(view.container)).toBe(
      "intro\n\n> See the guide first.\n>\n> Then run it.",
    );
    expect(button(view.container, "Quote").getAttribute("aria-pressed")).toBe(
      "true",
    );

    const editor = cmView(view.container);
    act(() => {
      undo(editor);
    });
    expect(cmGetValue(view.container)).toBe(`intro\n${PAGE["text/plain"]}`);
    act(() => {
      undo(editor);
    });
    expect(cmGetValue(view.container)).toBe(`intro\n\n${PAGE_MD}`);
    act(() => {
      undo(editor);
    });
    expect(cmGetValue(view.container)).toBe("intro\n");
  });

  it("goes away on typing, and on a caret moved out of the paste", () => {
    const view = render(<MarkdownEditor />);
    paste(view.container, PAGE);
    expect(toolbar(view.container)).not.toBeNull();
    act(() => {
      cmView(view.container).dispatch({
        changes: { from: 0, insert: "x" },
        userEvent: "input.type",
      });
    });
    expect(toolbar(view.container)).toBeNull();

    place(view.container, "head ");
    paste(view.container, PAGE);
    expect(toolbar(view.container)).not.toBeNull();
    act(() => {
      cmView(view.container).dispatch({ selection: { anchor: 1 } });
    });
    expect(toolbar(view.container)).toBeNull();
  });

  it("takes Escape only while it is showing", () => {
    const onCancel = vi.fn();
    const view = render(<MarkdownEditor onCancel={onCancel} />);
    paste(view.container, PAGE);
    act(() => {
      cmPressKey(view.container, "Escape");
    });
    expect(onCancel).not.toHaveBeenCalled();
    expect(toolbar(view.container)).toBeNull();
    act(() => {
      cmPressKey(view.container, "Escape");
    });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("is reachable from the keyboard with Mod-. and back again", () => {
    const view = render(<MarkdownEditor />);
    paste(view.container, PAGE);
    press(view.container, ".", 190, { ctrlKey: true });
    const markdown = button(view.container, "Markdown");
    expect(document.activeElement).toBe(markdown);
    expect(markdown.tabIndex).toBe(0);

    act(() => {
      markdown.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(button(view.container, "Quote"));

    act(() => {
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    const editor = cmView(view.container);
    expect(document.activeElement).toBe(editor.contentDOM);
    expect(editor.state.selection.main.head).toBe(PAGE_MD.length);
    expect(toolbar(view.container)).not.toBeNull();
  });
});

describe("Mod-Alt-V", () => {
  function stubClipboard(read: () => Promise<ClipboardItem[]>) {
    vi.stubGlobal("navigator", {
      platform: "Linux x86_64",
      userAgent: navigator.userAgent,
      clipboard: { read, readText: async () => "" },
    });
  }

  function item(data: Record<string, string>) {
    return {
      types: Object.keys(data),
      getType: async (type: string) => new Blob([data[type] ?? ""]),
    } as unknown as ClipboardItem;
  }

  it("reads the clipboard itself and pastes it as a quote", async () => {
    stubClipboard(async () => [item(PAGE)]);
    const view = render(<MarkdownEditor />);
    const key = press(view.container, "v", 86, { ctrlKey: true, altKey: true });
    expect(key.defaultPrevented).toBe(true);
    await act(async () => {});
    await vi.waitFor(() =>
      expect(cmGetValue(view.container)).toBe(
        "> See [the guide](https://example.com/a) first.\n>\n> Then run it.",
      ),
    );
  });

  it("quotes the plain text with Shift", async () => {
    stubClipboard(async () => [item(PAGE)]);
    const view = render(<MarkdownEditor />);
    press(view.container, "V", 86, {
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
    });
    await vi.waitFor(() =>
      expect(cmGetValue(view.container)).toBe(
        "> See the guide first.\n>\n> Then run it.",
      ),
    );
  });

  it("says so when the clipboard cannot be read, and changes nothing", async () => {
    stubClipboard(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    const view = render(<MarkdownEditor />);
    place(view.container, "draft");
    press(view.container, "v", 86, { ctrlKey: true, altKey: true });
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
    expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toBe(
      "Can't read the clipboard here — paste with Ctrl+V, then pick Quote",
    );
    expect(cmGetValue(view.container)).toBe("draft");
  });

  it("lets a native paste that arrives first win, as a quote", async () => {
    let release: (items: ClipboardItem[]) => void = () => {};
    stubClipboard(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const view = render(<MarkdownEditor />);
    press(view.container, "v", 86, { ctrlKey: true, altKey: true });
    paste(view.container, { "text/plain": "native" });
    expect(cmGetValue(view.container)).toBe("> native");
    await act(async () => {
      release([item({ "text/plain": "late" })]);
    });
    expect(cmGetValue(view.container)).toBe("> native");
  });
});

describe("Mod-Shift-.", () => {
  it("quotes and unquotes the lines under every cursor", () => {
    const view = render(<MarkdownEditor />);
    place(view.container, "one\n\ntwo");
    const editor = cmView(view.container);
    act(() => {
      editor.dispatch({
        selection: EditorSelection.create([
          EditorSelection.cursor(1),
          EditorSelection.cursor(6),
        ]),
      });
    });
    press(view.container, ">", 190, { ctrlKey: true, shiftKey: true });
    expect(cmGetValue(view.container)).toBe("> one\n\n> two");
    press(view.container, ">", 190, { ctrlKey: true, shiftKey: true });
    expect(cmGetValue(view.container)).toBe("one\n\ntwo");
  });
});
