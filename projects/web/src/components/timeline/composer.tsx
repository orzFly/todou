import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CommandInput,
  CommandSubmitResult,
  CommentKind,
  Me,
  TimelineComment,
  TimelineItem,
  Watcher,
} from "@todou/shared";
import { COMMENT_HIDE_MAX_IDS } from "@todou/shared";
import { MessageSquarePlusIcon, SendIcon } from "lucide-react";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
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
import { EditorShortcutsHelp } from "@/components/shared/editor-shortcuts-help.tsx";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "@/components/shared/markdown-editor.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import { WatcherStack } from "@/components/shared/watcher-stack.tsx";
import {
  ComposerWatchersLine,
  openerLabel,
} from "@/components/timeline/composer-watchers.tsx";
import { useQuoteSink } from "@/components/timeline/quote-reply.tsx";
import { Button } from "@/components/ui/button";
import { mentionCompletionSource } from "@/lib/editor/mention-completion.ts";
import {
  completionWith,
  refCompletionSource,
} from "@/lib/editor/ref-completion.ts";
import {
  commandCompletionSource,
  commandDecoration,
} from "@/lib/editor/slash-commands.ts";
import { blockquote } from "@/lib/quote-markdown.ts";
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
import { useDirtySource } from "@/lib/unsaved-guard.ts";
import { cn } from "@/lib/utils";

export type PendingComment = {
  key: number;
  comment: TimelineComment;
  failed?: boolean;
};

/**
 * The card a submission was aimed at, decided when the reader pressed the
 * button. Both the request and the settle-time invalidation read it from the
 * mutation's variables: `Mutation.execute` hands them to `fn` unchanged, so
 * they survive the option swap a route-param change performs on a mutation
 * that is still pending.
 */
export type Target = { slug: string; issueNumber: number };

let pendingKey = 0;

/**
 * Optimistic composer: the draft appears immediately as a "sending…" item;
 * on success the timeline refetches forward and the pending item drops out.
 * Failures keep the draft with a retry affordance.
 */
