import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AnsweredComment,
  Question,
  QuestionAnswer,
  QuestionAnswerInput,
  QuestionsComponent,
} from "@todou/shared";
import { answerRecordOf } from "@todou/shared";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleIcon,
  CircleSlashIcon,
  SquareCheckIcon,
  SquareIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/queries.ts";
import { questionsQuery } from "@/api/questions.ts";
import { MarkdownEditor } from "@/components/shared/markdown-editor.tsx";
import { MarkdownView } from "@/components/shared/markdown-view.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import type { Target } from "@/components/timeline/comment-item.tsx";
import { useTimelineAnswer } from "@/components/timeline/timeline-answers.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useRefCompletion } from "@/lib/editor/ref-completion.ts";
import { useDirtySource } from "@/lib/unsaved-guard.ts";

type Draft = { selected: Set<number>; other: string; declined: boolean };

const emptyDraft = (): Draft => ({
  selected: new Set(),
  other: "",
  declined: false,
});

const resolved = (d: Draft): boolean =>
  d.selected.size > 0 || d.other.trim() !== "" || d.declined;

/**
 * The submission's payload, assembled at the `mutate()` call rather than
 * by the mutation itself. `drafts` is component state and does not reset
 * when the card under it is swapped, while `component` is a prop that
 * does — read together at the wrong moment they pair the new card's keys
 * with empty answers, and a sealed target would deliver that to the old
 * card accurately.
 */
const answersOf = (
  drafts: Record<string, Draft>,
  component: QuestionsComponent,
): QuestionAnswerInput[] =>
  component.questions.map((q) => {
    const d = drafts[q.key] ?? emptyDraft();
    return {
      key: q.key,
      selected: [...d.selected].sort((a, b) => a - b),
      ...(d.other.trim() === "" ? {} : { other: d.other }),
      declined: d.declined,
    };
  });

type SubmitVars = Target & { answers: QuestionAnswerInput[] };

/**
 * A drag that selects text inside a row still fires the row's click (measured
 * on Chromium 151), so copying an option's text would answer the question.
 * The selection is already built by the time the handler runs; a plain click
 * leaves it collapsed, even when the page had a stale selection elsewhere.
 */
function selectingInside(row: HTMLElement): boolean {
  const sel = window.getSelection();
  return (
    sel !== null &&
    !sel.isCollapsed &&
    sel.focusNode !== null &&
    row.contains(sel.focusNode)
  );
}

/**
 * Markdown that sits inside an option row: kill the paragraph margins.
 * Those rows are horizontal flex, so whichever item holds markdown carries
 * `flex-1` — a code fence has no intrinsic width of its own, see `CodeBlock`.
 */
function InlineMarkdown({
  slug,
  issueNumber,
  children,
  className = "",
}: {
  slug: string;
  issueNumber: number;
  /** created_at of the content this text belongs to (T-80 time cutoff). */
  children: string;
  className?: string;
}) {
  return (
    <div className={`min-w-0 [&_.markdown-body>p]:m-0 ${className}`}>
      <MarkdownView slug={slug} issueNumber={issueNumber}>
        {children}
      </MarkdownView>
    </div>
  );
}

/**
 * The interactive tail of a question comment (T-19). One submission covers
 * every question and is final — answered cards render read-only.
 *
 * The answer comes from three sources in order (T-365): the loaded
 * timeline's `question_answered` event, this mount's own submission, and
 * only then `/questions`. A card none of them settles yet renders the
 * neutral state — "unknown" is not "unanswered", and the amber form
 * asserts the latter.
 */
