// Vite-only browser entry. This file is deliberately not imported by the app router.
// All measured rows below are production components fed by the isolated API;
// section elements only separate samples and never impersonate product markup.
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type {
  Issue,
  SpecCommentItem,
  SpecInfo,
  TimelineComment,
  TimelineEvent,
} from "@todou/shared";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, queryClient } from "@/api/queries.ts";
import { CommentHoverCard } from "@/components/shared/comment-hover-card.tsx";
import { RevisionHistory } from "@/components/shared/revision-history.tsx";
import { SpecAnnotationHoverCard } from "@/components/shared/spec-annotation-hover-card.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import {
  AnnotatedMarkdown,
  type DisplayedAnnotation,
} from "@/components/spec/annotated-markdown.tsx";
import { SpecVersionMenuRow } from "@/components/spec/spec-version-picker.tsx";
import { CommentItem } from "@/components/timeline/comment-item.tsx";
import { EventGroup } from "@/components/timeline/event-group.tsx";
import { EventRow } from "@/components/timeline/event-row.tsx";
import { BodyBlock, Sidebar } from "@/pages/issue-detail.tsx";
import { MembersSection } from "@/pages/project-settings.tsx";
import { AvatarBaselineSamples } from "./avatar-baseline.tsx";
import {
  type UntouchedBaselineData,
  UntouchedBaselineSamples,
} from "./untouched-baseline.tsx";
import "@/styles.css";

declare global {
  interface Window {
    __USER_BASELINE_READY__?: boolean;
    __USER_BASELINE_ERRORS__?: string[];
  }
}

const search = new URLSearchParams(location.search);
const slug = search.get("slug") ?? "baseline-smoke";
const issueNumber = Number(search.get("number") ?? "1");
const surface = search.get("surface") ?? "main";
const errors: string[] = [];
window.__USER_BASELINE_READY__ = false;
window.__USER_BASELINE_ERRORS__ = errors;

function firstTextTop(
  element: Element,
): { top: number; lineHeight: number } | null {
  const name = [...element.querySelectorAll("span")].find((span) =>
    span.classList.contains("ml-1.5"),
  );
  const host = name ?? element;
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node && !node.textContent?.trim()) node = walker.nextNode();
  if (!node) return null;
  const range = document.createRange();
  range.selectNodeContents(node);
  const rect = range.getClientRects()[0];
  const lineHeight =
    Number.parseFloat(getComputedStyle(element).lineHeight) || 20;
  return rect ? { top: rect.top, lineHeight } : null;
}

function mark(
  row: Element | null,
  id: string,
  author: Element | null,
  peer: Element | null,
  extra: Record<string, Element | null> = {},
  /**
   * Skip the same-line precondition, on the rows where a wrap is the design
   * rather than a sign the sample was never found — `markCommentHeader` has
   * never had the precondition for this same reason. Below `sm` a comment
   * header puts its meta on a second line (T-445), so a preview's stamp
   * sits below its author on purpose, and dropping the mark there would
   * report the row as absent.
   */
  allowWrap = false,
) {
  if (!row || !author || !peer) return;
  const authorLine = firstTextTop(author);
  const peerLine = firstTextTop(peer);
  if (!authorLine || !peerLine) return;
  if (
    !allowWrap &&
    Math.abs(authorLine.top - peerLine.top) >
      Math.max(authorLine.lineHeight, peerLine.lineHeight) * 0.75
  ) {
    return;
  }
  row.setAttribute("data-baseline-case", id);
  author.setAttribute("data-baseline-participant", "author");
  peer.setAttribute("data-baseline-participant", "peer");
  // Marked without the same-line check the pair above gets: the runner
  // decides what a wrapped participant means, per viewport. Dropping the
  // mark here instead would report the row as unmarked and read as a pass
  // at whatever width the header happens to break.
  for (const [role, element] of Object.entries(extra)) {
    if (element) element.setAttribute("data-baseline-participant", role);
  }
}

/**
 * The author chip of a comment header. Up to two levels deeper than in every
 * other row here: a comment header wraps its identity in a group so the row
 * can put the meta on a second line below `sm` (T-445), and wraps that group
 * again in the line the row centres as one (T-487). Still bounded to those
 * levels rather than a bare descendant search, because the rows this marks
 * carry comment bodies that hold user links of their own.
 */