export function useCommentComposer(slug: string, issueNumber: number, me: Me) {
  const [pending, setPending] = useState<PendingComment[]>([]);
  const queryClient = useQueryClient();

  // `/issues/7 → /issues/8` is one route with a changed param, so this hook
  // keeps running across the jump — and it is the page that owns it, above the
  // keyed `Composer`, so the key cannot reach `pending`. Left alone, a failed
  // comment from card 7 would render its "sending failed" row on card 8 and
  // Retry would post card 7's body to card 8.
  //
  // `Composer` resets the same way, and for the same reason (T-317): together
  // they are what "the new card's composer is clean" means. Clearing from
  // inside the mutation's callbacks instead would not survive the argv the
  // failed send is retried with.
  const [pendingFor, setPendingFor] = useState(issueNumber);
  if (pendingFor !== issueNumber) {
    setPendingFor(issueNumber);
    setPending([]);
  }

  // A comment in flight or one whose send failed exists only here — the
  // editor was cleared the moment it was submitted — and a failed send is
  // exactly when someone reaches for the reload button.
  useDirtySource(() => pending.length > 0);

  const mutation = useMutation({
    mutationFn: (
      vars: Target & { key: number; body: string; kind: CommentKind },
    ) =>
      vars.kind === "action"
        ? api.createAction(vars.slug, vars.issueNumber, vars.body)
        : api.createComment(vars.slug, vars.issueNumber, vars.body),
    onSuccess: async (_created, vars) => {
      await queryClient.invalidateQueries({
        queryKey: ["timeline", vars.slug, vars.issueNumber],
      });
      setPending((prev) => prev.filter((p) => p.key !== vars.key));
    },
    onError: (_error, vars) => {
      setPending((prev) =>
        prev.map((p) => (p.key === vars.key ? { ...p, failed: true } : p)),
      );
    },
  });

  function send(body: string, target: Target, kind: CommentKind = "comment") {
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
          kind,
          component: null,
          created_at: new Date().toISOString(),
          edited_at: null,
          resolved_at: null,
          hidden_at: null,
          agent_context: null,
        },
      },
    ]);
    mutation.mutate({ ...target, key, body, kind });
  }

  function retry(key: number) {
    const entry = pending.find((p) => p.key === key);
    if (!entry) return;
    setPending((prev) =>
      prev.map((p) => (p.key === key ? { ...p, failed: false } : p)),
    );
    // This hook's own card, because it is the only one a retry can be for:
    // `pendingFor` above clears the list on a card change, so no failed row
    // survives the jump to be retried (T-317).
    mutation.mutate({
      slug,
      issueNumber,
      key,
      body: entry.comment.body,
      kind: entry.comment.kind === "action" ? "action" : "comment",
    });
  }

  /**
   * The slash-command path (T-161). No optimistic item: the submission also
   * changes fields, and a card that showed a comment while its `/close` was
   * still in flight would be showing a state the server may yet refuse. It
   * rejects on failure so the composer can keep the draft.
   */
  const commands = useMutation({
    mutationFn: (
      vars: Target & {
        body: string;
        commands: CommandInput[];
        kind: CommentKind;
      },
    ) =>
      api.submitCommands(vars.slug, vars.issueNumber, {
        body: vars.body,
        commands: vars.commands,
        // Left off for a plain comment, so the request is the one a server
        // predating T-575 already takes.
        ...(vars.kind === "action" ? { kind: vars.kind } : {}),
      }),
    onSuccess: async (_result, vars) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["timeline", vars.slug, vars.issueNumber],
        }),
        queryClient.invalidateQueries({
          queryKey: ["issue", vars.slug, vars.issueNumber],
        }),
        queryClient.invalidateQueries({ queryKey: ["issues", vars.slug] }),
      ]);
    },
  });

  return {
    pending,
    send,
    retry,
    sendWithCommands: (
      body: string,
      input: CommandInput[],
      target: Target,
      kind: CommentKind = "comment",
    ) => commands.mutateAsync({ ...target, body, commands: input, kind }),
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
  /** Whether that comment is a `/me` action (T-575). */
  action?: boolean;
}): string {
  if (state.uploading) return "Uploading…";
  if (state.running) return "Running…";
  if (state.broken > 0) {
    return `Fix ${state.broken === 1 ? "the command" : `${state.broken} commands`}`;
  }
  const verb = state.action ? "Post action" : "Comment";
  if (state.summaries.length === 0) return verb;
  const summary = summarizeCommands(state.summaries);
  if (!state.withComment && !state.action) return `Run: ${summary}`;
  // A comma once the summary carries its own "and", so the label never
  // reads "and … and …".
  return state.summaries.length === 1
    ? `${verb} and ${summary}`
    : `${verb}, ${summary}`;
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

const ACTION_WITH_FILES =
  "/me cannot carry files — post them in a comment of their own";

/** The folded phone composer's button, which opens the box (T-532). */
const OPENER = "[data-composer-opener]";

const NO_WATCHERS: readonly Watcher[] = [];

/**
 * Whether the reader is working in `root` (T-532). Focus arriving anywhere in
 * it engages; leaving disengages only once focus has gone somewhere outside.
 *
 * Three ways focus goes missing without the reader having left:
 * - Safari never focuses a clicked button, so pressing the attach button
 *   blurs the editor to nowhere. A press that started inside holds on.
 * - Switching tab or app blurs the editor too, and hands focus straight back
 *   on return.
 * - After that Safari click, nothing inside holds focus, so a later press
 *   outside will not produce a blur. The press itself has to disengage.
 *
 * A press outside while focus is still inside is left to the blur that
 * follows: a touch that starts a scroll moves no focus, and the box with the
 * keyboard up must not fold under the reader's caret.
 */
function useEngaged(root: RefObject<HTMLElement | null>): boolean {
  const [engaged, setEngaged] = useState(false);

  useEffect(() => {
    const host = root.current;
    if (host === null) return;
    const within = (node: unknown) =>
      node instanceof Node && host.contains(node);
    let pressing = false;

    const down = (event: PointerEvent) => {
      pressing = within(event.target);
      if (!pressing && !within(document.activeElement)) setEngaged(false);
    };
    const up = () => {
      pressing = false;
    };
    const focusIn = (event: FocusEvent) => {
      // The opener is focused by the very press that opens it, and unfolding
      // then would pull it out from under that press before its click
      // arrives. Its click focuses the editor instead.
      if (event.target instanceof Element && event.target.closest(OPENER)) {
        return;
      }
      setEngaged(true);
    };
    const focusOut = (event: FocusEvent) => {
      if (within(event.relatedTarget)) return;
      if (pressing || !document.hasFocus()) return;
      setEngaged(false);
    };

    const controller = new AbortController();
    const listen = { capture: true, passive: true, signal: controller.signal };
    document.addEventListener("pointerdown", down, listen);
    document.addEventListener("pointerup", up, listen);
    document.addEventListener("pointercancel", up, listen);
    host.addEventListener("focusin", focusIn, { signal: controller.signal });
    host.addEventListener("focusout", focusOut, { signal: controller.signal });
    return () => controller.abort();
  }, [root]);

  return engaged;
}

export function Composer({
  slug,
  issueNumber,
  onSend,
  onSendWithCommands,
  failed,
  onRetry,
  atEnd = false,
  watchers = NO_WATCHERS,
}: {
  slug: string;
  issueNumber: number;
  onSend: (body: string, target: Target, kind?: CommentKind) => void;
  onSendWithCommands: (
    body: string,
    commands: CommandInput[],
    target: Target,
    kind?: CommentKind,
  ) => Promise<unknown>;
  failed: PendingComment[];
  onRetry: (key: number) => void;
  /**
   * The page is scrolled to where the dock sits in flow. A folded phone
   * composer is a box there rather than a button (T-538): it covers nothing.
   */
  atEnd?: boolean;
  /** This card's card-level watchers (T-540). */
  watchers?: readonly Watcher[];
}) {
  const editor = useRef<MarkdownEditorHandle>(null);
  const [uploading, setUploading] = useState(false);
  const [running, setRunning] = useState(false);
  const [draft, setDraft] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const engaged = useEngaged(root);
  const staging = useStagedFiles();
  const queryClient = useQueryClient();
  const registry = useCommandRegistry(slug, "comment");
  const me = useQuery(meQuery);

  useQuoteSink((markdown) => {
    const handle = editor.current;
    if (handle === null) return;
    const current = handle.getValue();
    // A blank line on each side, topped up rather than added blindly: without
    // the one above, a quote landing straight after a paragraph reads as a
    // lazy continuation of it, and without the one below whatever the reader
    // types next joins the quote.
    const trailing = (/\n*$/.exec(current)?.[0] ?? "").length;
    const lead = current === "" ? "" : "\n".repeat(Math.max(0, 2 - trailing));
    handle.append(`${lead}${blockquote(markdown)}\n\n`);
    // Radix hands focus back to the menu trigger as it closes, and a
    // synchronous focus here loses to that restore.
    requestAnimationFrame(() => handle.focus());
  });

  // The extensions must keep one identity for the editor's lifetime: the
  // compartment reconfigures on a new one, which would close an open panel.
  // The registry therefore arrives through a ref, not through the closure.
  const registryRef = useRef(registry);
  registryRef.current = registry;
  const extensions = useMemo(
    () => [
      completionWith([
        refCompletionSource(slug, queryClient),
        mentionCompletionSource(slug, queryClient),
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
  const action = parsed?.action ?? null;
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
    ...(action !== null && staging.staged.length > 0
      ? [{ line: `/me ${action}`, reason: ACTION_WITH_FILES }]
      : []),
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
    commands.length === 0 &&
    action === null;
  // Folding an empty box is what keeps it from taking the screen (T-532); one
  // holding anything stays open, because the draft is the only copy of it.
  //
  // A broken command line counts as content even though `empty` cannot see it:
  // it yields neither a body nor a command, so a draft that is nothing else
  // reads as empty while still rendering its error block. That error block is
  // then the one thing that can outlive the buttons explaining what to do
  // about it — and the next card drops it along with the draft it came from,
  // because `issue-detail.tsx` keys this component by card number (T-317).
  const expanded = engaged || !empty || broken.length > 0;
  const opener = !expanded && !atEnd;
  const label = submitLabel({
    uploading,
    running,
    broken: broken.length,
    summaries: parsed?.summaries ?? [],
    withComment: (parsed?.body ?? "") !== "" || staging.staged.length > 0,
    action: action !== null,
  });

  async function submit() {
    if (uploading || running) return;
    // The card this draft belongs to, read before the first `await`: the page
    // keys this component by card number, so its props name the card the draft
    // was written on for as long as it is mounted — but an upload outlives it,
    // and the page hook this calls back into has moved to the next card by
    // then.
    const target: Target = { slug, issueNumber };
    const raw = editor.current?.getValue() ?? "";
    // Re-parsed from the document rather than trusting the onChange mirror:
    // the text at submit time is what gets executed.
    const current =
      registry === null
        ? {
            body: raw.trim(),
            commands: [],
            action: null,
            invalid: [],
            summaries: [],
          }
        : parseCommandLines(raw, registry);
    if (current.invalid.length > 0) return;
    if (current.action !== null && staging.staged.length > 0) return;
    if (
      current.body === "" &&
      current.commands.length === 0 &&
      current.action === null &&
      staging.staged.length === 0
    ) {
      return;
    }
    const kind: CommentKind = current.action === null ? "comment" : "action";

    let full = current.action ?? current.body;
    if (staging.staged.length > 0) {
      setUploading(true);
      try {
        const markers = await staging.uploadAll(
          target.slug,
          target.issueNumber,
        );
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
            : await queryClient.fetchQuery(
                allCommentsQuery(target.slug, target.issueNumber),
              );
        const resolved = resolveDraftCommands(current.commands, items);
        if (resolved.length === 0) return;
        const result = (await onSendWithCommands(
          full,
          resolved,
          target,
          kind,
        )) as CommandSubmitResult | undefined;
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
      onSend(full, target, kind);
    }
    editor.current?.setValue("");
    setDraft("");
    staging.clear();
  }

  return (
    <div
      ref={root}
      className="space-y-2"
      // The dock in `issue-detail.tsx` styles itself off this.
      data-collapsed={expanded ? undefined : ""}
    >
      {failed.map((entry) => (
        <div
          key={entry.key}
          // Opaque and clickable over the see-through dock a folded phone
          // composer leaves behind.
          className="pointer-events-auto flex items-center justify-between rounded-md border border-destructive/40 bg-background px-3 py-1.5 text-sm text-destructive"
        >
          <span className="truncate">Failed to send: {entry.comment.body}</span>
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
      {action !== null && me.data !== undefined && (
        <div
          role="status"
          aria-label="action preview"
          className="flex flex-wrap items-baseline gap-x-2 rounded-md border border-border px-3 py-1.5 text-sm"
        >
          <UserChip user={me.data} nameClassName="font-medium" link={false} />
          <span className="min-w-0 wrap-anywhere">{action}</span>
        </div>
      )}
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
      {/* On a phone mid-timeline the floating button carries the watchers
          instead, so the line would only cover the timeline twice. */}
      <ComposerWatchersLine
        slug={slug}
        issueNumber={issueNumber}
        watchers={watchers}
        className={cn(opener && "max-sm:hidden")}
      />
      <form
        className="flex flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <MarkdownEditor
          ref={editor}
          ariaLabel="Write a comment"
          placeholder={
            expanded
              ? "Write a comment… (#N references other issues, / runs a command, < inserts a collapsible block; paste or drop files)"
              : "Write a comment…"
          }
          // Sticky at the viewport bottom: an auto-growing draft must not
          // swallow the page, especially on small/mobile viewports. Folded on
          // a phone away from the page end it leaves only the button below; `sr-only` rather than
          // unmounted, because that button has to focus it inside the tap
          // for iOS to raise the keyboard.
          className={cn(
            "max-h-[40dvh]",
            expanded && "min-h-16",
            opener && "max-sm:sr-only",
          )}
          extensions={extensions}
          onChange={setDraft}
          onPaste={staging.onPaste}
          onDrop={staging.onDrop}
          onDragOver={staging.onDragOver}
          onSubmit={() => void submit()}
        />
        {/* Centred, not in a corner: the bottom corners are where a phone's
            edge swipes start. */}
        {opener && (
          <div className="flex justify-center sm:hidden">
            <Button
              type="button"
              data-composer-opener=""
              className="pointer-events-auto rounded-full shadow-lg"
              onClick={() => editor.current?.focus()}
              aria-label={
                watchers.length > 0 ? openerLabel(watchers) : undefined
              }
            >
              <MessageSquarePlusIcon className="size-4" /> Comment
              {/* Display only: the whole button still opens the editor, and
                  an interactive element inside a button is invalid. */}
              {watchers.length > 0 && (
                <>
                  <span aria-hidden className="mx-1 h-4 w-px bg-current/30" />
                  <WatcherStack
                    watchers={watchers}
                    aria-hidden
                    ringClassName="ring-primary"
                  />
                </>
              )}
            </Button>
          </div>
        )}
        {/* The buttons get a row of their own (attach left, submit right —
            the same layout as the issue-body, edit-comment and new-issue
            editors) because `submitLabel` grows with the commands it parsed:
            "Comment, move to In Progress and label bug" beside the editor
            takes its width from the editor. Not rendered rather than hidden,
            so an invisible button cannot sit in the tab order. */}
        {expanded && (
          <div className="composer-actions-in mt-2 flex h-7 items-start justify-between gap-2">
            <div className="flex items-center gap-1">
              <StagedFileUploadButton
                onFiles={staging.stage}
                disabled={uploading}
              />
              <EditorShortcutsHelp />
            </div>
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
