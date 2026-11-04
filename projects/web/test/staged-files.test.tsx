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
      /^ !\[image-\d{8}-\d{6}-[0-9a-f]{4}\.png\]\(staged:\d+-[a-z0-9]{4}\) $/,
    );
    expect(screen.getByRole("img").getAttribute("title")).toMatch(
      /^image-\d{8}-\d{6}-[0-9a-f]{4}\.png$/,
    );
  });

  it("leaves the same file alone when it is dropped", () => {
    const mounted = mountStaging();
    dropFiles(mounted, image("image.png"));
    expect(mounted.text()).toMatch(
      /^ !\[image\.png\]\(staged:\d+-[a-z0-9]{4}\) $/,
    );
    expect(screen.getByTitle("image.png")).toBeTruthy();
  });

  it("leaves the same file alone when it comes from the file picker", () => {
    const mounted = mountStaging();
    act(() => {
      mounted.hook().stage([image("image.png")]);
    });
    expect(mounted.text()).toMatch(
      /^ !\[image\.png\]\(staged:\d+-[a-z0-9]{4}\) $/,
    );
    expect(screen.getByTitle("image.png")).toBeTruthy();
  });

  it("leaves a pasted file that carries a real name alone", () => {
    const mounted = mountStaging();
    pasteFiles(mounted, image("report.png"));
    expect(mounted.text()).toMatch(
      /^ !\[report\.png\]\(staged:\d+-[a-z0-9]{4}\) $/,
    );
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

    expect(sent).toBe(` [shot-813.png](${settled.url}) `);
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
      /^before !\[shot\.png\]\(staged:\d+-[a-z0-9]{4}\) {2}after$/,
    );
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("replaces the selected text", () => {
    const mounted = mountStaging({ initialValue: "see HERE now" });
    select(mounted, 4, 8);
    pasteFiles(mounted, image("shot.png"));
    expect(mounted.text()).toMatch(
      /^see {2}!\[shot\.png\]\(staged:\d+-[a-z0-9]{4}\) {2}now$/,
    );
  });

  it("takes a dropped file without CodeMirror reading it in as text", async () => {
    const mounted = mountStaging();
    const event = dropFiles(
      mounted,
      new File(["file body"], "notes.txt", { type: "text/plain" }),
    );
    expect(event.defaultPrevented).toBe(true);
    expect(mounted.text()).toMatch(
      /^ \[notes\.txt\]\(staged:\d+-[a-z0-9]{4}\) $/,
    );
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
    expect(mounted.text()).toMatch(
      /^one !\[shot\.png\]\(staged:\d+-[a-z0-9]{4}\) {2}two$/,
    );
  });

  it("attaches at the end when only autoFocus put the caret anywhere", () => {
    const mounted = mountStaging({ initialValue: "one two", autoFocus: true });
    act(() => {
      mounted.hook().stage([image("shot.png")]);
    });
    expect(mounted.text()).toMatch(
      /^one two !\[shot\.png\]\(staged:\d+-[a-z0-9]{4}\) $/,
    );
  });
});