function authorChipOf(row: Element | null) {
  return (
    row?.querySelector(
      ':scope > a[href^="/users/"], :scope > span > a[href^="/users/"], :scope > span > span > a[href^="/users/"]',
    ) ?? null
  );
}

/** The header meta's two links, told apart the way a reader does. */
function metaParts(row: Element | null) {
  const links = [...(row?.querySelectorAll("a[href*='#comment-']") ?? [])];
  return {
    id: links.find((link) => !link.querySelector("time")) ?? null,
    time: links.find((link) => link.querySelector("time")) ?? null,
  };
}

/**
 * One comment header: the author name, the stamp, the id, and the badge text.
 *
 * Marked without `mark`'s same-line precondition. That guard was written for
 * T-433's rows, where the pair could not wrap; a comment header can, and on a
 * narrow viewport it does. Dropping the mark there would report the sample as
 * absent, and "the runner never found it" must not read the same as "the
 * runner measured it and it was fine" — the runner classifies each role by
 * the line it landed on instead.
 */
function markCommentHeader(selector: string, id: string, withBadge: boolean) {
  const row = document.querySelector(`${selector} .border-b.bg-muted\\/40`);
  if (!row) return;
  const parts = metaParts(row);
  const badge = withBadge
    ? row.querySelector('[data-testid="agent-context-badge"]')
    : null;
  const author = authorChipOf(row);
  // T-433's `peer` was this comment's timestamp link and still is, so the
  // sample it proved survives unchanged; the id beside it is new.
  const roles: Record<string, Element | null> = {
    author,
    peer: parts.time,
    id: parts.id,
    ...(withBadge ? { badge } : {}),
  };
  if (Object.values(roles).some((element) => !element)) return;
  row.setAttribute("data-baseline-case", id);
  for (const [role, element] of Object.entries(roles)) {
    element?.setAttribute("data-baseline-participant", role);
  }
}

// `mark` operates on the rendered DOM of genuine components. It only adds
// data attributes; it cannot alter CSS, layout, line breaking, or baseline.
function markRows(commentId?: number, annotationId?: number) {
  const event = document.querySelector("#fixture-event-row > [id^='event-']");
  if (event) {
    mark(
      event,
      "event-row",
      event.querySelector(':scope > a[href^="/users/"]'),
      event.querySelector(":scope > span[title]"),
    );
  }
  const list = document.querySelector(
    "#fixture-list-group [data-testid='event-group'] > div:first-child",
  );
  if (list) {
    mark(
      list,
      "list-group",
      list.querySelector(':scope > a[href^="/users/"]'),
      list.querySelector(":scope > span.min-w-0"),
    );
  }
  const collapsed = document.querySelector(
    "#fixture-collapsed-group [data-testid='event-group'] > div:first-child",
  );
  if (collapsed) {
    mark(
      collapsed,
      "collapsed-group",
      collapsed.querySelector(':scope > a[href^="/users/"]'),
      collapsed.querySelector(":scope > span[title]"),
    );
  }
  const assigneeGroup = document.querySelector(
    "#fixture-assignee-group [data-testid='event-group'] > div:first-child",
  );
  if (assigneeGroup) {
    const summary = assigneeGroup.querySelector(":scope > span[title]");
    const assigneeRow =
      summary?.querySelector(
        "span.inline-flex.items-baseline.align-baseline",
      ) ?? null;
    const assignee =
      assigneeRow?.querySelector(':scope > a[href^="/users/"]') ?? null;
    if (assigneeRow) assigneeRow.setAttribute("data-baseline-fault-target", "");
    mark(summary, "assignee-row", assignee, summary);
  }
  const body = document.querySelector(
    "#fixture-body-block .border-b.bg-muted\\/40",
  );
  if (body) {
    mark(
      body,
      "body-block",
      authorChipOf(body),
      body.querySelector(":scope > span[title], :scope > span > span[title]"),
    );
  }
  markCommentHeader("#fixture-comment-item", "comment-item", false);
  markCommentHeader(
    "#fixture-comment-item-agent-session",
    "comment-item-agent-session",
    true,
  );
  markCommentHeader(
    "#fixture-comment-item-agent-plain",
    "comment-item-agent-plain",
    true,
  );
  const revision = document.querySelector(
    '[data-slot="popover-content"] button.items-baseline',
  );
  if (revision) {
    mark(
      revision,
      "revision-history",
      revision.querySelector(":scope > span.inline-block"),
      revision.querySelector(":scope > span[title]"),
    );
  }
  const version = document.querySelector(
    "#fixture-spec-version-menu-row [class*='items-baseline']",
  );
  if (version) {
    mark(
      version,
      "spec-version-menu-row",
      version.querySelector(":scope > span.inline-block"),
      version.querySelector(":scope > time"),
    );
  }
  const markHover = (id: string, itemId: number | undefined) => {
    if (itemId === undefined) return;
    // Both cards are open at once, so the comment id is what tells them
    // apart. `.mb-2` then pins the header row: the meta wrapper is
    // `items-baseline` too now, so `closest(".items-baseline")` would stop
    // inside the group instead of reaching the row that holds the author.
    const link = document.querySelector(
      `[data-slot="hover-card-content"] a[href$="#comment-${itemId}"]`,
    );
    const row = link?.closest(".mb-2.flex.items-baseline") ?? null;
    const parts = metaParts(row);
    mark(row, id, authorChipOf(row), parts.time, { id: parts.id }, true);
  };
  markHover("comment-hover-card", commentId);
  markHover("spec-annotation-hover-card", annotationId);
  const locate = document.querySelector(
    '[data-slot="popover-content"] button[title="Scroll to what this points at"]',
  );
  // The locate control's own span, which T-435 stripped the `title` from:
  // the creation time it used to hide is visible beside it now.
  const annotationRow = locate?.closest(".mb-1.flex.items-baseline") ?? null;
  const annotationParts = metaParts(annotationRow);
  mark(
    annotationRow,
    "annotation-chip",
    authorChipOf(annotationRow),
    locate?.parentElement ?? null,
    { id: annotationParts.id, time: annotationParts.time },
  );
}

