import { useQueryClient } from "@tanstack/react-query";
import type { Attachment } from "@todou/shared";
import { FileIcon, PaperclipIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/api/queries.ts";
import type {
  FileClipboardEvent,
  FileDragEvent,
} from "@/components/shared/markdown-editor.tsx";
import { Button } from "@/components/ui/button";
import { formatSize, isPreviewableImage } from "@/lib/attachment-preview.ts";
import {
  attachmentImageMarker,
  attachmentLinkMarker,
} from "@/lib/attachment-refs.ts";
import { renameIfClipboardDefault } from "@/lib/pasted-filename.ts";

export type StagedFile = {
  key: number;
  file: File;
  /** Object URL for image thumbnails; non-images have none. */
  previewUrl: string | null;
  /**
   * Set once a submit attempt got this file to the server. A later retry
   * (after another file in the batch failed) must not upload it again.
   */
  uploaded?: Attachment;
};

let stagedKey = 0;

/**
 * Local staging for pasted/dropped editor files (any type): previewable
 * and removable, but nothing touches the server until uploadAll() at
 * submit time — abandoning the draft leaves no orphaned attachments.
 * Size limits are the server's call; its 422 message is surfaced per file.
 */
export function useStagedFiles() {
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const queryClient = useQueryClient();
  const stagedRef = useRef(staged);
  stagedRef.current = staged;

  // Object URLs survive React state; reclaim them if the editor unmounts
  // with staged files still around.
  useEffect(
    () => () => {
      for (const item of stagedRef.current) {
        if (item.previewUrl !== null) URL.revokeObjectURL(item.previewUrl);
      }
    },
    [],
  );

  function stage(
    files: Iterable<File>,
    opts?: { fromClipboard?: boolean },
  ): boolean {
    const list = [...files].map((file) =>
      opts?.fromClipboard === true ? renameIfClipboardDefault(file) : file,
    );
    if (list.length === 0) return false;
    setStaged((prev) => [
      ...prev,
      ...list.map((file) => ({
        key: stagedKey++,
        file,
        previewUrl: file.type.startsWith("image/")
          ? URL.createObjectURL(file)
          : null,
      })),
    ]);
    return true;
  }

  function remove(key: number) {
    setStaged((prev) => {
      const hit = prev.find((p) => p.key === key);
      if (hit?.previewUrl) URL.revokeObjectURL(hit.previewUrl);
      return prev.filter((p) => p.key !== key);
    });
  }

  function clear() {
    setStaged((prev) => {
      for (const item of prev) {
        if (item.previewUrl !== null) URL.revokeObjectURL(item.previewUrl);
      }
      return [];
    });
  }

  /**
   * Upload every staged file and return one markdown marker per file —
   * ![…](…) for images (inline embed), […](…) for the rest (rich link).
   * Throws on the first failure, naming the file; already-uploaded items
   * keep their mark so a retry only re-sends what is missing.
   */
  async function uploadAll(
    slug: string,
    issueNumber: number,
  ): Promise<string[]> {
    const markers: string[] = [];
    let touchedServer = false;
    try {
      for (const item of stagedRef.current) {
        let uploaded = item.uploaded;
        if (!uploaded) {
          try {
            uploaded = await api.uploadAttachment(slug, issueNumber, item.file);
          } catch (error) {
            throw new Error(`${item.file.name}: ${(error as Error).message}`);
          }
          touchedServer = true;
          setStaged((prev) =>
            prev.map((p) => (p.key === item.key ? { ...p, uploaded } : p)),
          );
        }
        markers.push(
          isPreviewableImage(uploaded)
            ? attachmentImageMarker(uploaded.filename, uploaded.url)
            : attachmentLinkMarker(uploaded.filename, uploaded.url),
        );
      }
    } finally {
      if (touchedServer) {
        queryClient.invalidateQueries({
          queryKey: ["attachments", slug, issueNumber],
        });
      }
    }
    return markers;
  }

  function onPaste(e: FileClipboardEvent) {
    // The only route the clipboard-default rename applies to: a drop or a
    // file picker carries a name someone actually chose.
    if (stage(e.clipboardData?.files ?? [], { fromClipboard: true })) {
      e.preventDefault();
    }
  }

  function onDrop(e: FileDragEvent) {
    if (e.dataTransfer !== null && e.dataTransfer.files.length > 0) {
      e.preventDefault();
      stage(e.dataTransfer.files);
    }
  }

  function onDragOver(e: FileDragEvent) {
    // Without this the browser navigates to the dropped file.
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  }

  return {
    staged,
    stage,
    remove,
    clear,
    uploadAll,
    onPaste,
    onDrop,
    onDragOver,
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

/** Thumbnail/chip strip for staged files, with per-file remove. */
export function StagedFileTray({
  staged,
  onRemove,
  disabled = false,
}: {
  staged: StagedFile[];
  onRemove: (key: number) => void;
  disabled?: boolean;
}) {
  if (staged.length === 0) return null;
  return (
    <div className="flex flex-wrap items-end gap-2">
      {staged.map((item) => {
        // Once the server has answered, its name is the authoritative one —
        // it may have appended an id to settle a clash (T-269), and what the
        // tray shows has to be what the body will say.
        const name = item.uploaded?.filename ?? item.file.name;
        return (
          <div key={item.key} className="group relative">
            {item.previewUrl !== null ? (
              <img
                src={item.previewUrl}
                alt={name}
                title={name}
                className="h-16 w-16 rounded-md border object-cover"
              />
            ) : (
              <div
                title={name}
                className="flex h-16 max-w-48 min-w-32 flex-col justify-center gap-0.5 rounded-md border px-2.5 text-xs"
              >
                <span className="flex items-center gap-1 font-medium">
                  <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{name}</span>
                </span>
                <span className="pl-4.5 text-muted-foreground">
                  {formatSize(item.file.size)}
                </span>
              </div>
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
    </div>
  );
}
