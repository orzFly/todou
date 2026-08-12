import { useQueryClient } from "@tanstack/react-query";
import type { Attachment } from "@todou/shared";
import { XIcon } from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "@/api/queries.ts";
import { attachmentImageMarker } from "@/lib/attachment-refs.ts";

export type StagedImage = {
  key: number;
  file: File;
  previewUrl: string;
  /**
   * Set once a submit attempt got this file to the server. A later retry
   * (after another file in the batch failed) must not upload it again.
   */
  uploaded?: Attachment;
};

let stagedKey = 0;

/**
 * Local staging for pasted/dropped editor images: previewable and
 * removable, but nothing touches the server until uploadAll() at submit
 * time — abandoning the draft leaves no orphaned attachments.
 */
export function useStagedImages() {
  const [staged, setStaged] = useState<StagedImage[]>([]);
  const queryClient = useQueryClient();
  const stagedRef = useRef(staged);
  stagedRef.current = staged;

  // Object URLs survive React state; reclaim them if the editor unmounts
  // with staged images still around.
  useEffect(
    () => () => {
      for (const item of stagedRef.current) {
        URL.revokeObjectURL(item.previewUrl);
      }
    },
    [],
  );

  function stage(files: Iterable<File>): boolean {
    const images = [...files].filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return false;
    setStaged((prev) => [
      ...prev,
      ...images.map((file) => ({
        key: stagedKey++,
        file,
        previewUrl: URL.createObjectURL(file),
      })),
    ]);
    return true;
  }

  function remove(key: number) {
    setStaged((prev) => {
      const hit = prev.find((p) => p.key === key);
      if (hit) URL.revokeObjectURL(hit.previewUrl);
      return prev.filter((p) => p.key !== key);
    });
  }

  function clear() {
    setStaged((prev) => {
      for (const item of prev) URL.revokeObjectURL(item.previewUrl);
      return [];
    });
  }

  /**
   * Upload every staged image and return one markdown marker per image.
   * Throws on the first failure; already-uploaded items keep their mark
   * so a retry only re-sends what is missing.
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
          uploaded = await api.uploadAttachment(slug, issueNumber, item.file);
          touchedServer = true;
          setStaged((prev) =>
            prev.map((p) => (p.key === item.key ? { ...p, uploaded } : p)),
          );
        }
        markers.push(attachmentImageMarker(uploaded.filename, uploaded.url));
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

  function onPaste(e: ClipboardEvent) {
    if (stage(e.clipboardData.files)) e.preventDefault();
  }

  function onDrop(e: DragEvent) {
    if (e.dataTransfer.files.length > 0) {
      e.preventDefault();
      stage(e.dataTransfer.files);
    }
  }

  function onDragOver(e: DragEvent) {
    // Without this the browser navigates to the dropped file.
    if (e.dataTransfer.types.includes("Files")) e.preventDefault();
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

/** Thumbnail strip for staged images, with per-image remove. */
export function StagedImageTray({
  staged,
  onRemove,
  disabled = false,
}: {
  staged: StagedImage[];
  onRemove: (key: number) => void;
  disabled?: boolean;
}) {
  if (staged.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {staged.map((item) => (
        <div key={item.key} className="group relative">
          <img
            src={item.previewUrl}
            alt={item.file.name}
            title={item.file.name}
            className="h-16 w-16 rounded-md border object-cover"
          />
          <button
            type="button"
            aria-label={`remove ${item.file.name}`}
            disabled={disabled}
            onClick={() => onRemove(item.key)}
            className="absolute -top-1.5 -right-1.5 rounded-full border bg-background p-0.5 text-muted-foreground shadow-sm hover:text-foreground disabled:opacity-50"
          >
            <XIcon className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
