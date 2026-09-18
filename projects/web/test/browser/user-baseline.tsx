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
) {
  if (!row || !author || !peer) return;
  const authorLine = firstTextTop(author);
  const peerLine = firstTextTop(peer);
  if (
    !authorLine ||
    !peerLine ||
    Math.abs(authorLine.top - peerLine.top) >
      Math.max(authorLine.lineHeight, peerLine.lineHeight) * 0.75
  ) {
    return;
  }
  row.setAttribute("data-baseline-case", id);
  author.setAttribute("data-baseline-participant", "author");
  peer.setAttribute("data-baseline-participant", "peer");
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
      body.querySelector(':scope > a[href^="/users/"]'),
      body.querySelector(":scope > span[title]"),
    );
  }
  const comment = document.querySelector(
    "#fixture-comment-item .border-b.bg-muted\\/40",
  );
  if (comment) {
    mark(
      comment,
      "comment-item",
      comment.querySelector(':scope > a[href^="/users/"]'),
      comment.querySelector(":scope > a[title]"),
    );
  }
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
    const peer = document.querySelector(
      `[data-slot="hover-card-content"] a[href$="#comment-${itemId}"]`,
    );
    const row = peer?.closest(".items-baseline") ?? null;
    mark(
      row,
      id,
      row?.querySelector(':scope > a[href^="/users/"]') ?? null,
      peer,
    );
  };
  markHover("comment-hover-card", commentId);
  markHover("spec-annotation-hover-card", annotationId);
  const locate = document.querySelector(
    '[data-slot="popover-content"] button[title="Scroll to what this points at"]',
  );
  const annotationRow = locate?.closest(".items-baseline") ?? null;
  mark(
    annotationRow,
    "annotation-chip",
    annotationRow?.querySelector(':scope > a[href^="/users/"]') ?? null,
    annotationRow?.querySelector(":scope > span[title]") ?? null,
  );
}

type Data = {
  issue: Issue;
  events: TimelineEvent[];
  comment: TimelineComment | undefined;
  spec: SpecInfo | null;
  annotation: SpecCommentItem | undefined;
  specBody: string | undefined;
  untouched: UntouchedBaselineData;
};

function Samples({ data }: { data: Data }) {
  const { issue, events, comment, spec, annotation, specBody } = data;
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
                item.type === "comment" && item.component === null,
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