describe("the text is the record of what is staged", () => {
  it("counts each editor's files from 1, under keys of their own", () => {
    const one = mountStaging();
    const two = mountStaging();
    act(() => {
      one.hook().stage([image("a.png"), image("b.png")]);
      two.hook().stage([image("c.png")]);
    });
    const keys = (mounted: MountedStaging) =>
      mounted.hook().staged.map((item) => item.key);
    expect(keys(one).map((key) => key.split("-")[0])).toEqual(["1", "2"]);
    expect(keys(two).map((key) => key.split("-")[0])).toEqual(["1"]);
    expect(keys(two)[0]).not.toBe(keys(one)[0]);
  });

  it("counts on past what the editor still holds when its text is sent", () => {
    const mounted = mountStaging({ initialValue: "![x](staged:1-zzzz)" });
    act(() => {
      mounted.hook().clear();
    });
    act(() => {
      mounted.hook().stage([image("shot.png")]);
    });
    expect(mounted.hook().staged[0]?.key).toMatch(/^2-/);
  });

  it("counts from 1 again for the next text once one is sent", () => {
    const mounted = mountStaging();
    act(() => {
      mounted.hook().stage([image("a.png"), image("b.png")]);
    });
    act(() => {
      mounted
        .cm()
        .dispatch({ changes: { from: 0, to: mounted.text().length } });
      mounted.hook().clear();
    });
    act(() => {
      mounted.hook().stage([image("c.png")]);
    });
    expect(mounted.hook().staged[0]?.key).toMatch(/^1-/);
  });

  it("does not count on from a number nobody could have counted to", () => {
    const mounted = mountStaging({
      initialValue: "![x](staged:1000000000000000000000-zzzz)",
    });
    act(() => {
      mounted.hook().stage([image("shot.png")]);
    });
    expect(mounted.hook().staged[0]?.key).toMatch(/^1-[a-z0-9]{4}$/);
  });

  it("never gives two editors on the page the same key", () => {
    const one = mountStaging();
    const two = mountStaging();
    // Every draw gives the same tag, so the second editor's first one is
    // the first editor's.
    vi.spyOn(Math, "random").mockReturnValue(0.123456789);
    act(() => {
      one.hook().stage([image("a.png")]);
      two.hook().stage([image("b.png")]);
    });
    expect(two.hook().staged[0]?.key).not.toBe(one.hook().staged[0]?.key);
  });

  it("numbers a new file past every number its text already holds", () => {
    const mounted = mountStaging({ initialValue: "![old](staged:5-zzzz)" });
    act(() => {
      mounted.hook().stage([image("shot.png")]);
    });
    expect(mounted.hook().staged.map((item) => item.key)).toEqual([
      expect.stringMatching(/^6-[a-z0-9]{4}$/),
    ]);
    expect(mounted.text()).toMatch(/^!\[old\]\(staged:5-zzzz\) /);
  });

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
    expect(sent).toBe(`x ![kept.png](${stored(813, "kept.png").url})  y`);
  });

  it("leaves a staged: link it does not know as text", async () => {
    const upload = vi.spyOn(api, "uploadAttachment");
    const mounted = mountStaging({ initialValue: "![x](staged:1-zzzz)" });
    let sent = "";
    await act(async () => {
      sent = await mounted.hook().resolve(mounted.text(), "p", 1);
    });
    expect(sent).toBe("![x](staged:1-zzzz)");
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
    const token = mounted.text().trim();
    act(() => {
      mounted.cm().dispatch({
        changes: { from: token.length + 2, insert: `\n\nagain ${token} ` },
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
      mounted.cm().dispatch({ changes: { from: 0, to: token.length + 2 } });
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
    expect(sent).toBe(` ${marker} \n\nagain ${marker} `);
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

  it("opens a staged file in a new tab only inside a sandboxed page", async () => {
    // Every object URL made, with what it was made from.
    const made = new Map<string, Blob>();
    const create = URL.createObjectURL.bind(URL);
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      const url = create(blob);
      made.set(url, blob as Blob);
      return url;
    });
    const urlOf = (name: string) =>
      [...made].find(
        ([, blob]) => blob instanceof File && blob.name === name,
      )?.[0];

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
    expect(within(dialog).getByText("Download")).toBeTruthy();

    for (const name of ["page.html", "shot.png", "transform.xsl"]) {
      expect(within(dialog).getByRole("heading").textContent).toBe(name);
      const href =
        within(dialog).getByText("Open in new tab").closest("a")?.href ?? "";
      const file = urlOf(name);
      expect(href).not.toBe(file);
      const page = await made.get(href)?.text();
      expect(page).toContain(`<iframe sandbox="allow-scripts"`);
      expect(page).toContain(`src="${file}"`);
      fireEvent.click(
        within(dialog).getByRole("button", { name: "next attachment" }),
      );
    }
  });

  it("ignores a tray item dragged in from another tab", () => {
    const mounted = mountStaging({ initialValue: "text" });
    const event = trayDrop({
      [STAGED_TOKEN_TYPE]: JSON.stringify({
        page: "another-tab",
        key: "1-zzzz",
      }),
    });
    act(() => {
      mounted.cm().contentDOM.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(mounted.text()).toBe("text");
  });

  it("places its own tray item once more where it is dropped", () => {
    const mounted = mountStaging();
    pasteFiles(mounted, image("shot.png"));
    const token = mounted.text();
    const data = dragOut(screen.getByRole("button", { name: "view shot.png" }));
    act(() => {
      mounted.cm().contentDOM.dispatchEvent(trayDrop(data));
    });
    // happy-dom's drop point is 0: in front of the first, with spaces of
    // its own like any file placed.
    expect(mounted.text()).toBe(`${token}${token}`);
    expect(screen.getAllByTitle("shot.png")).toHaveLength(1);
  });

  it("re-drops its own tray item past code, not inside it", () => {
    const mounted = mountStaging({ initialValue: "see `code` here" });
    act(() => {
      mounted.hook().stage([image("shot.png")]);
    });
    const token = mounted.hook().staged[0]?.token ?? "";
    expect(mounted.text()).toBe(`see \`code\` here ${token} `);
    const data = dragOut(screen.getByRole("button", { name: "view shot.png" }));
    // Dropped between `co` and `de`.
    vi.spyOn(mounted.cm(), "posAtCoords").mockReturnValue("see `co".length);
    act(() => {
      mounted.cm().contentDOM.dispatchEvent(trayDrop(data));
    });
    expect(mounted.text()).toBe(`see \`code\` ${token}  here ${token} `);
  });

  it("takes over a file dragged in from another editor on the page", () => {
    const from = mountStaging();
    const to = mountStaging();
    const file = image("shot.png");
    act(() => {
      from.hook().stage([file]);
    });
    const data = dragOut(screen.getByRole("button", { name: "view shot.png" }));
    act(() => {
      to.cm().contentDOM.dispatchEvent(trayDrop(data));
    });
    expect(to.hook().staged.map((item) => item.file)).toEqual([file]);
    expect(to.hook().staged[0]?.key).not.toBe(from.hook().staged[0]?.key);
    expect(to.text()).toBe(` ${to.hook().staged[0]?.token} `);
  });

  it("drags a thumbnail out as its page and number, with no text", () => {
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
    expect([...data.keys()]).toEqual([STAGED_TOKEN_TYPE]);
    expect(JSON.parse(data.get(STAGED_TOKEN_TYPE) ?? "")).toEqual({
      page: expect.any(String),
      key: mounted.hook().staged[0]?.key,
    });
    expect(dataTransfer.effectAllowed).toBe("copy");
  });
});

/** What dragging `element` out of a tray puts in its dataTransfer. */
function dragOut(element: Element): Record<string, string> {
  const data: Record<string, string> = {};
  const event = new Event("dragstart", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      setData: (type: string, value: string) => {
        data[type] = value;
      },
      effectAllowed: "all",
    },
  });
  act(() => {
    element.dispatchEvent(event);
  });
  return data;
}

/** A drop carrying `data` and no files. */
function trayDrop(data: Record<string, string>): Event {
  const event = new MouseEvent("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types: Object.keys(data),
      files: [],
      getData: (type: string) => data[type] ?? "",
    },
  });
  return event;
}