type Data = {
  issue: Issue;
  events: TimelineEvent[];
  comment: TimelineComment | undefined;
  /** Written with a real agent-context header, so the badge is a button. */
  agentSessionComment: TimelineComment | undefined;
  /** Same, without a session id: the badge is a plain span (T-435). */
  agentPlainComment: TimelineComment | undefined;
  spec: SpecInfo | null;
  annotation: SpecCommentItem | undefined;
  specBody: string | undefined;
  untouched: UntouchedBaselineData;
};

function Samples({ data }: { data: Data }) {
  const {
    issue,
    events,
    comment,
    agentSessionComment,
    agentPlainComment,
    spec,
    annotation,
    specBody,
  } = data;
  const opened = events.find((entry) => entry.event_type === "opened");
  const reference = events.find((entry) => entry.event_type === "referenced");
  const assigned = events.filter((entry) => entry.event_type === "assigned");
  const specVersion = spec?.versions.at(-1);
  const assignedBot = assigned.find(
    (event) =>
      typeof event.payload.user === "object" &&
      event.payload.user !== null &&
      "login" in event.payload.user &&
      event.payload.user.login === "bot-one",
  );
  const displayedAnnotation: DisplayedAnnotation[] =
    annotation !== undefined &&
    annotation.current_line_start !== null &&
    annotation.current_line_end !== null
      ? [
          {
            key: `c${annotation.comment_id}`,
            kind: "comment",
            item: annotation,
            start: annotation.current_line_start,
            end: annotation.current_line_end,
            colStart: annotation.anchor.col_start,
            colEnd: annotation.anchor.col_end,
          },
        ]
      : [];
  const statusEvents = assigned.slice(0, 2).map((event, index) => ({
    ...event,
    id: event.id + 1_000_000,
    event_type: "status_changed" as const,
    payload: {
      from: { id: index + 1, name: index === 0 ? "Todo" : "Next" },
      to: { id: index + 2, name: index === 0 ? "Next" : "In Progress" },
    },
  }));

  useEffect(() => {
    // Portals belong to the production popover/hover components. Open them by
    // their actual triggers, then label whatever they really rendered.
    if (surface === "revision") {
      document
        .querySelector<HTMLButtonElement>(
          "#fixture-revision-history button[title]",
        )
        ?.click();
    }
    const chipTimer =
      surface === "main"
        ? window.setTimeout(() => {
            document
              .querySelector<HTMLButtonElement>(
                "#fixture-annotation-chip [data-annotation-ui]",
              )
              ?.click();
          }, 250)
        : undefined;
    if (surface === "main") {
      for (const selector of [
        "#fixture-comment-hover-card > a",
        "#fixture-spec-annotation-hover-card > a",
      ]) {
        const trigger = document.querySelector<HTMLElement>(selector);
        // React's onPointerEnter delegation is driven by pointerover.
        trigger?.dispatchEvent(
          new PointerEvent("pointerover", {
            bubbles: true,
            pointerType: "mouse",
          }),
        );
      }
    }
    const timer = window.setTimeout(() => {
      markRows(comment?.id, annotation?.comment_id);
      window.__USER_BASELINE_READY__ = true;
    }, 1100);
    return () => {
      if (chipTimer !== undefined) window.clearTimeout(chipTimer);
      window.clearTimeout(timer);
    };
  }, [annotation?.comment_id, comment?.id]);

  return (
    <main className="space-y-6 p-4">
      <section data-untouched-case="issue-sidebar-assignees">
        <Sidebar
          slug={slug}
          issue={issue}
          statuses={data.untouched.statuses}
          allLabels={data.untouched.labels}
          members={data.untouched.members}
          canDelete={false}
          trashed={false}
        />
      </section>
      {surface === "untouched" && (
        <section data-untouched-case="project-members-table">
          <MembersSection slug={slug} />
        </section>
      )}
      {opened && (
        <section id="fixture-event-row">
          <EventRow event={opened} slug={slug} issueNumber={issueNumber} />
        </section>
      )}
      {reference && (
        <section id="fixture-list-group">
          <EventGroup
            family="referenced"
            events={[reference]}
            slug={slug}
            issueNumber={issueNumber}
          />
        </section>
      )}
      {statusEvents.length >= 2 && (
        <section id="fixture-collapsed-group">
          <EventGroup
            family="status"
            events={statusEvents}
            slug={slug}
            issueNumber={issueNumber}
          />
        </section>
      )}
      {assigned.length >= 2 && (
        <section id="fixture-assignee-group">
          <EventGroup
            family="assignees"
            events={assigned.slice(0, 2)}
            slug={slug}
            issueNumber={issueNumber}
          />
        </section>
      )}
      {assignedBot && (
        <section id="fixture-machine-event-row">
          <EventRow event={assignedBot} slug={slug} issueNumber={issueNumber} />
        </section>
      )}
      {assigned.length >= 2 && (
        <section id="fixture-machine-collapsed-group">
          <EventGroup
            family="assignees"
            events={assigned.slice(0, 2)}
            slug={slug}
            issueNumber={issueNumber}
          />
        </section>
      )}
      <section id="fixture-body-block">
        <BodyBlock slug={slug} issue={issue} readOnly />
      </section>
      {comment && (
        <section id="fixture-comment-item">
          <CommentItem
            slug={slug}
            issueNumber={issueNumber}
            comment={comment}
          />
        </section>
      )}
      {comment && (
        <section id="fixture-comment-item-author">
          <CommentItem
            slug={slug}
            issueNumber={issueNumber}
            comment={comment}
            viewer={{
              id: data.untouched.me.id,
              isAdmin: data.untouched.me.is_instance_admin,
              role: "writer",
            }}
          />
        </section>
      )}
      {agentSessionComment && (
        <section id="fixture-comment-item-agent-session">
          <CommentItem
            slug={slug}
            issueNumber={issueNumber}
            comment={agentSessionComment}
          />
        </section>
      )}
      {agentPlainComment && (
        <section id="fixture-comment-item-agent-plain">
          <CommentItem
            slug={slug}
            issueNumber={issueNumber}
            comment={agentPlainComment}
          />
        </section>
      )}
      {comment && (
        <section
          id="fixture-pending-comment"
          aria-label="Pending comment sample"
        >
          <CommentItem
            slug={slug}
            issueNumber={issueNumber}
            comment={comment}
            pending
          />
        </section>
      )}
      {comment && (
        <section
          id="fixture-compact-user-chip"
          aria-label="Compact user chip sample"
        >
          <UserChip user={comment.author} compact />
        </section>
      )}
      <section id="fixture-avatar-matrix" aria-label="Avatar baseline matrix">
        <AvatarBaselineSamples />
      </section>
      {issue.body_edited_at && (
        <section id="fixture-revision-history">
          <RevisionHistory
            label="description"
            editedAt={issue.body_edited_at}
            filename="description.md"
            queryKey={["baseline-revisions", slug, issueNumber]}
            fetchRevisions={() => api.getIssueRevisions(slug, issueNumber)}
          />
        </section>
      )}
      {specVersion && (
        <section id="fixture-spec-version-menu-row">
          <SpecVersionMenuRow
            version={specVersion.number}
            message={specVersion.message}
            author={specVersion.author}
            createdAt={specVersion.created_at}
            active
          />
        </section>
      )}
      {comment && (
        <section id="fixture-comment-hover-card">
          <CommentHoverCard
            slug={slug}
            issueNumber={issueNumber}
            comment={comment}
          >
            <a href={`#comment-${comment.id}`}>comment preview</a>
          </CommentHoverCard>
        </section>
      )}
      {annotation && (
        <section id="fixture-spec-annotation-hover-card">
          <SpecAnnotationHoverCard
            slug={slug}
            issueNumber={issueNumber}
            annotation={annotation}
          >
            <a href={`#comment-${annotation.comment_id}`}>annotation preview</a>
          </SpecAnnotationHoverCard>
        </section>
      )}
      {annotation && specBody && displayedAnnotation.length > 0 && (
        <section id="fixture-annotation-chip">
          <AnnotatedMarkdown
            slug={slug}
            issueNumber={issueNumber}
            body={specBody}
            annotations={displayedAnnotation}
            onStage={() => {}}
            onEditDraft={() => {}}
            onRemoveDraft={() => {}}
            onResolve={() => {}}
          />
        </section>
      )}
      {surface === "untouched" && (
        <UntouchedBaselineSamples data={data.untouched} />
      )}
    </main>
  );
}