export function QuestionsCard({
  slug,
  issueNumber,
  commentId,
  component,
}: {
  slug: string;
  issueNumber: number;
  commentId: number;
  component: QuestionsComponent;
  /** The question comment's created_at (T-80 time cutoff). */
}) {
  const fromTimeline = useTimelineAnswer(commentId);
  const [submitted, setSubmitted] = useState<AnsweredComment | null>(null);
  const established = fromTimeline ?? submitted;
  const status = useQuery({
    ...questionsQuery(slug, issueNumber),
    // Sent only when the timeline and this mount's own submission both
    // prove nothing — commonly the answer is already in the loaded window,
    // and then this request never goes out.
    enabled: established === null,
  });
  const answered =
    established ??
    status.data?.items.find((i) => i.comment_id === commentId)?.answer ??
    null;

  if (answered) {
    const hasDescriptions = component.questions.some((q) =>
      q.options.some((o) => o.description !== undefined),
    );
    // The /questions item carries the comment id outside the answer shape;
    // the other two sources carry it inside. Same five fields either way.
    return (
      <AnsweredCard
        slug={slug}
        issueNumber={issueNumber}
        component={component}
        answer={established ?? { comment_id: commentId, ...answered }}
        hasDescriptions={hasDescriptions}
      />
    );
  }
  if (status.isSuccess) {
    return (
      <AnswerForm
        slug={slug}
        issueNumber={issueNumber}
        commentId={commentId}
        component={component}
        onAnswered={(record) => {
          if (record.comment_id === commentId) setSubmitted(record);
        }}
      />
    );
  }
  // Neutral: the verdict is not established. The answered card's grey frame
  // and its read-only rows say exactly that much and nothing more; the
  // footer slot — the one cell whose content the verdict decides — waits
  // as a skeleton, or names the failure when /questions failed.
  return (
    <div className="mt-1 space-y-3 rounded-md border bg-muted/20 p-3">
      {component.questions.map((q) => (
        <AnsweredQuestion
          key={q.key}
          slug={slug}
          issueNumber={issueNumber}
          question={q}
          known={false}
        />
      ))}
      {status.isError ? (
        <p className="text-xs text-destructive" title={status.error.message}>
          Failed to load answer status — retrying may help.
        </p>
      ) : (
        <Skeleton className="h-4 w-40" />
      )}
    </div>
  );
}

function AnsweredCard({
  slug,
  issueNumber,
  component,
  answer,
  hasDescriptions,
}: {
  slug: string;
  issueNumber: number;
  component: QuestionsComponent;
  /**
   * The established verdict: `AnsweredComment` from the timeline and this
   * mount's own submission, the `/questions` item's `answer` shape from
   * the request — field-for-field the same.
   */
  answer: AnsweredComment;
  hasDescriptions: boolean;
}) {
  const [showDescriptions, setShowDescriptions] = useState(false);
  return (
    <div className="mt-1 space-y-3 rounded-md border bg-muted/20 p-3">
      {component.questions.map((q) => (
        <AnsweredQuestion
          key={q.key}
          slug={slug}
          issueNumber={issueNumber}
          question={q}
          record={answer.answers.find((a) => a.key === q.key)}
          showDescriptions={showDescriptions}
          known
        />
      ))}
      {/*
        The toggle beside this group is a `Button` — `shrink-0 whitespace-nowrap`
        in its base class. Unwrapped, a narrow viewport takes every missing pixel
        out of this group alone, crushing it and still overflowing sideways (T-362).
      */}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <CheckIcon className="size-3.5 shrink-0 text-green-600" />
          answered by <UserChip user={answer.actor} compact />
          <span className="whitespace-nowrap" title={answer.created_at}>
            {new Date(answer.created_at).toLocaleString()}
          </span>
        </span>
        {hasDescriptions && (
          <Button
            variant="ghost"
            size="xs"
            aria-expanded={showDescriptions}
            onClick={() => setShowDescriptions((v) => !v)}
          >
            {showDescriptions ? <ChevronUpIcon /> : <ChevronDownIcon />}
            {showDescriptions
              ? "hide option descriptions"
              : "show option descriptions"}
          </Button>
        )}
      </div>
    </div>
  );
}

