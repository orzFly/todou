import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CommandInput,
  CommandSubmitResult,
  Me,
  TimelineComment,
  TimelineItem,
} from "@todou/shared";
import { COMMENT_HIDE_MAX_IDS } from "@todou/shared";
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
import { allCommentsQuery } from "@/api/timeline.ts";
import {
  StagedFileTray,
  StagedFileUploadButton,
  useStagedFiles,
} from "@/components/issue/staged-files.tsx";
import { CommandErrors } from "@/components/shared/command-errors.tsx";
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
  type DraftCommand,
  type HideAllDraft,
  hidePreview,
  hideSelectionFor,
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
          hidden_at: null,
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
export function useCommandRegistry(
  slug: string,
  surface: "comment" | "new-issue",
): CommandRegistry | null {
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
      surface,
    });
  }, [statuses.data, labels.data, members.data, me.data, surface]);
}

/** The first `/hide-all` line of a draft; the preview describes that one. */
function firstHideAll(commands: DraftCommand[]): HideAllDraft | undefined {
  return commands.find(
    (command): command is HideAllDraft => command.type === "hide_all",
  );
}

/**
 * Draft commands → what actually goes on the wire: each `/hide-all` becomes
 * the id list it resolved to, and one whose selection came back empty is
 * dropped rather than sent as a request to hide nothing.
 */
export function resolveDraftCommands(
  commands: DraftCommand[],
  items: TimelineItem[],
): CommandInput[] {
  const resolved: CommandInput[] = [];
  for (const command of commands) {
    if (command.type !== "hide_all") {
      resolved.push(command);
      continue;
    }
    const { pick } = hideSelectionFor(items, command);
    for (let at = 0; at < pick.length; at += COMMENT_HIDE_MAX_IDS) {
      resolved.push({
        type: "comments_hide",
        hidden: command.hidden,
        comment_ids: pick.slice(at, at + COMMENT_HIDE_MAX_IDS),
      });
    }
  }
  return resolved;
}

/** What the toast says about the half `unhide` will not give back. */
export function settledToast(result: CommandSubmitResult): string | null {
  const settled = result.hide?.settled ?? null;
  if (settled === null) return null;
  const parts = [
    settled.declined_questions.length === 0
      ? null
      : `declined ${settled.declined_questions.length} unanswered question(s)`,
    settled.resolved_annotations.length === 0
      ? null
      : `resolved ${settled.resolved_annotations.length} annotation(s)`,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : `Hiding also ${parts.join(" and ")}.`;
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
  const [touched, setTouched] = useState(false);
  // `/issues/7 → /issues/8` is one route with a changed param, so the router
  // keeps this instance and nothing remounts. Without this the buttons would
  // arrive on the next card already open, and "for this visit" would be a lie.
  const [touchedFor, setTouchedFor] = useState(issueNumber);
  if (touchedFor !== issueNumber) {
    setTouchedFor(issueNumber);
    setTouched(false);
  }
  const staging = useStagedFiles();
  const queryClient = useQueryClient();
  const registry = useCommandRegistry(slug, "comment");

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
  const hideDraft = firstHideAll(commands);

  // Never `useSuspenseQuery`: the composer is mounted bare in tests with
  // seeded query data, and a suspending query there renders an empty div
  // whose failure reads as "cannot find role" rather than as suspense.
  const allComments = useQuery({
    ...allCommentsQuery(slug, issueNumber),
    enabled: hideDraft !== undefined,
  });
  const preview = useMemo(() => {
    if (hideDraft === undefined || allComments.data === undefined) return null;
    const selection = hideSelectionFor(allComments.data, hideDraft);
    return { selection, ...hidePreview(selection, hideDraft) };
  }, [hideDraft, allComments.data]);

  const broken = [
    ...(parsed?.invalid ?? []),
    // Only once the drain has landed: while it is in flight the line is
    // fine, and disabling the submit for "nothing to hide" would be a
    // verdict on a card nobody has read yet.
    ...(preview !== null && preview.selection.pick.length === 0
      ? [
          {
            line: hideDraft?.hidden === false ? "/unhide-all" : "/hide-all",
            reason:
              hideDraft?.hidden === false
                ? "nothing to unhide — no comment on this card is hidden"
                : "nothing to hide — every comment here is already hidden or held back",
          },
        ]
      : []),
  ];
  const empty =
    (parsed?.body ?? draft).trim() === "" &&
    staging.staged.length === 0 &&
    commands.length === 0;
  // A broken command line counts as content even though `empty` cannot see it:
  // it yields neither a body nor a command, so a draft that is nothing else
  // reads as empty while still rendering its error block. Reachable by walking
  // to the next card, which resets `touched` and keeps the draft.
  const expanded = touched || !empty || broken.length > 0;
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
        // Fetched rather than read off the rendered query: the ids about to
        // be written have to be the ones the card holds now, not the ones it
        // held when the line was typed.
        const items =
          firstHideAll(current.commands) === undefined
            ? []
            : await queryClient.fetchQuery(allCommentsQuery(slug, issueNumber));
        const resolved = resolveDraftCommands(current.commands, items);
        if (resolved.length === 0) return;
        const result = (await onSendWithCommands(full, resolved)) as
          | CommandSubmitResult
          | undefined;
        const settled = result === undefined ? null : settledToast(result);
        if (settled !== null) toast.success(settled);
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
    setTouched(false);
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
      <CommandErrors broken={broken} />
      {preview !== null && preview.selection.pick.length > 0 && (
        <div
          role="status"
          className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground"
        >
          <p className="font-medium text-foreground">{preview.headline}</p>
          {preview.kept.map((entry) => (
            <p key={entry.id} className="mt-0.5">
              <span className="font-mono">#comment-{entry.id}</span>{" "}
              {entry.reason}
            </p>
          ))}
        </div>
      )}
      <form
        className="flex flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        // Focus rather than click, so tabbing in reaches the buttons too;
        // pointerdown as well, because a submit resets this while the caret
        // stays in the editor, and clicking back in then fires no focusin.
        onFocus={() => setTouched(true)}
        onPointerDown={() => setTouched(true)}
      >
        <MarkdownEditor
          ref={editor}
          ariaLabel="Write a comment"
          placeholder="Write a comment… (#N references other issues, / runs a command; paste or drop files)"
          // Sticky at the viewport bottom: an auto-growing draft must not
          // swallow the page, especially on small/mobile viewports.
          className="max-h-[40dvh] min-h-16"
          extensions={extensions}
          onChange={setDraft}
          onPaste={staging.onPaste}
          onDrop={staging.onDrop}
          onDragOver={staging.onDragOver}
          onSubmit={() => void submit()}
        />
        {/* The buttons get a row of their own (attach left, submit right —
            the same layout as the issue-body, edit-comment and new-issue
            editors) because `submitLabel` grows with the commands it parsed:
            "Comment, move to In Progress and label bug" beside the editor
            takes its width from the editor. Not rendered rather than hidden,
            so an invisible button cannot sit in the tab order. */}
        {expanded && (
          <div className="composer-actions-in mt-2 flex h-7 items-start justify-between gap-2">
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
        )}
      </form>
    </div>
  );
}