function Fixture() {
  const [data, setData] = useState<Data | null>(null);
  useEffect(() => {
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
      errors.push("invalid issue number");
      window.__USER_BASELINE_READY__ = true;
      return;
    }
    let live = true;
    Promise.all([
      api.getIssue(slug, issueNumber),
      api.getTimeline(slug, issueNumber, { limit: 100 }),
      api.getSpec(slug, issueNumber).catch((error: { status?: number }) => {
        if (error.status === 404) return null;
        throw error;
      }),
    ])
      .then(async ([issue, timeline, spec]) => {
        const specData = spec
          ? await Promise.all([
              api.getSpecComments(slug, issueNumber),
              api.getSpecFiles(slug, issueNumber),
            ])
          : null;
        const [me, agents, members, statuses, labels] = await Promise.all([
          api.me(),
          api.listAgents(),
          api.listMembers(slug),
          api.listStatuses(slug),
          api.listLabels(slug),
        ]);
        const annotation = specData?.[0].items.find(
          (item) =>
            item.anchor.line_start === 5 &&
            item.current_line_start !== null &&
            item.current_line_end !== null,
        );
        if (live)
          setData({
            issue,
            untouched: { slug, issue, me, agents, members, statuses, labels },
            events: timeline.items.filter(
              (item): item is TimelineEvent => item.type === "event",
            ),
            comment: timeline.items.find(
              (item): item is TimelineComment =>
                item.type === "comment" &&
                item.component === null &&
                item.agent_context == null,
            ),
            agentSessionComment: timeline.items.find(
              (item): item is TimelineComment =>
                item.type === "comment" &&
                item.agent_context?.session_id !== undefined,
            ),
            agentPlainComment: timeline.items.find(
              (item): item is TimelineComment =>
                item.type === "comment" &&
                item.agent_context != null &&
                item.agent_context.session_id === undefined,
            ),
            spec,
            annotation,
            specBody: annotation
              ? specData?.[1].files.find(
                  (file) => file.path === annotation.anchor.path,
                )?.body
              : undefined,
          });
      })
      .catch((error: unknown) => {
        errors.push(`fixture API: ${String(error)}`);
        window.__USER_BASELINE_READY__ = true;
      });
    return () => {
      live = false;
    };
  }, []);
  return data && <Samples data={data} />;
}

// A private router gives the exported real Link/UserChip components a routing
// context. It is never registered with the product's production router.
const rootRoute = createRootRoute();
const fixtureRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Fixture,
});
const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$slug",
});
const issueRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "issues/$number",
});
const userRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/users/$ref",
});
const router = createRouter({
  routeTree: rootRoute.addChildren([
    fixtureRoute,
    userRoute,
    projectRoute.addChildren([issueRoute]),
  ]),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
const root = document.getElementById("root");
if (!root) throw new Error("fixture root missing");
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
