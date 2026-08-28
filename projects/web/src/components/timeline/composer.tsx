import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Me, TimelineComment } from "@todou/shared";
import { SendIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/queries.ts";
import {
  StagedFileTray,
  StagedFileUploadButton,
  useStagedFiles,
} from "@/components/issue/staged-files.tsx";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "@/components/shared/markdown-editor.tsx";
import { Button } from "@/components/ui/button";

export type PendingComment = {
  key: number;
  comment: TimelineComment;
  failed?: boolean;
};

let pendingKey = 0;

/**
 * Optimistic composer: the draft appears immediately as a "sending…" item;
 * on success the timeline refetches forward and the pending item drops out.
 * Failures keep the draft with a retry affordance.
 */
export function useCommentComposer(slug: string, issueNumber: number, me: Me) {
  const [pending, setPending] = useState<PendingComment[]>([]);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (vars: { key: number; body: string }) =>
      api.createComment(slug, issueNumber, vars.body),
    onSuccess: async (_created, vars) => {
      await queryClient.invalidateQueries({
        queryKey: ["timeline", slug, issueNumber],
      });
      setPending((prev) => prev.filter((p) => p.key !== vars.key));
    },
    onError: (_error, vars) => {
      setPending((prev) =>
        prev.map((p) => (p.key === vars.key ? { ...p, failed: true } : p)),
      );
    },
  });

  function send(body: string) {
    const key = pendingKey++;
    setPending((prev) => [
      ...prev,
      {
        key,
        comment: {
          type: "comment",
          id: -1 - key,
          author: me,
          body,
          component: null,
          created_at: new Date().toISOString(),
          edited_at: null,
          resolved_at: null,
          agent_context: null,
        },
      },
    ]);
    mutation.mutate({ key, body });
  }

  function retry(key: number) {
    const entry = pending.find((p) => p.key === key);
    if (!entry) return;
    setPending((prev) =>
      prev.map((p) => (p.key === key ? { ...p, failed: false } : p)),
    );
    mutation.mutate({ key, body: entry.comment.body });
  }

  return { pending, send, retry };
}

/** Draft text + freshly-uploaded attachment markers → one comment body. */
export function withAttachmentMarkers(body: string, markers: string[]): string {
  return [body, markers.join("\n")].filter((part) => part !== "").join("\n\n");
}

export function Composer({
  slug,
  issueNumber,
  onSend,
  failed,
  onRetry,
}: {
  slug: string;
  issueNumber: number;
  onSend: (body: string) => void;
  failed: PendingComment[];
  onRetry: (key: number) => void;
}) {
  const editor = useRef<MarkdownEditorHandle>(null);
  const [uploading, setUploading] = useState(false);
  const staging = useStagedFiles();

  async function submit() {
    const trimmed = (editor.current?.getValue() ?? "").trim();
    if (uploading) return;
    if (trimmed === "" && staging.staged.length === 0) return;
    let full = trimmed;
    if (staging.staged.length > 0) {
      setUploading(true);
      try {
        const markers = await staging.uploadAll(slug, issueNumber);
        full = withAttachmentMarkers(trimmed, markers);
      } catch (error) {
        // Draft and staged images stay put for another attempt.
        toast.error(`Could not upload files: ${(error as Error).message}`);
        return;
      } finally {
        setUploading(false);
      }
    }
    onSend(full);
    editor.current?.setValue("");
    staging.clear();
  }

  return (
    <div className="space-y-2">
      {failed.map((entry) => (
        <div
          key={entry.key}
          className="flex items-center justify-between rounded-md border border-destructive/40 px-3 py-1.5 text-sm text-destructive"
        >
          <span className="truncate">发送失败：{entry.comment.body}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onRetry(entry.key)}
          >
            Retry
          </Button>
        </div>
      ))}
      <StagedFileTray
        staged={staging.staged}
        onRemove={staging.remove}
        disabled={uploading}
      />
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <MarkdownEditor
          ref={editor}
          ariaLabel="Write a comment"
          placeholder="Write a comment… (#N references other issues; paste or drop files)"
          // Sticky at the viewport bottom: an auto-growing draft must not
          // swallow the page, especially on small/mobile viewports.
          className="max-h-[40dvh] min-h-16 sm:flex-1"
          onPaste={staging.onPaste}
          onDrop={staging.onDrop}
          onDragOver={staging.onDragOver}
          onSubmit={() => void submit()}
        />
        {/* Phones: the textarea gets the whole row; the buttons drop to
            their own row below (attach left, submit right — the same row
            layout as the issue-body and new-issue editors). ≥sm the
            wrapper dissolves and everything shares one row as before. */}
        <div className="flex items-center justify-between gap-2 sm:contents">
          <StagedFileUploadButton
            onFiles={staging.stage}
            disabled={uploading}
          />
          <Button type="submit" size="sm" disabled={uploading}>
            <SendIcon className="size-4" />{" "}
            {uploading ? "Uploading…" : "Comment"}
          </Button>
        </div>
      </form>
    </div>
  );
}
