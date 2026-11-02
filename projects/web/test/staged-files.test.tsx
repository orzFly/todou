import { undo } from "@codemirror/commands";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { Attachment } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import {
  type StagedFiles,
  useStagedFiles,
} from "../src/components/issue/staged-files.tsx";
import { MarkdownEditor } from "../src/components/shared/markdown-editor.tsx";
import { STAGED_TOKEN_TYPE } from "../src/lib/staged-tokens.ts";
import { testQueryClient } from "./render.tsx";
import {
  dropFiles,
  type MountedStaging,
  mountStaging,
  pasteFiles,
} from "./staging.tsx";

afterEach(() => {
  vi.restoreAllMocks();
});

const image = (name: string) =>
  new File(["bytes"], name, { type: "image/png" });

/** Put the caret (or a selection) where the reader would. */
function select(mounted: MountedStaging, anchor: number, head = anchor) {
  act(() => {
    mounted.cm().dispatch({ selection: { anchor, head } });
  });
}

function stored(id: number, filename: string): Attachment {
  return {
    id,
    filename,
    content_type: "image/png",
    size: 5,
    url: `/api/projects/p/attachments/${id}/download/${filename}`,
    uploader: {
      id: 1,
      login: "me",
      display_name: "Me",
      kind: "human",
      avatar_url: null,
      owner: null,
    },
    created_at: "2026-09-05T00:00:00.000Z",
    aliases: [],
  };
}

describe("staging a file names it once (T-269)", () => {
  it("renames the clipboard default on paste", () => {
    const mounted = mountStaging();
    pasteFiles(mounted, image("image.png"));
    expect(mounted.text()).toMatch(
      /^!\[image-\d{8}-\d{6}-[0-9a-f]{4}\.png\]\(staged:\d+\)$/,
    );
    expect(screen.getByRole("img").getAttribute("title")).toMatch(
      /^image-\d{8}-\d{6}-[0-9a-f]{4}\.png$/,
    );
  });

  it("leaves the same file alone when it is dropped", () => {
    const mounted = mountStaging();
    dropFiles(mounted, image("image.png"));
    expect(mounted.text()).toMatch(/^!\[image\.png\]\(staged:\d+\)$/);
    expect(screen.getByTitle("image.png")).toBeTruthy();
  });

  it("leaves the same file alone when it comes from the file picker", () => {
    const mounted = mountStaging();
    act(() => {
      mounted.hook().stage([image("image.png")]);
    });
    expect(mounted.text()).toMatch(/^!\[image\.png\]\(staged:\d+\)$/);
    expect(screen.getByTitle("image.png")).toBeTruthy();
  });

  it("leaves a pasted file that carries a real name alone", () => {
    const mounted = mountStaging();
    pasteFiles(mounted, image("report.png"));
    expect(mounted.text()).toMatch(/^!\[report\.png\]\(staged:\d+\)$/);
    expect(screen.getByTitle("report.png")).toBeTruthy();
  });

  it("shows and links the name the server settled on, not the local one", async () => {
    const settled = {
      ...stored(813, "shot-813.png"),
      content_type: "text/plain",
    };
    vi.spyOn(api, "uploadAttachment").mockResolvedValue(settled);
    const mounted = mountStaging();
    act(() => {
      mounted
        .hook()
        .stage([new File(["bytes"], "shot.png", { type: "text/plain" })]);
    });

    let sent = "";
    await act(async () => {
      sent = await mounted.hook().resolve(mounted.text(), "p", 1);
    });

    expect(sent).toBe(`[shot-813.png](${settled.url})`);
    expect(screen.getByTitle("shot-813.png")).toBeTruthy();
    expect(screen.queryByTitle("shot.png")).toBeNull();
  });
});

