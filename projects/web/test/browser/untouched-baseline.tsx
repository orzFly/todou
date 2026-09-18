import type {
  Agent,
  AnsweredComment,
  Issue,
  Label,
  Me,
  Member,
  QuestionsComponent,
  Status,
} from "@todou/shared";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { AssigneePicker } from "@/components/issue/assignee-picker.tsx";
import { IssueRow, IssueRowMeta } from "@/components/issue/issue-row.tsx";
import { AddAgentPicker } from "@/components/shared/add-agent-picker.tsx";
import {
  AuthTargetFieldset,
  useTargetSelection,
} from "@/components/shared/auth-target-picker.tsx";
import { MentionLink } from "@/components/shared/mention-link.tsx";
import { QuestionsCard } from "@/components/timeline/questions-card.tsx";
import { TimelineAnswersProvider } from "@/components/timeline/timeline-answers.tsx";
import { BoardCardContent } from "@/pages/board.tsx";

export type UntouchedBaselineQuestion = {
  commentId: number;
  component: QuestionsComponent;
  answer: AnsweredComment;
};

/** Values read from the browser fixture's real, neutral API seed. */
export type UntouchedBaselineData = {
  slug: string;
  issue: Issue;
  me: Me;
  agents: Agent[];
  members: Member[];
  statuses: Status[];
  labels: Label[];
  answeredQuestion?: UntouchedBaselineQuestion;
};

type Gap = { key: string; reason: string };

/**
 * These rows are private to a route or own the application's top-level shell.
 * Reproducing their surrounding board/list/sidebar/table markup here would make
 * a synthetic sample look authoritative, so they stay machine-readable gaps.
 */
export const UNTOUCHED_BASELINE_GAPS: readonly Gap[] = [
  {
    key: "shell-account",
    reason:
      "The account control is private to AppShell, whose top-level shell and event stream cannot be nested in this fixture.",
  },
  {
    key: "grant-access-admins",
    reason:
      "The exported card shows administrator chips only to a seeded non-admin viewer; the neutral fixture owner is an admin.",
  },
  {
    key: "issue-detail-assignees",
    reason: "The assignee row is private to the strict issue-detail route.",
  },
  {
    key: "new-issue-assignees",
    reason:
      "The selected-assignee row is private to the strict new-issue route.",
  },
  {
    key: "project-settings-members",
    reason:
      "The member table row is private to the strict project-settings route.",
  },
  {
    key: "project-settings-denied-user",
    reason:
      "The denied-user table row is private to the strict project-settings route.",
  },
  {
    key: "project-settings-denied-by",
    reason:
      "The denying-user table row is private to the strict project-settings route.",
  },
  {
    key: "issue-hover-card-assignees",
    reason:
      "Deferred: the real hover-card portal needs isolated browser activation.",
  },
  {
    key: "agents-settings-table",
    reason:
      "Deferred: the full settings page needs auxiliary agent-membership cache data.",
  },
  {
    key: "user-profile-avatar",
    reason:
      "Deferred: the full profile page needs its user and section API caches.",
  },
];

function identifyTargets(scope: Element): Set<Element> {
  const targets = new Set<Element>();

  for (const mention of scope.querySelectorAll<HTMLElement>(
    "[data-mention-link]",
  )) {
    mention.dataset.untouchedTarget = "mention";
    targets.add(mention);
  }

  for (const avatar of scope.querySelectorAll<HTMLElement>(
    '[data-slot="avatar"]',
  )) {
    avatar.dataset.untouchedTarget = "avatar";
    targets.add(avatar);

    if (avatar.closest("[data-mention-link]")) continue;
    const chip = avatar.closest<HTMLElement>(
      'a[href^="/users/"], span[class~="inline-block"][class~="whitespace-nowrap"]',
    );
    if (chip && scope.contains(chip)) {
      chip.dataset.untouchedTarget = "user-chip";
      targets.add(chip);
    }
  }

  return targets;
}

/**
 * Radix popovers live under document.body. Their real trigger names the real
 * content with aria-controls, so identify that content without rebuilding it.
 */
function identifyControlledPortals(
  root: HTMLElement,
  caseKey: string,
): Set<Element> {
  const targets = identifyTargets(root);
  for (const trigger of root.querySelectorAll<HTMLElement>("[aria-controls]")) {
    const controlledId = trigger.getAttribute("aria-controls");
    const controlled = controlledId
      ? document.getElementById(controlledId)
      : null;
    if (!controlled) continue;
    controlled.dataset.untouchedPortalFor = caseKey;
    for (const target of identifyTargets(controlled)) targets.add(target);
  }
  return targets;
}

function UntouchedCase({
  caseKey,
  children,
}: {
  caseKey: string;
  children: ReactNode;
}) {
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const mark = () => {
      const targets = identifyControlledPortals(element, caseKey);
      element.toggleAttribute("data-untouched-ready", targets.size > 0);
    };
    mark();
    const observer = new MutationObserver(mark);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-controls"],
    });
    return () => observer.disconnect();
  }, [caseKey]);

  return (
    <section ref={root} data-untouched-case={caseKey}>
      {children}
    </section>
  );
}

