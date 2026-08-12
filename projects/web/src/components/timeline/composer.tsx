import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Me, TimelineComment } from "@todou/shared";
import { SendIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/queries.ts";
import {
  StagedFileTray,
  useStagedFiles,
} from "@/components/issue/staged-files.tsx";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

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
  const [body, setBody] = useState("");
  const [uploading, setUploading] = useState(false);
  const staging = useStagedFiles();

  async function submit() {
    const trimmed = body.trim();
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
    setBody("");
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
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write a comment… (#N references other issues; paste or drop files)"
          rows={3}
          // Sticky at the viewport bottom: an auto-growing draft must not
          // swallow the page, especially on small/mobile viewports.
          className="max-h-[40dvh] flex-1"
          onPaste={staging.onPaste}
          onDrop={staging.onDrop}
          onDragOver={staging.onDragOver}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <Button type="submit" size="sm" disabled={uploading}>
          <SendIcon className="size-4" /> {uploading ? "Uploading…" : "Comment"}
        </Button>
      </form>
    </div>
  );
}
