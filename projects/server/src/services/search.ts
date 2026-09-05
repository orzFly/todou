import type {
  SearchDiagnostic,
  SearchDomain,
  SearchField,
  SearchFilter,
  SearchItem,
  SearchKind,
  SearchPage,
  SearchQuery,
  SearchSnippet,
  Status,
} from "@todou/shared";
import {
  canonicalQualifierValue,
  HARNESS_IDS,
  isSpecialQualifierValue,
  parseSearchQuery,
  SEARCH_DOMAINS,
  SEARCH_MAX_FILTERS,
  SEARCH_MAX_TERMS,
  SEARCH_QUALIFIERS,
  searchFiltersOf,
  searchIsDomains,
  searchTermsOf,
} from "@todou/shared";
import {
  and,
  desc,
  eq,
  ilike,
  inArray,
  not,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import {
  comments,
  issueAssignees,
  issueEvents,
  issueLabels,
  issues,
  labels,
  specVersionFiles,
  specVersions,
  statuses,
} from "../db/project-schema.ts";
import { projectMembers, users } from "../db/system-schema.ts";
import { ValidationFailedError } from "../errors.ts";
import { requireCapability, routeInfoOf } from "./access.ts";
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
 * carries another is a hit for both. Undefined when there are no terms at
 * all: a query of qualifiers alone constrains rows without reading text.
 */
function allTermsMatch(
  patterns: string[],
  columns: AnyPgColumn[],
): SQL | undefined {
  const perTerm = patterns.map((pattern) => {
    const anyColumn = or(...columns.map((column) => ilike(column, pattern)));
    if (!anyColumn) throw new Error("search needs at least one column");
    return anyColumn;
  });
  return and(...perTerm);
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

/**
 * What the qualifiers in `q` add to the query: conditions on the card, which
 * every domain shares, and conditions on the row carrying the hit, which each
 * domain has its own version of.
 */
type QualifierPlan = {
  issue: SQL[];
  comments: SQL[];
  specs: SQL[];
  bodies: SQL[];
  domains: Set<SearchDomain>;
  diagnostics: SearchDiagnostic[];
};

/**
 * The candidate sharing the longest prefix with what was typed, at least two
 * characters, case-insensitively — or null.
 *
 * Not an edit distance. Status and label names are short, a prefix rule is
 * deterministic and states its own answer, and the one edit-distance
 * implementation we have lives in the CLI package where the server cannot
 * reach it; moving it to shared to spell "Nxt" as "Next" is a refactor this
 * card has no business doing.
 */
function didYouMean(
  input: string,
  candidates: Iterable<string>,
): string | null {
  const typed = input.toLowerCase();
  let best: string | null = null;
  let bestLength = 1;
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    let n = 0;
    while (n < typed.length && n < lower.length && typed[n] === lower[n])
      n += 1;
    if (n > bestLength) {
      bestLength = n;
      best = candidate;
    }
  }
  return best;
}

/** A condition over a set of row ids, and one that cannot match when it is empty. */
const anyOf = (column: AnyPgColumn, ids: number[]): SQL =>
  ids.length === 0 ? sql`false` : inArray(column, ids);

/** `-` inverts the whole expression, values and all. */
const applyNegation = (filter: SearchFilter, condition: SQL): SQL =>
  filter.negated ? not(condition) : condition;

/**
 * What one `harness:`/`session:` expression asks of one `agent_context`
 * column, as a plain equality on `agent_context ->> key` so the expression
 * index from migration 0012 can answer it — a query of qualifiers alone has
 * no trigram index to fall back on.
 *
 * `session_id: ""` is "no session at all", the same reading `timeline.ts`
 * spells with `nullif(…, '')`. Here the normalization is implicit and the
 * `nullif` would only cost the index: the values reaching this point are
 * never empty, and an empty column value can therefore never equal one.
 */
function agentContextCondition(
  column: AnyPgColumn,
  key: "harness" | "session",
  values: string[],
): SQL {
  const field =
    key === "harness"
      ? sql`${column} ->> 'agent'`
      : sql`${column} ->> 'session_id'`;
  const alternatives: SQL[] = [];
  const named = values.filter(
    (v) => v !== "" && !isSpecialQualifierValue(key, v),
  );
  // `harness:none` is the writes that carry no agent context at all — the
  // web UI, a person at a terminal, a client that does not report one.
  if (values.some((v) => isSpecialQualifierValue(key, v))) {
    alternatives.push(sql`${field} is null`);
  }
  for (const value of named) alternatives.push(sql`${field} = ${value}`);
  return or(...alternatives) ?? sql`false`;
}

/**
 * `not` over a comparison that is NULL for a row with no agent context.
 * Plain `not` would drop those rows, so `-harness:codex` would also hide
 * everything a person typed by hand — the opposite of what it says.
 */
const negateAgentContext = (condition: SQL): SQL =>
  sql`not coalesce(${condition}, false)`;

/**
 * `harness:`/`session:` narrow *the text that matched*, not the card, so each
 * domain answers from its own column. An issue body has none, and falls back
 * to the card's `opened` event — who opened it. That is an `exists` rather
 * than a join because nothing guarantees a card has exactly one such event
 * (very old rows and relocated cards may have none); a missing event reads as
 * "no match" and can never fan a card out into duplicate hits.
 */
function agentContextByDomain(
  plan: QualifierPlan,
  filter: SearchFilter,
  key: "harness" | "session",
): void {
  const values = filter.values;
  const on = (column: AnyPgColumn): SQL => {
    const condition = agentContextCondition(column, key, values);
    return filter.negated ? negateAgentContext(condition) : condition;
  };
  plan.comments.push(on(comments.agentContext));
  plan.specs.push(on(specVersions.agentContext));
  const opened = and(
    eq(issueEvents.issueId, issues.id),
    eq(issueEvents.type, "opened"),
    agentContextCondition(issueEvents.agentContext, key, values),
  );
  // `exists` is already total, so this one negation needs no closing over.
  plan.bodies.push(
    applyNegation(
      filter,
      sql`exists (select 1 from ${issueEvents} where ${opened})`,
    ),
  );
}

/** Logins of this project's members, for `assignee:`. */
async function projectMemberLogins(
  ctx: AppContext,
  projectId: number,
): Promise<Array<{ id: number; login: string }>> {
  return await ctx.router
    .system()
    .select({ id: users.id, login: users.login })
    .from(projectMembers)
    .innerJoin(users, eq(projectMembers.userId, users.id))
    .where(eq(projectMembers.projectId, projectId));
}

/**
 * Qualifiers into SQL. Every expression stands alone and they are ANDed;
 * within one expression the comma-separated values are ORed. A value that
 * names nothing becomes `false` plus a diagnostic rather than an error, so
 * the page still renders and still says which word to fix.
 */
async function planQualifiers(
  ctx: AppContext,
  actor: UserRow,
  projectId: number,
  db: Db,
  filters: SearchFilter[],
  statusRows: Array<typeof statuses.$inferSelect>,
  requested: Set<SearchDomain>,
): Promise<QualifierPlan> {
  const plan: QualifierPlan = {
    issue: [],
    comments: [],
    specs: [],
    bodies: [],
    domains: requested,
    diagnostics: [],
  };
  const fail = (
    key: string,
    value: string,
    message: string,
    suggestion: string | null = null,
  ) => {
    plan.diagnostics.push({
      severity: "error",
      key,
      value,
      message,
      suggestion,
    });
  };

  const is = searchIsDomains(filters);
  for (const value of is.unknown) {
    fail(
      "is",
      value,
      `"${value}" is not searchable (${SEARCH_QUALIFIERS.is.values.join(", ")})`,
      didYouMean(value, Object.keys(SEARCH_QUALIFIERS.is.aliases)),
    );
  }

  const labelRows = filters.some((f) => f.key === "label")
    ? await db
        .select({ id: labels.id, name: labels.name })
        .from(labels)
        .where(eq(labels.projectId, projectId))
    : [];
  const memberRows = filters.some((f) => f.key === "assignee")
    ? await projectMemberLogins(ctx, projectId)
    : [];

  for (const filter of filters) {
    // An empty value list is a half-typed query, not an error: `label:` on
    // its way to `label:kind:bug` must not blank the results in between.
    if (filter.values.length === 0) continue;

    switch (filter.key) {
      // `is:` is folded once, by shared, so the chips on the results page
      // cannot disagree with what the query actually selects.
      case "is":
        break;

      case "state": {
        const categories = new Set<string>();
        for (const value of filter.values) {
          const canonical = canonicalQualifierValue("state", value);
          if (canonical === null) {
            fail(
              "state",
              value,
              `"${value}" is not a state (${SEARCH_QUALIFIERS.state.values.join(", ")})`,
              didYouMean(value, SEARCH_QUALIFIERS.state.values),
            );
            continue;
          }
          categories.add(canonical);
        }
        const ids = statusRows
          .filter((s) => categories.has(s.category))
          .map((s) => s.id);
        plan.issue.push(applyNegation(filter, anyOf(issues.statusId, ids)));
        break;
      }

      case "status": {
        const ids: number[] = [];
        for (const value of filter.values) {
          const hit = statusRows.filter(
            (s) => s.name.toLowerCase() === value.toLowerCase(),
          );
          if (hit.length === 0) {
            fail(
              "status",
              value,
              `no status named "${value}" in this project`,
              didYouMean(
                value,
                statusRows.map((s) => s.name),
              ),
            );
            continue;
          }
          ids.push(...hit.map((s) => s.id));
        }
        plan.issue.push(applyNegation(filter, anyOf(issues.statusId, ids)));
        break;
      }

      case "label": {
        const ids: number[] = [];
        for (const value of filter.values) {
          const hit = labelRows.filter(
            (l) => l.name.toLowerCase() === value.toLowerCase(),
          );
          if (hit.length === 0) {
            fail(
              "label",
              value,
              `no label named "${value}" in this project`,
              didYouMean(
                value,
                labelRows.map((l) => l.name),
              ),
            );
            continue;
          }
          ids.push(...hit.map((l) => l.id));
        }
        const tagged =
          ids.length === 0
            ? []
            : await db
                .select({ issueId: issueLabels.issueId })
                .from(issueLabels)
                .where(inArray(issueLabels.labelId, ids));
        plan.issue.push(
          applyNegation(
            filter,
            anyOf(issues.id, [...new Set(tagged.map((t) => t.issueId))]),
          ),
        );
        break;
      }

      case "assignee": {
        const ids: number[] = [];
        for (const value of filter.values) {
          if (isSpecialQualifierValue("assignee", value)) {
            ids.push(actor.id);
            continue;
          }
          const hit = memberRows.filter(
            (m) => m.login.toLowerCase() === value.toLowerCase(),
          );
          if (hit.length === 0) {
            fail(
              "assignee",
              value,
              `no member named "${value}" in this project`,
              didYouMean(
                value,
                memberRows.map((m) => m.login),
              ),
            );
            continue;
          }
          ids.push(...hit.map((m) => m.id));
        }
        const assigned =
          ids.length === 0
            ? []
            : await db
                .select({ issueId: issueAssignees.issueId })
                .from(issueAssignees)
                .where(inArray(issueAssignees.userId, ids));
        plan.issue.push(
          applyNegation(
            filter,
            anyOf(issues.id, [...new Set(assigned.map((a) => a.issueId))]),
          ),
        );
        break;
      }

      case "harness": {
        for (const value of filter.values) {
          if (isSpecialQualifierValue("harness", value)) continue;
          if ((HARNESS_IDS as readonly string[]).includes(value)) continue;
          // A note, not an error: any client may report any string, so an
          // unfamiliar one is matched as written and only flagged.
          plan.diagnostics.push({
            severity: "note",
            key: "harness",
            value,
            message: `"${value}" is not a harness todou knows (${HARNESS_IDS.join(", ")}); matching it literally`,
            suggestion: didYouMean(value, HARNESS_IDS),
          });
        }
        agentContextByDomain(plan, filter, "harness");
        break;
      }

      case "session":
        agentContextByDomain(plan, filter, "session");
        break;
    }
  }

  if (is.domains !== null) {
    const selected = is.domains;
    const both = new Set(selected.filter((d) => requested.has(d)));
    if (both.size === 0 && selected.length > 0 && requested.size > 0) {
      plan.diagnostics.push({
        severity: "note",
        key: "is",
        value: null,
        message: "is: and in= select no domain in common",
        suggestion: null,
      });
    }
    plan.domains = both;
  }
  return plan;
}

export async function searchProject(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  query: SearchQuery,
): Promise<SearchPage> {
  const { project } = await requireCapability(ctx, actor, slug, "search.run");
  const db = await ctx.router.forProject(routeInfoOf(project));

  const parts = parseSearchQuery(query.q);
  const terms = searchTermsOf(parts);
  const filters = searchFiltersOf(parts);
  if (terms.length === 0 && filters.length === 0) {
    throw new ValidationFailedError(
      "q must contain at least one search term or qualifier",
    );
  }
  // Qualifiers do not spend the term budget: the cap is there to bound how
  // many ILIKE patterns one query can put on a table scan, and a qualifier
  // adds none.
  if (terms.length > SEARCH_MAX_TERMS) {
    throw new ValidationFailedError(
      `q carries ${terms.length} terms (at most ${SEARCH_MAX_TERMS})`,
    );
  }
  if (filters.length > SEARCH_MAX_FILTERS) {
    throw new ValidationFailedError(
      `q carries ${filters.length} qualifiers (at most ${SEARCH_MAX_FILTERS})`,
    );
  }
  const patterns = terms.map(likePattern);

  const statusRows = await db
    .select()
    .from(statuses)
    .where(eq(statuses.projectId, project.id));

  const plan = await planQualifiers(
    ctx,
    actor,
    project.id,
    db,
    filters,
    statusRows,
    new Set(query.in ?? SEARCH_DOMAINS),
  );
  const { diagnostics, domains } = plan;

  // The same status/label/assignee narrowing the issue list applies, trash
  // exclusion included: a card in the trash takes its comments and its spec
  // out of the index with it.
  const base = await issueFilterConditions(db, project.id, {
    status: query.status,
    label: query.label,
    assignee: query.assignee,
  });
  if (base === null) return { items: [], has_more: false, diagnostics };
  base.push(...plan.issue);

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
      .where(
        and(
          ...base,
          ...plan.bodies,
          allTermsMatch(patterns, [issues.title, issues.body]),
        ),
      )
      .orderBy(desc(issues.updatedAt), desc(issues.id))
      .limit(CANDIDATES_PER_DOMAIN);
    for (const row of rows) {
      // The title is the stronger signal, so it wins the snippet whenever it
      // carries a term at all — even when the body carries more of them. With
      // no free terms there is nothing to window around, so the snippet is the
      // head of the body, or the title when the card has no body.
      const inTitle =
        terms.length === 0
          ? row.body.trim() === ""
          : matchRanges(row.title, terms).length > 0;
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
      .where(
        and(
          ...base,
          ...plan.comments,
          allTermsMatch(patterns, [comments.body]),
        ),
      )
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
          ...plan.specs,
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
    diagnostics,
  };
}
