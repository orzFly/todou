import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Me, TimelineComment } from "@todou/shared";
import { SendIcon } from "lucide-react";
import { useState } from "react";
import { api } from "@/api/queries.ts";
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
          created_at: new Date().toISOString(),
          edited_at: null,
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

export function Composer({
  onSend,
  failed,
  onRetry,
}: {
  onSend: (body: string) => void;
  failed: PendingComment[];
  onRetry: (key: number) => void;
}) {
  const [body, setBody] = useState("");

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
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = body.trim();
          if (trimmed === "") return;
          onSend(trimmed);
          setBody("");
        }}
      >
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write a comment… (#N references other issues)"
          rows={3}
          className="flex-1"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <Button type="submit" size="sm">
          <SendIcon className="size-4" /> Comment
        </Button>
      </form>
    </div>
  );
}
