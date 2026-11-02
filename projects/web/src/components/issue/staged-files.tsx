import { isolateHistory } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { useQueryClient } from "@tanstack/react-query";
import type { Attachment } from "@todou/shared";
import { FileIcon, Maximize2Icon, PaperclipIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api/queries.ts";
import { AttachmentViewerDialog } from "@/components/issue/attachment-viewer.tsx";
import type { EditorFileStaging } from "@/components/shared/markdown-editor.tsx";
import { Button } from "@/components/ui/button";
import {
  formatSize,
  isPreviewableImage,
  opensInBrowserTab,
  type PreviewTarget,
  previewKind,
} from "@/lib/attachment-preview.ts";
import { renameIfClipboardDefault } from "@/lib/pasted-filename.ts";
import {
  resolveStagedTokens,
  STAGED_TOKEN_TYPE,
  stagedKeysIn,
  stagedToken,
  stagedTokenDeletions,
  stripStagedTokens,
  tokenInsertion,
} from "@/lib/staged-tokens.ts";
import { useDirtySource } from "@/lib/unsaved-guard.ts";

export type StagedFile = {
  key: number;
  file: File;
  /** The text that placed it in the editor. */
  token: string;
  /** Object URL for what the viewer can show (image, HTML, text); else none. */
  previewUrl: string | null;
  /** The sandboxed page "Open in new tab" shows `previewUrl` in. */
  tabUrl: string | null;
  /**
   * Set once a submit attempt got this file to the server. A later retry
   * (after another file in the batch failed) must not upload it again.
   */
  uploaded?: Attachment;
  /** The project `uploaded` went to, which is where deleting it goes. */
  uploadedTo?: string;
};

let stagedKey = 0;

/** What `useStagedFiles` hands its caller: the tray, and the ways into it. */
export type StagedFiles = {
  /** The staged files the text places, in staging order. */
  staged: StagedFile[];
  /** For `<MarkdownEditor staging={…}>`; one identity for the hook's life. */
  editor: EditorFileStaging;
  /**
   * Stage files and place their tokens: at `at`, else where the reader left
   * the caret, else at the end. `false` when there were no files or no
   * editor to place them in — the caller's cue to ignore the paste.
   */
  stage: (
    files: Iterable<File>,
    opts?: { fromClipboard?: boolean; at?: { from: number; to: number } },
  ) => boolean;
  /** Take a file out of the text: every token of it goes. */
  remove: (key: number) => void;
  /** Whether sending `text` needs `resolve` first. */
  pending: (text: string) => boolean;
  /**
   * Upload the files `text` places and return it with their tokens pointing
   * at the uploads. Throws on the first failure, the message leading with
   * the file's name.
   */
  resolve: (text: string, slug: string, issueNumber: number) => Promise<string>;
  /** `text` without its tokens. */
  strip: (text: string) => string;
  /** Forget the files after the text that links them was sent. */
  clear: () => void;
  /** Forget the files because the text is being abandoned (T-568). */
  discard: () => void;
};

/**
 * Delete the draft a staged file became, if it became one. Not reported: a
 * draft this misses is one the server reaps within the day anyway.
 */
function deleteDraft(item: StagedFile): Promise<void> {
  if (item.uploaded === undefined || item.uploadedTo === undefined) {
    return Promise.resolve();
  }
  return api
    .deleteAttachment(item.uploadedTo, item.uploaded.id)
    .catch(() => {});
}

/** `deleteDraft`, not awaited: the reader has already moved on. */
function withdraw(item: StagedFile): void {
  void deleteDraft(item);
}

/**
 * A page showing `src` the way the viewer and the /view route do: in a frame
 * sandboxed to scripts alone, whose opaque origin reaches neither this app's
 * cookies nor its storage. Opened bare, a staged file's object URL would run
 * in this app's origin, and the CSP sandbox /view sends needs a response
 * header an object URL does not have.
 */
function sandboxedPage(title: string, src: string): string {
  const text = title.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return (
    `<!doctype html><meta charset="utf-8"><title>${text}</title>` +
    "<style>html,body{margin:0;height:100%}" +
    "iframe{display:block;width:100%;height:100%;border:0}</style>" +
    `<iframe sandbox="allow-scripts" title="${text}" src="${src}"></iframe>`
  );
}

function revokeUrls(item: StagedFile): void {
  if (item.previewUrl !== null) URL.revokeObjectURL(item.previewUrl);
  if (item.tabUrl !== null) URL.revokeObjectURL(item.tabUrl);
}

/** The file as it was before any upload: what a withdrawn draft leaves. */
function forgetUpload({
  uploaded: _uploaded,
  uploadedTo: _uploadedTo,
  ...item
}: StagedFile): StagedFile {
  return item;
}

function sameKeys(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  return a.size === b.size && [...a].every((key) => b.has(key));
}

/**
 * Local staging for pasted, dropped and picked editor files (any type). A
 * staged file goes into the text as a token where the reader put it, and
 * the text is the record: the tray shows the files it places, deleting a
 * token takes its file out, and undo brings it back.
 *
 * Nothing touches the server until resolve() at submit time. Even then the
 * files go up as drafts (T-568), seen by nobody but the uploader until the
 * text that links them is written — so a submit that uploads and then
 * fails, and is abandoned, leaves nothing on the card. Taking an uploaded
 * file out deletes its draft at once; the server reaps any that a closed
 * tab never got to. Size limits are the server's call; its 422 message is
 * surfaced per file.
 */
export function useStagedFiles(): StagedFiles {
  const queryClient = useQueryClient();
  // Every file staged since mount or the last clear, placed or not: undo can
  // bring a deleted token back. The ref is the record and the state mirrors
  // it for rendering, so a read straight after a write sees the write.
  const [all, setAll] = useState<StagedFile[]>([]);
  const allRef = useRef<StagedFile[]>([]);
  const [referenced, setReferenced] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const referencedRef = useRef<ReadonlySet<number>>(new Set());
  const viewRef = useRef<EditorView | null>(null);
  // Whether the reader has pressed or typed in the editor since it bound: the
  // caret `autoFocus` leaves at 0 is not one they put there.
  const touchedRef = useRef(false);
  const unbindRef = useRef<(() => void) | null>(null);

  const staged = useMemo(
    () => all.filter((item) => referenced.has(item.key)),
    [all, referenced],
  );

  function commit(next: StagedFile[]) {
    allRef.current = next;
    setAll(next);
  }

  function setReferencedKeys(keys: ReadonlySet<number>) {
    if (sameKeys(keys, referencedRef.current)) return;
    referencedRef.current = keys;
    setReferenced(keys);
  }

  // Nothing has reached the server while a file sits in the tray, so leaving
  // drops it — the fourth surface of the form the editor cannot see.
  useDirtySource(() => staged.length > 0);

  // Object URLs survive React state; reclaim them if the editor unmounts
  // with staged files still around. An editor unmounting with uploaded files
  // is one whose text was left unsent, the guard having let the reader go.
  useEffect(
    () => () => {
      unbindRef.current?.();
      for (const item of allRef.current) {
        revokeUrls(item);
        withdraw(item);
      }
    },
    [],
  );

  function knows(key: number): boolean {
    return allRef.current.some((item) => item.key === key);
  }

  function sync(doc: string) {
    setReferencedKeys(new Set(stagedKeysIn(doc, knows)));
  }

  function bind(view: EditorView | null) {
    unbindRef.current?.();
    unbindRef.current = null;
    viewRef.current = view;
    touchedRef.current = false;
    if (view === null) return;
    const touch = () => {
      touchedRef.current = true;
    };
    const controller = new AbortController();
    const listen = { capture: true, signal: controller.signal };
    view.dom.addEventListener("pointerdown", touch, listen);
    view.dom.addEventListener("keydown", touch, listen);
    unbindRef.current = () => controller.abort();
    sync(view.state.doc.toString());
  }

  function stage(
    files: Iterable<File>,
    opts?: { fromClipboard?: boolean; at?: { from: number; to: number } },
  ): boolean {
    const view = viewRef.current;
    const list = [...files].map((file) =>
      opts?.fromClipboard === true ? renameIfClipboardDefault(file) : file,
    );
    if (list.length === 0 || view === null) return false;
    const added = list.map((file): StagedFile => {
      const key = stagedKey++;
      const target = { filename: file.name, content_type: file.type };
      const previewUrl =
        previewKind({ ...target, size: file.size }) === null
          ? null
          : URL.createObjectURL(file);
      return {
        key,
        file,
        token: stagedToken(key, file.name, isPreviewableImage(target)),
        previewUrl,
        tabUrl:
          previewUrl === null || !opensInBrowserTab(target)
            ? null
            : URL.createObjectURL(
                new Blob([sandboxedPage(file.name, previewUrl)], {
                  type: "text/html",
                }),
              ),
      };
    });
    // Before the dispatch, whose sync has to recognize the new tokens.
    commit([...allRef.current, ...added]);
    const end = view.state.doc.length;
    const { from, to } =
      opts?.at ??
      (touchedRef.current ? view.state.selection.main : { from: end, to: end });
    const change = tokenInsertion(
      view.state.doc.toString(),
      from,
      to,
      added.map((item) => item.token),
    );
    view.dispatch({
      changes: { from: change.from, to: change.to, insert: change.insert },
      selection: { anchor: change.cursor },
      scrollIntoView: true,
      // An undo step of its own, so the next keystroke's undo cannot take
      // the file with it.
      annotations: isolateHistory.of("full"),
      userEvent:
        opts?.fromClipboard === true
          ? "input.paste"
          : opts?.at !== undefined
            ? "input.drop"
            : "input",
    });
    return true;
  }

  function paste(event: ClipboardEvent, view: EditorView) {
    const { from, to } = view.state.selection.main;
    // The only route the clipboard-default rename applies to: a drop or a
    // file picker carries a name someone actually chose.
    if (
      stage(event.clipboardData?.files ?? [], {
        fromClipboard: true,
        at: { from, to },
      })
    ) {
      event.preventDefault();
    }
  }

  function drop(event: DragEvent, view: EditorView): boolean {
    const files = event.dataTransfer?.files;
    if (files === undefined || files.length === 0) {
      // A token from another editor's tray names a file this one never
      // staged: dropped in, it would go out as a link to nothing.
      const token = event.dataTransfer?.getData(STAGED_TOKEN_TYPE) ?? "";
      if (stagedKeysIn(token, () => true).some((key) => !knows(key))) {
        event.preventDefault();
        return true;
      }
      // Other text, this tray's tokens included, is CodeMirror's to drop.
      return false;
    }
    event.preventDefault();
    const at =
      view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
      view.state.selection.main.head;
    stage(files, { at: { from: at, to: at } });
    return true;
  }

  function dragOver(event: DragEvent) {
    // Without this the browser navigates to the dropped file.
    if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
  }

  function remove(key: number) {
    const hit = allRef.current.find((item) => item.key === key);
    if (hit === undefined) return;
    // Withdrawn and forgotten together: undo can bring the token back, and
    // the next resolve must then upload the file again, not link a draft
    // that is gone.
    if (hit.uploaded !== undefined) {
      withdraw(hit);
      commit(
        allRef.current.map((item) =>
          item.key === key ? forgetUpload(item) : item,
        ),
      );
    }
    const view = viewRef.current;
    if (view === null) {
      setReferencedKeys(
        new Set([...referencedRef.current].filter((k) => k !== key)),
      );
      return;
    }
    const deletions = stagedTokenDeletions(
      view.state.doc.toString(),
      (k) => k === key,
    );
    if (deletions.length > 0) {
      view.dispatch({
        changes: deletions,
        // One Ctrl+Z brings back exactly what × took.
        annotations: isolateHistory.of("full"),
        userEvent: "delete",
      });
    }
  }

  function pending(text: string): boolean {
    return (
      stagedKeysIn(text, knows).length > 0 ||
      allRef.current.some((item) => item.uploaded !== undefined)
    );
  }

  async function resolve(
    text: string,
    slug: string,
    issueNumber: number,
  ): Promise<string> {
    const keys = stagedKeysIn(text, knows);
    let touchedServer = false;
    try {
      for (const key of keys) {
        const item = allRef.current.find((p) => p.key === key);
        if (item === undefined || item.uploaded !== undefined) continue;
        let uploaded: Attachment;
        try {
          uploaded = await api.uploadAttachment(slug, issueNumber, item.file, {
            draft: true,
          });
        } catch (error) {
          throw new Error(`${item.file.name}: ${(error as Error).message}`);
        }
        touchedServer = true;
        commit(
          allRef.current.map((p) =>
            p.key === key ? { ...p, uploaded, uploadedTo: slug } : p,
          ),
        );
      }
      // An upload the text no longer places — its token deleted after an
      // earlier attempt got it up — would be an attachment nothing links.
      const orphans = allRef.current.filter(
        (item) => item.uploaded !== undefined && !keys.includes(item.key),
      );
      if (orphans.length > 0) {
        // Not awaited: the send need not wait on them. The attachment list
        // refreshes once they are gone.
        void Promise.all(orphans.map(deleteDraft)).then(() =>
          queryClient.invalidateQueries({
            queryKey: ["attachments", slug, issueNumber],
          }),
        );
        commit(
          allRef.current.map((item) =>
            orphans.includes(item) ? forgetUpload(item) : item,
          ),
        );
      }
    } finally {
      if (touchedServer) {
        queryClient.invalidateQueries({
          queryKey: ["attachments", slug, issueNumber],
        });
      }
    }
    const resolved = new Map<
      number,
      { url: string; filename: string; insertedName: string }
    >();
    for (const item of allRef.current) {
      if (item.uploaded === undefined) continue;
      resolved.set(item.key, {
        url: item.uploaded.url,
        filename: item.uploaded.filename,
        insertedName: item.file.name,
      });
    }
    return resolveStagedTokens(text, resolved);
  }

  function clear() {
    // Synchronously, not at the next render: these files belong to a text
    // that was just sent, and an unmount before that render would read the
    // old list and delete them.
    for (const item of allRef.current) revokeUrls(item);
    commit([]);
    setReferencedKeys(new Set());
  }

  function discard() {
    for (const item of allRef.current) withdraw(item);
    clear();
  }

  // The editor keeps one object for its life; it reaches today's functions
  // through this ref.
  const latest = useRef({ bind, sync, knows, paste, drop, dragOver });
  latest.current = { bind, sync, knows, paste, drop, dragOver };
  const [editor] = useState<EditorFileStaging>(() => ({
    bind: (view) => latest.current.bind(view),
    sync: (doc) => latest.current.sync(doc),
    knows: (key) => latest.current.knows(key),
    paste: (event, view) => latest.current.paste(event, view),
    drop: (event, view) => latest.current.drop(event, view),
    dragOver: (event) => latest.current.dragOver(event),
  }));

  return {
    staged,
    editor,
    stage,
    remove,
    pending,
    resolve,
    strip: (text) => stripStagedTokens(text, knows),
    clear,
    discard,
  };
}

/**
 * File-picker entry to the staging tray. Paste and drag-drop cover
 * desktop, but touch devices have neither — a tappable button is the
 * only way to attach from a phone, so every editor renders one.
 */
export function StagedFileUploadButton({
  onFiles,
  disabled = false,
  label,
  className,
}: {
  onFiles: (files: FileList) => void;
  disabled?: boolean;
  /** Visible text next to the paperclip; icon-only when omitted. */
  label?: string;
  className?: string;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={fileInput}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files !== null) onFiles(e.target.files);
          // Same file re-picked after a remove must fire change again.
          e.target.value = "";
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size={label === undefined ? "icon-sm" : "sm"}
        disabled={disabled}
        aria-label="Attach files"
        title={label === undefined ? "Attach files" : undefined}
        className={className}
        onClick={() => fileInput.current?.click()}
      >
        <PaperclipIcon className="size-3.5" />
        {label}
      </Button>
    </>
  );
}

