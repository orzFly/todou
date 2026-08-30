import type {
  SearchField,
  SearchItem,
  SearchKind,
  SearchPage,
  SearchQuery,
  SearchSnippet,
  Status,
} from "@todou/shared";
import { SEARCH_MAX_TERMS } from "@todou/shared";
import { and, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import {
  comments,
  issues,
  specVersionFiles,
  specVersions,
  statuses,
} from "../db/project-schema.ts";
import { ValidationFailedError } from "../errors.ts";
import { requireProject, routeInfoOf } from "./access.ts";
import { issueFilterConditions } from "./issues.ts";
import { toStatus } from "./statuses.ts";

/**
 * How many rows one domain contributes before ranking (T-141).
 *
 * Ranking and snippets happen here rather than in SQL, so a query matching
 * half the project would otherwise pull half the project into memory to
 * produce fifty rows. It also bounds the slow path: a one- or two-character
 * CJK pattern is below the trigram index's reach and plans as a sequential
 * scan, and this is what keeps that scan from also being unbounded — every
 * project database is served by a single connection, so a search that runs
 * long blocks every other request for that project, not just its own.
 */
const CANDIDATES_PER_DOMAIN = 200;

/** Code points of context kept on each side of the first hit. */
const SNIPPET_CONTEXT = 60;

/**
 * `q` split into terms: whitespace-separated, with double quotes holding a
 * run together so a phrase containing spaces stays one term. An unclosed
 * quote runs to the end of the input rather than failing — the user is
 * mid-typing, and there is exactly one thing they can mean.
 */
export function parseSearchTerms(q: string): string[] {
  const terms: string[] = [];
  let i = 0;
  while (i < q.length) {
    const ch = q[i] as string;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '"') {
      const close = q.indexOf('"', i + 1);
      const end = close === -1 ? q.length : close;
      const phrase = q.slice(i + 1, end);
      if (phrase !== "") terms.push(phrase);
      i = end + 1;
      continue;
    }
    let end = i;
    while (end < q.length && !/\s/.test(q[end] as string) && q[end] !== '"') {
      end += 1;
    }
    terms.push(q.slice(i, end));
    i = end;
  }
  if (terms.length === 0) {
    throw new ValidationFailedError("q must contain at least one search term");
  }
  if (terms.length > SEARCH_MAX_TERMS) {
    throw new ValidationFailedError(
      `q carries ${terms.length} terms (at most ${SEARCH_MAX_TERMS})`,
    );
  }
  return terms;
}

/** A term as a LIKE pattern; the wildcards belong to us, not to the user. */
function likePattern(term: string): string {
  return `%${term.replaceAll(/[%_\\]/g, (m) => `\\${m}`)}%`;
}

