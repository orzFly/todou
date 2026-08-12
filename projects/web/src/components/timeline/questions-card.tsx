import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Question,
  QuestionAnswer,
  QuestionAnswerInput,
  QuestionsComponent,
} from "@todou/shared";
import {
  CheckIcon,
  CircleIcon,
  CircleSlashIcon,
  SquareCheckIcon,
  SquareIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/queries.ts";
import { questionsQuery } from "@/api/questions.ts";
import { MarkdownView } from "@/components/shared/markdown-view.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type Draft = { selected: Set<number>; other: string; declined: boolean };

const emptyDraft = (): Draft => ({
  selected: new Set(),
  other: "",
  declined: false,
});

const resolved = (d: Draft): boolean =>
  d.selected.size > 0 || d.other.trim() !== "" || d.declined;

/** Markdown that sits inside an option row: kill the paragraph margins. */
function InlineMarkdown({
  slug,
  issueNumber,
  children,
  className = "",
}: {
  slug: string;
  issueNumber: number;
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
 * The interactive tail of a question comment (#19). One submission covers
 * every question and is final — answered cards render read-only.
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
}) {
  const status = useQuery(questionsQuery(slug, issueNumber));
  const answer =
    status.data?.items.find((i) => i.comment_id === commentId)?.answer ?? null;

  if (answer) {
    return (
      <div className="mt-1 space-y-3 rounded-md border bg-muted/20 p-3">
        {component.questions.map((q) => (
          <AnsweredQuestion
            key={q.key}
            slug={slug}
            issueNumber={issueNumber}
            question={q}
            record={answer.answers.find((a) => a.key === q.key)}
          />
        ))}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <CheckIcon className="size-3.5 text-green-600" />
          answered by <UserChip user={answer.actor} compact />
          <span title={answer.created_at}>
            {new Date(answer.created_at).toLocaleString()}
          </span>
        </div>
      </div>
    );
  }
  return (
    <AnswerForm
      slug={slug}
      issueNumber={issueNumber}
      commentId={commentId}
      component={component}
      // Answer state may still be loading; blocking submit (not input) is
      // enough — the POST is atomic and conflicts loudly on a double-answer.
      ready={status.isSuccess}
    />
  );
}

function AnswerForm({
  slug,
  issueNumber,
  commentId,
  component,
  ready,
}: {
  slug: string;
  issueNumber: number;
  commentId: number;
  component: QuestionsComponent;
  ready: boolean;
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(component.questions.map((q) => [q.key, emptyDraft()])),
  );
  const queryClient = useQueryClient();
  const submit = useMutation({
    mutationFn: () => {
      const answers: QuestionAnswerInput[] = component.questions.map((q) => {
        const d = drafts[q.key] ?? emptyDraft();
        return {
          key: q.key,
          selected: [...d.selected].sort((a, b) => a - b),
          ...(d.other.trim() === "" ? {} : { other: d.other }),
          declined: d.declined,
        };
      });
      return api.submitAnswers(slug, issueNumber, commentId, { answers });
    },
    onSuccess: () => {
      for (const key of [
        ["questions", slug, issueNumber],
        ["timeline", slug, issueNumber],
        ["issue", slug, issueNumber],
        ["issues", slug],
      ]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    },
    onError: (error) => {
      toast.error(error.message);
      // A conflict means someone answered first; show their answers.
      queryClient.invalidateQueries({
        queryKey: ["questions", slug, issueNumber],
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
      <div className="flex items-center justify-between">
        <Badge
          variant="outline"
          className="border-amber-500/60 text-amber-700 dark:text-amber-400"
        >
          awaiting answer
        </Badge>
        <span className="text-xs text-muted-foreground">
          one submission answers everything · final
        </span>
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
        />
      ))}
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={!ready || !complete || submit.isPending}
          onClick={() => submit.mutate()}
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
}: {
  slug: string;
  issueNumber: number;
  question: Question;
  draft: Draft;
  disabled: boolean;
  onChange: (update: (d: Draft) => Draft) => void;
}) {
  const toggleOption = (index: number) =>
    onChange((d) => {
      const selected = new Set(question.multiple ? d.selected : []);
      if (question.multiple && d.selected.has(index)) selected.delete(index);
      else selected.add(index);
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
              onClick={() => toggleOption(index)}
              aria-pressed={active}
              className={`flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left text-sm transition-colors ${
                active
                  ? "border-primary bg-primary/10"
                  : "border-transparent hover:bg-muted/60"
              }`}
            >
              <span className="mt-0.5 shrink-0 text-muted-foreground">
                {active ? (
                  <OnIcon className="size-4 text-primary" />
                ) : (
                  <OffIcon className="size-4" />
                )}
              </span>
              <span className="min-w-0 space-y-0.5">
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
          onClick={toggleDecline}
          aria-pressed={draft.declined}
          className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm transition-colors ${
            draft.declined
              ? "border-destructive/60 bg-destructive/10"
              : "border-transparent text-muted-foreground hover:bg-muted/60"
          }`}
        >
          <CircleSlashIcon
            className={`size-4 shrink-0 ${draft.declined ? "text-destructive" : ""}`}
          />
          Decline to answer
        </button>
      </div>
      <Textarea
        value={draft.other}
        disabled={disabled}
        onChange={(e) => {
          const other = e.target.value;
          onChange((d) => ({ ...d, other }));
        }}
        rows={1}
        placeholder={
          draft.declined
            ? "Why not? (optional, markdown)"
            : "Other / additional thoughts… (optional, markdown; combines with selections)"
        }
        className="min-h-8 text-sm"
      />
    </fieldset>
  );
}

function AnsweredQuestion({
  slug,
  issueNumber,
  question,
  record,
}: {
  slug: string;
  issueNumber: number;
  question: Question;
  record: QuestionAnswer | undefined;
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
                active ? "bg-primary/10" : "text-muted-foreground/70"
              }`}
            >
              <span className="mt-0.5 w-4 shrink-0">
                {active && <CheckIcon className="size-4 text-primary" />}
              </span>
              <InlineMarkdown slug={slug} issueNumber={issueNumber}>
                {option.label}
              </InlineMarkdown>
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
            <InlineMarkdown slug={slug} issueNumber={issueNumber}>
              {record.other}
            </InlineMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
