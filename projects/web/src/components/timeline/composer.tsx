import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CommandInput, Me, TimelineComment } from "@todou/shared";
import { SendIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  api,
  labelsQuery,
  membersQuery,
  meQuery,
  statusesQuery,
} from "@/api/queries.ts";
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
import {
  completionWith,
  refCompletionSource,
} from "@/lib/editor/ref-completion.ts";
import {
  commandCompletionSource,
  commandDecoration,
} from "@/lib/editor/slash-commands.ts";
import {
  buildCommandRegistry,
  type CommandRegistry,
  parseCommandLines,
  summarizeCommands,
} from "@/lib/slash-commands.ts";

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

  /**
   * The slash-command path (T-161). No optimistic item: the submission also
   * changes fields, and a card that showed a comment while its `/close` was
   * still in flight would be showing a state the server may yet refuse. It
   * rejects on failure so the composer can keep the draft.
   */
  const commands = useMutation({
    mutationFn: (vars: { body: string; commands: CommandInput[] }) =>
      api.submitCommands(slug, issueNumber, vars),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["timeline", slug, issueNumber],
        }),
        queryClient.invalidateQueries({
          queryKey: ["issue", slug, issueNumber],
        }),
        queryClient.invalidateQueries({ queryKey: ["issues", slug] }),
      ]);
    },
  });

  return {
    pending,
    send,
    retry,
    sendWithCommands: (body: string, input: CommandInput[]) =>
      commands.mutateAsync({ body, commands: input }),
  };
}

/** Draft text + freshly-uploaded attachment markers → one comment body. */
export function withAttachmentMarkers(body: string, markers: string[]): string {
  return [body, markers.join("\n")].filter((part) => part !== "").join("\n\n");
}

/**
 * What the submit button says. It names what is about to happen, so a draft
 * that is nothing but commands never looks like it will post a comment, and
 * a blocked one never advertises an action it cannot perform.
 */
export function submitLabel(state: {
  uploading: boolean;
  running: boolean;
  /** Recognized command lines whose target does not exist. */
  broken: number;
  /** Per-command summaries, in order. */
  summaries: string[];
  /** Whether a comment will be created alongside the commands. */
  withComment: boolean;
}): string {
  if (state.uploading) return "Uploading…";
  if (state.running) return "Running…";
  if (state.broken > 0) {
    return `Fix ${state.broken === 1 ? "the command" : `${state.broken} commands`}`;
  }
  if (state.summaries.length === 0) return "Comment";
  const summary = summarizeCommands(state.summaries);
  if (!state.withComment) return `Run: ${summary}`;
  // A comma once the summary carries its own "and", so the label never
  // reads "and … and …".
  return state.summaries.length === 1
    ? `Comment and ${summary}`
    : `Comment, ${summary}`;
}

/** The registry behind the `/` panel, from the three lists it names. */
function useCommandRegistry(slug: string): CommandRegistry | null {
  const statuses = useQuery(statusesQuery(slug));
  const labels = useQuery(labelsQuery(slug));
  const members = useQuery(membersQuery(slug));
  const me = useQuery(meQuery);
  return useMemo(() => {
    if (statuses.data === undefined) return null;
    return buildCommandRegistry({
      statuses: statuses.data,
      labels: labels.data ?? [],
      members: members.data ?? [],
      me: me.data,
    });
  }, [statuses.data, labels.data, members.data, me.data]);
}

export function Composer({
  slug,
  issueNumber,
  onSend,
  onSendWithCommands,
  failed,
  onRetry,
}: {
  slug: string;
  issueNumber: number;
  onSend: (body: string) => void;
  onSendWithCommands: (
    body: string,
    commands: CommandInput[],
  ) => Promise<unknown>;
  failed: PendingComment[];
  onRetry: (key: number) => void;
}) {
  const editor = useRef<MarkdownEditorHandle>(null);
  const [uploading, setUploading] = useState(false);
  const [running, setRunning] = useState(false);
  const [draft, setDraft] = useState("");
  const staging = useStagedFiles();
  const queryClient = useQueryClient();
  const registry = useCommandRegistry(slug);

  // The extensions must keep one identity for the editor's lifetime: the
  // compartment reconfigures on a new one, which would close an open panel.
  // The registry therefore arrives through a ref, not through the closure.
  const registryRef = useRef(registry);
  registryRef.current = registry;
  const extensions = useMemo(
    () => [
      completionWith([
        refCompletionSource(slug, queryClient),
        commandCompletionSource(() => registryRef.current),
      ]),
      commandDecoration(() => registryRef.current),
    ],
    [slug, queryClient],
  );

  const parsed = useMemo(
    () => (registry === null ? null : parseCommandLines(draft, registry)),
    [draft, registry],
  );
  const commands = parsed?.commands ?? [];
  const broken = parsed?.invalid ?? [];
  const empty =
    (parsed?.body ?? draft).trim() === "" &&
    staging.staged.length === 0 &&
    commands.length === 0;
  const label = submitLabel({
    uploading,
    running,
    broken: broken.length,
    summaries: parsed?.summaries ?? [],
    withComment: (parsed?.body ?? "") !== "" || staging.staged.length > 0,
  });

  async function submit() {
    if (uploading || running) return;
    const raw = editor.current?.getValue() ?? "";
    // Re-parsed from the document rather than trusting the onChange mirror:
    // the text at submit time is what gets executed.
    const current =
      registry === null
        ? { body: raw.trim(), commands: [], invalid: [], summaries: [] }
        : parseCommandLines(raw, registry);
    if (current.invalid.length > 0) return;
    if (
      current.body === "" &&
      current.commands.length === 0 &&
      staging.staged.length === 0
    ) {
      return;
    }

    let full = current.body;
    if (staging.staged.length > 0) {
      setUploading(true);
      try {
        const markers = await staging.uploadAll(slug, issueNumber);
        full = withAttachmentMarkers(current.body, markers);
      } catch (error) {
        // Draft and staged images stay put for another attempt.
        toast.error(`Could not upload files: ${(error as Error).message}`);
        return;
      } finally {
        setUploading(false);
      }
    }

    if (current.commands.length > 0) {
      setRunning(true);
      try {
        await onSendWithCommands(full, current.commands);
      } catch (error) {
        // The whole submission was refused, comment included — the draft is
        // the only copy of it, so it stays exactly as typed.
        toast.error(`Could not run the commands: ${(error as Error).message}`);
        return;
      } finally {
        setRunning(false);
      }
    } else {
      onSend(full);
    }
    editor.current?.setValue("");
    setDraft("");
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
      {broken.map((entry) => (
        <p
          key={entry.line}
          role="alert"
          className="rounded-md border border-destructive/40 px-3 py-1.5 text-sm text-destructive"
        >
          <span className="font-mono">{entry.line}</span> — {entry.reason}
        </p>
      ))}
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
          placeholder="Write a comment… (#N references other issues, / runs a command; paste or drop files)"
          // Sticky at the viewport bottom: an auto-growing draft must not
          // swallow the page, especially on small/mobile viewports.
          className="max-h-[40dvh] min-h-16 sm:flex-1"
          extensions={extensions}
          onChange={setDraft}
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
          <Button
            type="submit"
            size="sm"
            disabled={uploading || running || empty || broken.length > 0}
          >
            <SendIcon className="size-4" /> {label}
          </Button>
        </div>
      </form>
    </div>
  );
}