function escapeRegExp(term: string): string {
  return term.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every term must appear somewhere in the unit, but each may land in any of
 * the columns given — an issue whose title carries one word and whose body
 * carries another is a hit for both.
 */
function allTermsMatch(patterns: string[], columns: AnyPgColumn[]): SQL {
  const perTerm = patterns.map((pattern) => {
    const anyColumn = or(...columns.map((column) => ilike(column, pattern)));
    if (!anyColumn) throw new Error("search needs at least one column");
    return anyColumn;
  });
  const all = and(...perTerm);
  if (!all) throw new Error("search needs at least one term");
  return all;
}

/** Where every term hits inside one text, as UTF-16 offsets. */
function matchRanges(text: string, terms: string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    // A regex with `i`, not `text.toLowerCase().indexOf(...)`: lowercasing
    // is not length-preserving for every code point (İ becomes two units),
    // which would slide every offset after it and highlight the wrong run.
    const re = new RegExp(escapeRegExp(term), "gi");
    for (const m of text.matchAll(re)) {
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

/**
 * A one-line window around the first hit, with every hit inside it marked.
 *
 * Whitespace is folded before anything is measured so that a snippet cut
 * from a markdown body is a line rather than a paragraph, and so the offsets
 * handed to the client index the very string it renders. Folding can only
 * add matches (a term never spans a collapsed run unless the user quoted one
 * — then there is simply nothing to highlight, and the window falls back to
 * the head of the text).
 */
export function buildSnippet(
  raw: string,
  terms: string[],
  context = SNIPPET_CONTEXT,
): SearchSnippet {
  const text = raw.replace(/\s+/g, " ").trim();
  const ranges = matchRanges(text, terms);
  const points = Array.from(text);
  if (points.length <= context * 2 + 1) return { text, ranges };

  // Code-point arithmetic, so a window boundary never lands between the two
  // halves of a surrogate pair; the offsets are converted back at the end.
  const utf16At = (cp: number): number =>
    points.slice(0, cp).reduce((n, p) => n + p.length, 0);
  const cpAt = (utf16: number): number => {
    let n = 0;
    let cp = 0;
    while (n < utf16 && cp < points.length) {
      n += (points[cp] as string).length;
      cp += 1;
    }
    return cp;
  };

  const first = ranges[0];
  const anchorStart = first ? cpAt(first[0]) : 0;
  const anchorEnd = first ? cpAt(first[1]) : 0;
  const startCp = Math.max(0, anchorStart - context);
  const endCp = Math.min(points.length, anchorEnd + context);
  const start = utf16At(startCp);
  const end = utf16At(endCp);

  const head = startCp > 0 ? "…" : "";
  const tail = endCp < points.length ? "…" : "";
  const shift = head.length - start;
  return {
    text: head + text.slice(start, end) + tail,
    // Clamped rather than dropped: a hit straddling the window edge is still
    // partly visible, and half a highlight beats none.
    ranges: ranges
      .filter(([s, e]) => e > start && s < end)
      .map(([s, e]): [number, number] => [
        Math.max(s, start) + shift,
        Math.min(e, end) + shift,
      ]),
  };
}

/** Domain precedence: a title hit outranks a body hit outranks a comment. */
const WEIGHT: Record<SearchKind | "issue-title", number> = {
  "issue-title": 3,
  issue: 2,
  comment: 1,
  spec: 0,
};

type Candidate = SearchItem & { weight: number };

export async function searchProject(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  query: SearchQuery,
): Promise<SearchPage> {
  const { project } = await requireProject(ctx, actor, slug, "reader");
  const db = await ctx.router.forProject(routeInfoOf(project));

  const terms = parseSearchTerms(query.q);
  const patterns = terms.map(likePattern);
  const domains = new Set(query.in ?? ["issues", "comments", "specs"]);

  // The same status/label/assignee narrowing the issue list applies, trash
  // exclusion included: a card in the trash takes its comments and its spec
  // out of the index with it.
  const base = await issueFilterConditions(db, project.id, {
    status: query.status,
    label: query.label,
    assignee: query.assignee,
  });
  if (base === null) return { items: [], has_more: false };

  const statusRows = await db
    .select()
    .from(statuses)
    .where(eq(statuses.projectId, project.id));
  const statusById = new Map<number, Status>(
    statusRows.map((s) => [s.id, toStatus(s)]),
  );
  const statusOf = (id: number): Status => {
    const status = statusById.get(id);
    if (!status) throw new Error(`issue has unknown status ${id}`);
    return status;
  };

  const candidates: Candidate[] = [];

  if (domains.has("issues")) {
    const rows = await db
      .select({
        number: issues.number,
        title: issues.title,
        body: issues.body,
        statusId: issues.statusId,
        updatedAt: issues.updatedAt,
        id: issues.id,
      })
      .from(issues)
      .where(and(...base, allTermsMatch(patterns, [issues.title, issues.body])))
      .orderBy(desc(issues.updatedAt), desc(issues.id))
      .limit(CANDIDATES_PER_DOMAIN);
    for (const row of rows) {
      // The title is the stronger signal, so it wins the snippet whenever it
      // carries a term at all — even when the body carries more of them.
      const inTitle = matchRanges(row.title, terms).length > 0;
      const field: SearchField = inTitle ? "title" : "body";
      candidates.push({
        kind: "issue",
        issue: {
          number: row.number,
          title: row.title,
          status: statusOf(row.statusId),
        },
        comment_id: null,
        spec_path: null,
        field,
        snippet: buildSnippet(inTitle ? row.title : row.body, terms),
        updated_at: row.updatedAt.toISOString(),
        weight: inTitle ? WEIGHT["issue-title"] : WEIGHT.issue,
      });
    }
  }

  if (domains.has("comments")) {
    const rows = await db
      .select({
        id: comments.id,
        body: comments.body,
        createdAt: comments.createdAt,
        editedAt: comments.editedAt,
        number: issues.number,
        title: issues.title,
        statusId: issues.statusId,
      })
      .from(comments)
      .innerJoin(issues, eq(comments.issueId, issues.id))
      .where(and(...base, allTermsMatch(patterns, [comments.body])))
      .orderBy(desc(comments.createdAt), desc(comments.id))
      .limit(CANDIDATES_PER_DOMAIN);
    for (const row of rows) {
      candidates.push({
        kind: "comment",
        issue: {
          number: row.number,
          title: row.title,
          status: statusOf(row.statusId),
        },
        comment_id: row.id,
        spec_path: null,
        field: "body",
        snippet: buildSnippet(row.body, terms),
        updated_at: (row.editedAt ?? row.createdAt).toISOString(),
        weight: WEIGHT.comment,
      });
    }
  }

  if (domains.has("specs")) {
    const rows = await db
      .select({
        path: specVersionFiles.path,
        body: specVersionFiles.body,
        createdAt: specVersions.createdAt,
        versionId: specVersions.id,
        number: issues.number,
        title: issues.title,
        statusId: issues.statusId,
      })
      .from(specVersionFiles)
      .innerJoin(specVersions, eq(specVersionFiles.versionId, specVersions.id))
      .innerJoin(issues, eq(specVersions.issueId, issues.id))
      .where(
        and(
          ...base,
          // Only the version the issue currently points at. Older versions
          // are history: a hit in one would send the reader to text the spec
          // page no longer shows by default.
          eq(specVersions.number, issues.specVersion),
          allTermsMatch(patterns, [
            specVersionFiles.path,
            specVersionFiles.body,
          ]),
        ),
      )
      .orderBy(desc(specVersions.createdAt), desc(specVersionFiles.id))
      .limit(CANDIDATES_PER_DOMAIN);
    for (const row of rows) {
      const inPath = matchRanges(row.path, terms).length > 0;
      candidates.push({
        kind: "spec",
        issue: {
          number: row.number,
          title: row.title,
          status: statusOf(row.statusId),
        },
        comment_id: null,
        spec_path: row.path,
        field: inPath ? "path" : "body",
        snippet: buildSnippet(inPath ? row.path : row.body, terms),
        updated_at: row.createdAt.toISOString(),
        weight: WEIGHT.spec,
      });
    }
  }

  // Weight first, recency second — no term frequency and no ts_rank. At this
  // corpus size a scoring function nobody can predict buys nothing over a
  // rule the reader can state in one sentence.
  candidates.sort(
    (a, b) =>
      b.weight - a.weight ||
      Date.parse(b.updated_at) - Date.parse(a.updated_at) ||
      a.issue.number - b.issue.number,
  );

  const page = candidates.slice(query.offset, query.offset + query.limit);
  return {
    items: page.map(({ weight: _weight, ...item }) => item),
    // True only within the candidate window; past it the answer is "there
    // were more than we ranked", which reads the same to a paginator.
    has_more: candidates.length > query.offset + query.limit,
  };
}