describe("a staged file goes where the reader put it", () => {
  it("pastes its token at the caret and adds it to the tray", () => {
    const mounted = mountStaging({ initialValue: "before after" });
    select(mounted, 6);
    pasteFiles(mounted, image("shot.png"));
    expect(mounted.text()).toMatch(
      /^before !\[shot\.png\]\(staged:\d+\) after$/,
    );
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("replaces the selected text", () => {
    const mounted = mountStaging({ initialValue: "see HERE now" });
    select(mounted, 4, 8);
    pasteFiles(mounted, image("shot.png"));
    expect(mounted.text()).toMatch(/^see !\[shot\.png\]\(staged:\d+\) now$/);
  });

  it("takes a dropped file without CodeMirror reading it in as text", async () => {
    const mounted = mountStaging();
    const event = dropFiles(
      mounted,
      new File(["file body"], "notes.txt", { type: "text/plain" }),
    );
    expect(event.defaultPrevented).toBe(true);
    expect(mounted.text()).toMatch(/^\[notes\.txt\]\(staged:\d+\)$/);
    // CodeMirror's own drop reads a file through FileReader, asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mounted.text()).not.toContain("file body");
  });

  it("attaches at the caret once the reader has pressed in the editor", () => {
    const mounted = mountStaging({ initialValue: "one two" });
    fireEvent.pointerDown(mounted.cm().contentDOM);
    select(mounted, 3);
    act(() => {
      mounted.hook().stage([image("shot.png")]);
    });
    expect(mounted.text()).toMatch(/^one !\[shot\.png\]\(staged:\d+\) two$/);
  });

  it("attaches at the end when only autoFocus put the caret anywhere", () => {
    const mounted = mountStaging({ initialValue: "one two", autoFocus: true });
    act(() => {
      mounted.hook().stage([image("shot.png")]);
    });
    expect(mounted.text()).toMatch(/^one two !\[shot\.png\]\(staged:\d+\)$/);
  });
});

describe("the text is the record of what is staged", () => {
  it("drops a file whose token was deleted, and undo brings both back", () => {
    const mounted = mountStaging();
    act(() => {
      mounted.hook().stage([image("shot.png")]);
    });
    const token = mounted.text();
    act(() => {
      mounted.cm().dispatch({
        changes: { from: 0, to: token.length },
        userEvent: "delete",
      });
    });
    expect(screen.queryByTitle("shot.png")).toBeNull();
    act(() => {
      undo(mounted.cm());
    });
    expect(mounted.text()).toBe(token);
    expect(screen.getByTitle("shot.png")).toBeTruthy();
  });

  it("takes the token out of the text when the file is removed", () => {
    const mounted = mountStaging({ initialValue: "a b" });
    select(mounted, 1);
    pasteFiles(mounted, image("shot.png"));
    fireEvent.click(screen.getByRole("button", { name: "remove shot.png" }));
    expect(mounted.text()).toBe("a b");
    expect(screen.queryByTitle("shot.png")).toBeNull();
  });

  it("uploads only the files the text places, each where its token was", async () => {
    const upload = vi
      .spyOn(api, "uploadAttachment")
      .mockResolvedValue(stored(813, "kept.png"));
    const mounted = mountStaging({ initialValue: "x y" });
    act(() => {
      mounted.hook().stage([image("gone.png")]);
    });
    act(() => {
      mounted
        .cm()
        .dispatch({ changes: { from: 0, to: mounted.text().length } });
    });
    act(() => {
      mounted.cm().dispatch({ changes: { from: 0, insert: "x y" } });
    });
    select(mounted, 1);
    pasteFiles(mounted, image("kept.png"));

    let sent = "";
    await act(async () => {
      sent = await mounted.hook().resolve(mounted.text(), "p", 1);
    });

    expect(upload).toHaveBeenCalledOnce();
    expect(upload.mock.calls[0]?.[2]?.name).toBe("kept.png");
    expect(sent).toBe(`x ![kept.png](${stored(813, "kept.png").url}) y`);
  });

  it("leaves a staged: link it does not know as text", async () => {
    const upload = vi.spyOn(api, "uploadAttachment");
    const mounted = mountStaging({ initialValue: "![x](staged:999999)" });
    let sent = "";
    await act(async () => {
      sent = await mounted.hook().resolve(mounted.text(), "p", 1);
    });
    expect(sent).toBe("![x](staged:999999)");
    expect(upload).not.toHaveBeenCalled();
  });
});

describe("an editor that is gone", () => {
  it("has no files placed in it any more", () => {
    let latest: StagedFiles | null = null;
    function Harness({ editing }: { editing: boolean }) {
      const staging = useStagedFiles();
      latest = staging;
      return editing ? <MarkdownEditor staging={staging.editor} /> : null;
    }
    const client = testQueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <Harness editing />
      </QueryClientProvider>,
    );
    view.rerender(
      <QueryClientProvider client={client}>
        <Harness editing={false} />
      </QueryClientProvider>,
    );
    const hook = () => latest as StagedFiles;
    let placed = true;
    act(() => {
      placed = hook().stage([image("shot.png")]);
    });
    expect(placed).toBe(false);
    expect(hook().staged).toEqual([]);
  });
});

describe("one file placed in several spots", () => {
  async function placedTwice() {
    const mounted = mountStaging();
    pasteFiles(mounted, image("shot.png"));
    const token = mounted.text();
    act(() => {
      mounted.cm().dispatch({
        changes: { from: token.length, insert: `\n\nagain ${token}` },
      });
    });
    return { mounted, token };
  }

  it("shows it once in the tray", async () => {
    await placedTwice();
    expect(screen.getAllByTitle("shot.png")).toHaveLength(1);
  });

  it("keeps it while one spot is left, and × takes every spot", async () => {
    const { mounted, token } = await placedTwice();
    act(() => {
      mounted.cm().dispatch({ changes: { from: 0, to: token.length } });
    });
    expect(screen.getByTitle("shot.png")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "remove shot.png" }));
    expect(mounted.text()).toBe("\n\nagain");
    expect(screen.queryByTitle("shot.png")).toBeNull();
  });

  it("uploads it once and points every spot at the upload", async () => {
    const upload = vi
      .spyOn(api, "uploadAttachment")
      .mockResolvedValue(stored(813, "shot.png"));
    const { mounted } = await placedTwice();
    let sent = "";
    await act(async () => {
      sent = await mounted.hook().resolve(mounted.text(), "p", 1);
    });
    const marker = `![shot.png](${stored(813, "shot.png").url})`;
    expect(upload).toHaveBeenCalledOnce();
    expect(sent).toBe(`${marker}\n\nagain ${marker}`);
  });
});