/**
 * What a drag out of the tray carries: the file's token, as text and under
 * a type of its own that tells an editor where it came from.
 */
function dragToken(item: StagedFile) {
  return {
    draggable: true,
    onDragStart: (event: React.DragEvent) => {
      event.dataTransfer.setData("text/plain", item.token);
      event.dataTransfer.setData(STAGED_TOKEN_TYPE, item.token);
      event.dataTransfer.effectAllowed = "copy";
    },
  };
}

/**
 * Thumbnail/card strip for the staged files the text places, with
 * per-file remove. What the viewer can show opens in it; anything can be
 * dragged into the text to place the file once more.
 */
export function StagedFileTray({
  staged,
  onRemove,
  disabled = false,
}: {
  staged: StagedFile[];
  onRemove: (key: number) => void;
  disabled?: boolean;
}) {
  const [viewing, setViewing] = useState<number | null>(null);
  if (staged.length === 0) return null;

  // Once the server has answered, its name is the authoritative one — it
  // may have appended an id to settle a clash (T-269), and what the tray
  // shows has to be what the body will say.
  const nameOf = (item: StagedFile) =>
    item.uploaded?.filename ?? item.file.name;
  const viewable = staged.filter((item) => item.previewUrl !== null);
  const items: PreviewTarget[] = viewable.map((item) => ({
    filename: nameOf(item),
    url: item.previewUrl ?? "",
    content_type: item.file.type,
    size: item.file.size,
    ...(item.tabUrl === null ? {} : { tabUrl: item.tabUrl }),
  }));
  const index = viewable.findIndex((item) => item.key === viewing);

  return (
    <div className="flex flex-wrap items-end gap-2">
      {staged.map((item) => {
        const name = nameOf(item);
        const image =
          previewKind({
            filename: item.file.name,
            content_type: item.file.type,
            size: item.file.size,
          }) === "image";
        const face =
          image && item.previewUrl !== null ? (
            <img
              src={item.previewUrl}
              alt={name}
              title={name}
              draggable={false}
              className="h-16 w-16 rounded-md border object-cover"
            />
          ) : (
            <div
              title={name}
              className="flex h-16 max-w-48 min-w-32 flex-col justify-center gap-0.5 rounded-md border px-2.5 text-left text-xs"
            >
              <span className="flex items-center gap-1 font-medium">
                <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{name}</span>
              </span>
              <span className="pl-4.5 text-muted-foreground">
                {formatSize(item.file.size)}
              </span>
            </div>
          );
        return (
          <div key={item.key} className="group relative">
            {item.previewUrl !== null ? (
              <button
                type="button"
                aria-label={`view ${name}`}
                className="group/view relative block cursor-zoom-in rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                onClick={() => setViewing(item.key)}
                {...dragToken(item)}
              >
                {face}
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-black/45 text-white opacity-0 transition-opacity group-hover/view:opacity-100 group-focus-visible/view:opacity-100"
                >
                  <Maximize2Icon className="size-4" />
                </span>
              </button>
            ) : (
              <div {...dragToken(item)}>{face}</div>
            )}
            <button
              type="button"
              aria-label={`remove ${name}`}
              disabled={disabled}
              onClick={() => onRemove(item.key)}
              className="absolute -top-1.5 -right-1.5 rounded-full border bg-background p-0.5 text-muted-foreground shadow-sm hover:text-foreground disabled:opacity-50"
            >
              <XIcon className="size-3" />
            </button>
          </div>
        );
      })}
      <AttachmentViewerDialog
        state={index === -1 ? null : { items, index }}
        onNavigate={(next) => setViewing(viewable[next]?.key ?? null)}
        onClose={() => setViewing(null)}
      />
    </div>
  );
}
