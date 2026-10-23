import {
  findMarkdownLinks,
  type IssueReferenceEntry,
  type IssueReferences,
} from "@todou/shared";
import { and, asc, eq, inArray, or, type SQL } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import { comments, issueEvents, issues } from "../db/project-schema.ts";
import { issueAddresses } from "../db/system-schema.ts";
import { NotFoundError } from "../errors.ts";
import { findProjectsByRefs, projectForRead, routeInfoOf } from "./access.ts";
import {
  crossRefVisibleCondition,
  visibleProjects,
} from "./cross-references.ts";
import type { Address } from "./relocation.ts";
import { assertIssueReadable, gateColumns } from "./trash.ts";

const ADDRESS_CHUNK = 1000;

const keyOf = (a: Address): string => `${a.projectId}/${a.number}`;

/** A link or event before grouping: where it points and where it was written. */
type Occurrence = {
  address: Address;
  commentId: number | null;
  createdAt: Date;
};

/**
 * Every address in `addresses` followed to where that card lives now. An
 * address with no row has never moved and stands for itself.
 */
async function currentAddresses(
  system: Db,
  addresses: readonly Address[],
): Promise<Map<string, Address>> {
  const wanted = new Map(addresses.map((a) => [keyOf(a), a]));
  const found = new Map<string, Address>();
  const list = [...wanted.values()];
  for (let i = 0; i < list.length; i += ADDRESS_CHUNK) {
    const chunk = list.slice(i, i + ADDRESS_CHUNK);
    const rows = await system
      .select({
        projectId: issueAddresses.projectId,
        number: issueAddresses.number,
        currentProjectId: issueAddresses.currentProjectId,
        currentNumber: issueAddresses.currentNumber,
      })
      .from(issueAddresses)
      .where(
        or(
          ...chunk.map(
            (a) =>
              and(
                eq(issueAddresses.projectId, a.projectId),
                eq(issueAddresses.number, a.number),
              ) as SQL,
          ),
        ),
      );
    for (const row of rows) {
      found.set(keyOf(row), {
        projectId: row.currentProjectId,
        number: row.currentNumber,
      });
    }
  }
  for (const [key, a] of wanted) if (!found.has(key)) found.set(key, a);
  return found;
}

/**
 * One entry per card, from occurrences already in written order: the first
 * occurrence names the place and the time, the rest are counted.
 */
function group(
  occurrences: readonly Occurrence[],
  current: Map<string, Address>,
  self: string,
  countMore: boolean,
): IssueReferenceEntry[] {
  const entries = new Map<string, IssueReferenceEntry>();
  for (const o of occurrences) {
    const target = current.get(keyOf(o.address)) ?? o.address;
    const key = keyOf(target);
    // Followed to the current address first, so this also drops a link
    // written with an address the card has since moved away from.
    if (key === self) continue;
    const seen = entries.get(key);
    if (seen) {
      if (countMore) seen.more += 1;
      continue;
    }
    entries.set(key, {
      project_id: target.projectId,
      number: target.number,
      comment_id: o.commentId,
      more: 0,
      created_at: o.createdAt.toISOString(),
    });
  }
  // Stable, so a tie keeps written order: the body before its comments.
  return [...entries.values()].sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
  );
}

export async function getIssueReferences(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
): Promise<IssueReferences> {
  const { project, role } = await projectForRead(ctx, actor, slug);
  const db = await ctx.router.forProject(routeInfoOf(project));
  const system = ctx.router.system();

  const issueRows = await db
    .select({ ...gateColumns, body: issues.body, createdAt: issues.createdAt })
    .from(issues)
    .where(
      and(eq(issues.projectId, project.id), eq(issues.number, issueNumber)),
    );
  const issue = issueRows[0];
  if (!issue) throw new NotFoundError("issue not found");
  assertIssueReadable(issue, actor, role);

  const self = keyOf({ projectId: project.id, number: issueNumber });

  // Linked from: the reference events on this card, read the way the
  // timeline reads them so the two never disagree on who may see a row.
  const visible = await visibleProjects(ctx, actor);
  const events = await db
    .select({
      payload: issueEvents.payload,
      createdAt: issueEvents.createdAt,
    })
    .from(issueEvents)
    .where(
      and(
        eq(issueEvents.issueId, issue.id),
        inArray(issueEvents.type, ["referenced", "cross_referenced"]),
        crossRefVisibleCondition(visible.slugs, visible.ids),
      ),
    )
    .orderBy(asc(issueEvents.createdAt), asc(issueEvents.id));
  type Payload = {
    by_project?: string;
    by_project_id?: number;
    by_issue?: unknown;
    by_comment?: unknown;
  };
  const payloads = events.map((e) => e.payload as Payload);
  // Rows written before every event carried an id name the project by slug,
  // possibly one it has since given up.
  const bySlug = await findProjectsByRefs(
    ctx,
    payloads.flatMap((p) =>
      p.by_project_id === undefined && p.by_project !== undefined
        ? [p.by_project]
        : [],
    ),
  );
  const linkedFrom: Occurrence[] = [];
  events.forEach((event, i) => {
    const p = payloads[i] as Payload;
    if (typeof p.by_issue !== "number") return;
    const projectId =
      p.by_project_id ??
      (p.by_project === undefined
        ? project.id
        : bySlug.get(p.by_project)?.project.id);
    if (projectId === undefined) return;
    linkedFrom.push({
      address: { projectId, number: p.by_issue },
      commentId: typeof p.by_comment === "number" ? p.by_comment : null,
      createdAt: event.createdAt,
    });
  });

  // Links to: the links in this card's own text as it stands now. Hidden
  // comments count — hiding folds a comment, it does not take its links back.
  const commentRows = await db
    .select({
      id: comments.id,
      body: comments.body,
      createdAt: comments.createdAt,
    })
    .from(comments)
    .where(eq(comments.issueId, issue.id))
    .orderBy(asc(comments.createdAt), asc(comments.id));
  const texts = [
    { commentId: null, body: issue.body, createdAt: issue.createdAt },
    ...commentRows.map((c) => ({
      commentId: c.id,
      body: c.body,
      createdAt: c.createdAt,
    })),
  ];
  const linksTo: Occurrence[] = [];
  for (const text of texts) {
    for (const link of findMarkdownLinks(text.body, {
      origin: ctx.config.http.public_origin,
    })) {
      const target = link.target;
      if (target?.kind !== "issue" || target.project.kind !== "id") continue;
      linksTo.push({
        address: { projectId: target.project.id, number: target.number },
        commentId: text.commentId,
        createdAt: text.createdAt,
      });
    }
  }

  const current = await currentAddresses(system, [
    ...linkedFrom.map((o) => o.address),
    ...linksTo.map((o) => o.address),
  ]);
  return {
    linked_from: group(linkedFrom, current, self, false),
    links_to: group(linksTo, current, self, true),
  };
}