describe("the tray opens what the viewer can show", () => {
  it("opens an image thumbnail on its own object URL", async () => {
    const mounted = mountStaging();
    pasteFiles(mounted, image("shot.png"));
    const thumbnail = screen.getByRole("img") as HTMLImageElement;
    fireEvent.click(screen.getByRole("button", { name: "view shot.png" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading").textContent).toBe("shot.png");
    await waitFor(() =>
      expect(
        within(dialog)
          .getAllByRole("img")
          .some((img) => img.getAttribute("src") === thumbnail.src),
      ).toBe(true),
    );
  });

  it("pages between every viewable file, and offers none for a PDF", async () => {
    const mounted = mountStaging();
    act(() => {
      mounted
        .hook()
        .stage([
          image("shot.png"),
          new File(["# notes"], "notes.md", { type: "text/markdown" }),
          new File(["%PDF"], "spec.pdf", { type: "application/pdf" }),
        ]);
    });
    expect(screen.queryByRole("button", { name: "view spec.pdf" })).toBeNull();
    expect(screen.getByTitle("spec.pdf")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "view notes.md" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("2 / 2")).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "next attachment" }),
    );
    expect(within(dialog).getByText("1 / 2")).toBeTruthy();
    expect(within(dialog).getByRole("heading").textContent).toBe("shot.png");
  });

  it("opens no new tab for a staged file whose page could run script", async () => {
    const mounted = mountStaging();
    act(() => {
      mounted
        .hook()
        .stage([
          new File(["<p>hi</p>"], "page.html", { type: "text/html" }),
          image("shot.png"),
          new File(["<x/>"], "transform.xsl", { type: "text/xsl" }),
        ]);
    });
    fireEvent.click(screen.getByRole("button", { name: "view page.html" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText("Open in new tab")).toBeNull();
    expect(within(dialog).getByText("Download")).toBeTruthy();
    const next = () =>
      fireEvent.click(
        within(dialog).getByRole("button", { name: "next attachment" }),
      );
    next();
    expect(within(dialog).getByText("Open in new tab")).toBeTruthy();
    next();
    expect(within(dialog).getByRole("heading").textContent).toBe(
      "transform.xsl",
    );
    expect(within(dialog).queryByText("Open in new tab")).toBeNull();
  });

  it("refuses a token dragged in from another editor's tray", () => {
    const mounted = mountStaging({ initialValue: "text" });
    const event = new MouseEvent("drop", { bubbles: true, cancelable: true });
    const foreign = "![shot.png](staged:999999)";
    Object.defineProperty(event, "dataTransfer", {
      value: {
        types: [STAGED_TOKEN_TYPE, "text/plain"],
        files: [],
        getData: (type: string) =>
          type === STAGED_TOKEN_TYPE || type === "text/plain" ? foreign : "",
      },
    });
    act(() => {
      mounted.cm().contentDOM.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(mounted.text()).toBe("text");
  });

  it("drags a thumbnail out as its token", () => {
    const mounted = mountStaging();
    pasteFiles(mounted, image("shot.png"));
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (type: string, value: string) => data.set(type, value),
      effectAllowed: "all",
    };
    // Dispatched by hand: fireEvent copies a dataTransfer into a read-only
    // one, which would hide what the handler writes to effectAllowed.
    const event = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    act(() => {
      screen
        .getByRole("button", { name: "view shot.png" })
        .dispatchEvent(event);
    });
    expect(data.get("text/plain")).toBe(mounted.text());
    expect(data.get(STAGED_TOKEN_TYPE)).toBe(mounted.text());
    expect(dataTransfer.effectAllowed).toBe("copy");
  });
});