function UntouchedGap({ name, reason }: { name: string; reason: string }) {
  return (
    <p data-untouched-gap={name}>
      {name}: {reason}
    </p>
  );
}

function AuthTargetSample({ me, agents }: { me: Me; agents: Agent[] }) {
  const firstActive = agents.find((agent) => agent.disabled_at === null);
  const picker = useTargetSelection(
    agents,
    null,
    firstActive ? { kind: "agent", id: firstActive.id } : { kind: "me" },
  );
  return <AuthTargetFieldset me={me} picker={picker} allowNew={false} />;
}

function AnsweredQuestionSample({
  slug,
  issueNumber,
  question,
}: {
  slug: string;
  issueNumber: number;
  question: UntouchedBaselineQuestion;
}) {
  const answers = useMemo(
    () => new Map([[question.commentId, question.answer]]),
    [question],
  );
  return (
    <TimelineAnswersProvider answers={answers}>
      <QuestionsCard
        slug={slug}
        issueNumber={issueNumber}
        commentId={question.commentId}
        component={question.component}
      />
    </TimelineAnswersProvider>
  );
}

/**
 * Mount under the existing browser fixture's QueryClientProvider and private
 * RouterProvider, not as a second createRoot entry. Query-backed children read
 * the real API using that provider's cache (members, preferences, project
 * references, and read state); data is not an API mock.
 * Only answered questions need an extra provider, supplied locally above.
 *
 * The issue list case measures exported row/meta descendants only: it does not
 * claim coverage of the list's private outer grid. The board case similarly
 * measures exported card content, not its private draggable wrapper.
 */
export function UntouchedBaselineSamples({
  data,
}: {
  data: UntouchedBaselineData;
}) {
  const { slug, issue, me, agents, members, statuses, labels } = data;
  const { body: _body, ...issueItem } = issue;
  const memberIds = useMemo(
    () => new Set(members.map((member) => member.user.id)),
    [members],
  );
  const hasUnassignedAgent = agents.some(
    (agent) => agent.disabled_at === null && !memberIds.has(agent.id),
  );
  const mentioned = members[0]?.user;
  const hasAssignee = issue.assignees.length > 0;

  return (
    <div className="space-y-6">
      {hasAssignee ? (
        <>
          <UntouchedCase caseKey="issue-list-assignees">
            <IssueRow
              slug={slug}
              issue={issueItem}
              specAwaitingReview={false}
              meta={
                <IssueRowMeta
                  issue={issueItem}
                  statuses={statuses}
                  allLabels={labels}
                  onStatus={() => undefined}
                  onToggleLabel={() => undefined}
                />
              }
            />
          </UntouchedCase>
          <UntouchedCase caseKey="board-card-assignees">
            <BoardCardContent slug={slug} issue={issueItem} />
          </UntouchedCase>
        </>
      ) : (
        <>
          <UntouchedGap
            name="issue-list-assignees"
            reason="The API seed must assign at least one member to the issue."
          />
          <UntouchedGap
            name="board-card-assignees"
            reason="The API seed must assign at least one member to the issue."
          />
        </>
      )}

      <UntouchedCase caseKey="auth-target-fieldset">
        <AuthTargetSample me={me} agents={agents} />
      </UntouchedCase>
      {agents.some((agent) => agent.disabled_at === null) ? null : (
        <UntouchedGap
          name="auth-target-agent"
          reason="The API seed must include an active agent to exercise the agent row."
        />
      )}

      {members.length > 0 ? (
        <UntouchedCase caseKey="assignee-picker">
          <AssigneePicker
            members={members}
            selectedIds={issue.assignees.map((user) => user.id)}
            onToggle={() => undefined}
            trigger={<button type="button">edit assignees</button>}
            defaultOpen
          />
        </UntouchedCase>
      ) : (
        <UntouchedGap
          name="assignee-picker"
          reason="The API seed must include a project member."
        />
      )}

      {hasUnassignedAgent ? (
        <UntouchedCase caseKey="add-agent-picker">
          <AddAgentPicker
            agents={agents}
            memberIds={memberIds}
            onAdd={() => undefined}
            defaultOpen
          />
        </UntouchedCase>
      ) : (
        <UntouchedGap
          name="add-agent-picker"
          reason="Main must seed an active agent who is not already a project member."
        />
      )}

      {mentioned ? (
        <UntouchedCase caseKey="mention-link">
          <MentionLink
            slug={slug}
            userId={mentioned.id}
            fallback={`@${mentioned.login}`}
          />
        </UntouchedCase>
      ) : (
        <UntouchedGap
          name="mention-link"
          reason="The API seed must include a project member for mention resolution."
        />
      )}

      {data.answeredQuestion ? (
        <UntouchedCase caseKey="answered-question">
          <AnsweredQuestionSample
            slug={slug}
            issueNumber={issue.number}
            question={data.answeredQuestion}
          />
        </UntouchedCase>
      ) : (
        <UntouchedGap
          name="answered-question"
          reason="Main must seed an answered questions comment and pass its component and answer."
        />
      )}

      <div>
        {UNTOUCHED_BASELINE_GAPS.map((gap) => (
          <UntouchedGap key={gap.key} name={gap.key} reason={gap.reason} />
        ))}
      </div>
    </div>
  );
}