function AnswerForm({
  slug,
  issueNumber,
  commentId,
  component,
  onAnswered,
}: {
  slug: string;
  issueNumber: number;
  commentId: number;
  component: QuestionsComponent;
  /** Fed the POST's own event, so the answered screen is immediate. */
  onAnswered: (record: AnsweredComment) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(component.questions.map((q) => [q.key, emptyDraft()])),
  );
  // Options and "decline" are not text and have no editor of their own, so
  // nothing else on this card would notice them going up in smoke. The Other
  // box is a MarkdownEditor and registers itself.
  useDirtySource(() =>
    Object.values(drafts).some((d) => d.selected.size > 0 || d.declined),
  );
  const queryClient = useQueryClient();
  const target: Target = { slug, issueNumber, commentId };
  const submit = useMutation({
    mutationFn: (vars: SubmitVars) =>
      api.submitAnswers(vars.slug, vars.issueNumber, vars.commentId, {
        answers: vars.answers,
      }),
    onSuccess: (result, vars) => {
      const record = answerRecordOf(result);
      if (record !== null) onAnswered(record);
      for (const key of [
        ["questions", vars.slug, vars.issueNumber],
        ["timeline", vars.slug, vars.issueNumber],
        ["issue", vars.slug, vars.issueNumber],
        ["issues", vars.slug],
      ]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    },
    onError: (error, vars) => {
      toast.error(error.message);
      // A conflict means someone answered first; show their answers.
      queryClient.invalidateQueries({
        queryKey: ["questions", vars.slug, vars.issueNumber],
      });
    },
  });

  const patch = (key: string, update: (d: Draft) => Draft) =>
    setDrafts((prev) => ({
      ...prev,
      [key]: update(prev[key] ?? emptyDraft()),
    }));

  const complete = component.questions.every((q) =>
    resolved(drafts[q.key] ?? emptyDraft()),
  );

  return (
    <div className="mt-1 space-y-4 rounded-md border border-amber-500/60 bg-amber-500/5 p-3">
      <div className="flex">
        <Badge
          variant="outline"
          className="border-amber-500/60 text-amber-700 dark:text-amber-400"
        >
          awaiting answer
        </Badge>
      </div>
      {component.questions.map((q) => (
        <QuestionForm
          key={q.key}
          slug={slug}
          issueNumber={issueNumber}
          question={q}
          draft={drafts[q.key] ?? emptyDraft()}
          disabled={submit.isPending}
          onChange={(update) => patch(q.key, update)}
          // The two conditions the submit button carries, written again
          // here: a disabled button cannot intercept a keystroke, and this
          // submission is final — a card's questions can be answered once.
          onSubmit={() => {
            if (!complete || submit.isPending) return;
            submit.mutate({ ...target, answers: answersOf(drafts, component) });
          }}
        />
      ))}
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={!complete || submit.isPending}
          onClick={() =>
            submit.mutate({ ...target, answers: answersOf(drafts, component) })
          }
        >
          {submit.isPending
            ? "Submitting…"
            : complete
              ? "Submit answers"
              : "Answer every question to submit"}
        </Button>
      </div>
    </div>
  );
}

function QuestionForm({
  slug,
  issueNumber,
  question,
  draft,
  disabled,
  onChange,
  onSubmit,
}: {
  slug: string;
  issueNumber: number;
  question: Question;
  draft: Draft;
  disabled: boolean;
  onChange: (update: (d: Draft) => Draft) => void;
  /** Ctrl-Enter in this question's "Other" box submits the whole form. */
  onSubmit: () => void;
}) {
  const toggleOption = (index: number) =>
    onChange((d) => {
      if (d.selected.has(index)) {
        const selected = new Set(d.selected);
        selected.delete(index);
        // No `declined: false` here — a selection can only exist while it
        // already is false.
        return { ...d, selected };
      }
      const selected = new Set(question.multiple ? d.selected : []);
      selected.add(index);
      // Picking any option withdraws a decline — they are exclusive.
      return { ...d, selected, declined: false };
    });
  const toggleDecline = () =>
    onChange((d) =>
      d.declined
        ? { ...d, declined: false }
        : { ...d, declined: true, selected: new Set() },
    );

  const OnIcon = question.multiple ? SquareCheckIcon : CheckIcon;
  const OffIcon = question.multiple ? SquareIcon : CircleIcon;
  const refCompletion = useRefCompletion(slug);

  return (
    <fieldset className="space-y-1.5" data-question-key={question.key}>
      <legend className="w-full space-y-1">
        {question.header !== undefined && (
          <InlineMarkdown
            slug={slug}
            issueNumber={issueNumber}
            className="text-xs font-semibold text-muted-foreground uppercase"
          >
            {question.header}
          </InlineMarkdown>
        )}
        <InlineMarkdown slug={slug} issueNumber={issueNumber}>
          {question.question}
        </InlineMarkdown>
      </legend>
      <div className="space-y-1">
        {question.options.map((option, index) => {
          const active = draft.selected.has(index);
          return (
            <button
              key={option.label}
              type="button"
              disabled={disabled}
              onClick={(e) => {
                if (selectingInside(e.currentTarget)) return;
                toggleOption(index);
              }}
              aria-pressed={active}
              className={`flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left text-sm transition-colors select-text ${
                active
                  ? "border-primary bg-primary/10 enabled:hover:bg-primary/20"
                  : "border-transparent enabled:hover:border-foreground/40 enabled:hover:bg-foreground/6"
              }`}
            >
              <span className="mt-0.5 shrink-0 text-muted-foreground">
                {active ? (
                  <OnIcon className="size-4 text-primary" />
                ) : (
                  <OffIcon className="size-4" />
                )}
              </span>
              <span className="min-w-0 flex-1 space-y-0.5">
                <InlineMarkdown slug={slug} issueNumber={issueNumber}>
                  {option.label}
                </InlineMarkdown>
                {option.description !== undefined && (
                  <InlineMarkdown
                    slug={slug}
                    issueNumber={issueNumber}
                    className="text-xs text-muted-foreground"
                  >
                    {option.description}
                  </InlineMarkdown>
                )}
              </span>
            </button>
          );
        })}
        <button
          type="button"
          disabled={disabled}
          onClick={(e) => {
            if (selectingInside(e.currentTarget)) return;
            toggleDecline();
          }}
          aria-pressed={draft.declined}
          className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm transition-colors select-text ${
            draft.declined
              ? "border-destructive/60 bg-destructive/10 enabled:hover:bg-destructive/20"
              : "border-transparent text-muted-foreground enabled:hover:border-foreground/40 enabled:hover:bg-foreground/6"
          }`}
        >
          <CircleSlashIcon
            className={`size-4 shrink-0 ${draft.declined ? "text-destructive" : ""}`}
          />
          Decline to answer
        </button>
      </div>
      <MarkdownEditor
        initialValue={draft.other}
        readOnly={disabled}
        ariaLabel="Other / additional thoughts"
        onChange={(other) => {
          onChange((d) => ({ ...d, other }));
        }}
        placeholder={
          draft.declined
            ? "Why not? (optional, markdown)"
            : "Other / additional thoughts… (optional, markdown; combines with selections)"
        }
        className="min-h-8"
        extensions={refCompletion}
        onSubmit={onSubmit}
      />
    </fieldset>
  );
}

/**
 * One question rendered read-only. `known` is false while the verdict is
 * still unestablished (T-365): no row is marked picked or dimmed, and the
 * icon column stays empty — the row asserts nothing either way.
 */
function AnsweredQuestion({
  slug,
  issueNumber,
  question,
  record,
  showDescriptions = false,
  known,
}: {
  slug: string;
  issueNumber: number;
  question: Question;
  record?: QuestionAnswer;
  showDescriptions?: boolean;
  /** Whether the answer this row renders is established. */
  known: boolean;
}) {
  const chosen = new Set(record?.selected.map((s) => s.index) ?? []);
  return (
    <div className="space-y-1.5" data-question-key={question.key}>
      <div className="space-y-1">
        {question.header !== undefined && (
          <InlineMarkdown
            slug={slug}
            issueNumber={issueNumber}
            className="text-xs font-semibold text-muted-foreground uppercase"
          >
            {question.header}
          </InlineMarkdown>
        )}
        <InlineMarkdown slug={slug} issueNumber={issueNumber}>
          {question.question}
        </InlineMarkdown>
      </div>
      <div className="space-y-0.5">
        {question.options.map((option, index) => {
          const active = chosen.has(index);
          return (
            <div
              key={option.label}
              className={`flex items-start gap-2 rounded-md px-2 py-1 text-sm ${
                known
                  ? active
                    ? "bg-primary/10"
                    : "text-muted-foreground/70"
                  : ""
              }`}
            >
              <span className="mt-0.5 w-4 shrink-0">
                {known && active && (
                  <CheckIcon className="size-4 text-primary" />
                )}
              </span>
              <div className="min-w-0 flex-1 space-y-0.5">
                <InlineMarkdown slug={slug} issueNumber={issueNumber}>
                  {option.label}
                </InlineMarkdown>
                {showDescriptions && option.description !== undefined && (
                  // No `text-muted-foreground`: the description inherits the
                  // row's own color, so an unpicked option stays dimmer than
                  // the picked one instead of outshining its own label.
                  <InlineMarkdown
                    slug={slug}
                    issueNumber={issueNumber}
                    className="text-xs opacity-80"
                  >
                    {option.description}
                  </InlineMarkdown>
                )}
              </div>
            </div>
          );
        })}
        {record?.declined && (
          <div className="flex items-center gap-2 px-2 py-1 text-sm text-destructive">
            <CircleSlashIcon className="size-4 shrink-0" /> declined to answer
          </div>
        )}
        {record?.other != null && (
          <div className="flex items-start gap-2 px-2 py-1 text-sm">
            <span className="mt-0.5 shrink-0 text-xs text-muted-foreground">
              other:
            </span>
            <InlineMarkdown
              slug={slug}
              issueNumber={issueNumber}
              className="flex-1"
            >
              {record.other}
            </InlineMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
