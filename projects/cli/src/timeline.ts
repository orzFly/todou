import type {
  AgentContext,
  TimelineComment,
  TimelineEvent,
  TimelineItem,
  TodouClient,
} from "@todou/shared";
import {
  formatRef,
  isHidden,
  SpecPushedPayload,
  SpecReviewPayload,
} from "@todou/shared";
import {
  type Painter,
  personName,
  plural,
  relativeTime,
  summarize,
} from "./format.ts";
import { drainPaged } from "./paginate.ts";
import {
  decodeAnswerEvent,
  renderAnswerRecords,
  renderQuestions,
} from "./questions.ts";
import type { SelfFilter } from "./watch-loop.ts";

/**
 * Reading and printing one issue's timeline. Extracted from
 * `commands/issue.ts` (T-243): the watch, comment, question and spec-wait
 * paths all need these helpers, and reaching into a command module for them
 * closed an import cycle back through `commands/spec.ts`.
 */

/** Cursor of the newest timeline entry (undefined on an empty timeline). */
export async function tailCursor(
  client: TodouClient,
  project: string,
  number: number,
): Promise<string | undefined> {
  const page = await client.getTimeline(project, number, {
    last: true,
    limit: 1,
  });
  return page.next_cursor ?? undefined;
}

/** Forward-drains one issue's timeline (cursor semantics: see drainPaged). */
export async function drainTimeline(
  client: TodouClient,
  project: string,
  number: number,
  opts: {
    after?: string;
    types?: string;
    includeHidden?: boolean;
  } & SelfFilter = {},
): Promise<{ items: TimelineItem[]; cursor: string | undefined }> {
  return drainPaged("timeline", opts.after, (after) =>
    client.getTimeline(project, number, {
      after,
      types: opts.types,
      exclude_actor: opts.excludeActor,
      exclude_agent_session: opts.excludeAgentSession,
      ...(opts.includeHidden === true ? { include_hidden: true } : {}),
      limit: 100,
    }),
  );
}

/** What deciding how to spell a reference takes: this project, and the directory. */
export type ReferenceOrigin = {
  refPrefix: string | null;
  /**
   * Project id → slug, for the `by_project_id` a reference event carries
   * (T-266). Preferred over the slug in the payload, which has to be read as
   * of the event's own instant and goes wrong once a slug changes hands.
   */
  slugOfProject?: (id: unknown) => string | null;
  /**
   * The id of the project being read, so a reference can be told local from
   * cross-project. Whether it is one or the other stopped being stored when
   * the two event types merged: a card moves, and the stored answer would be
   * wrong from then on.
   */
  projectId?: number;
  /** That project's slug, which is what `cardOf` keys its cards under. */
  project?: string;
};

/**
 * A card this entry mentions, by the address the line spells. Undefined for
 * every card the batch resolver did not get — a trashed one, one that moved
 * away, a read that failed — and each caller degrades to the line it printed
 * before rather than waiting for a second attempt (T-286).
 */
export type CardOf = (
  slug: string,
  number: number,
) => { title: string; body: string | null } | undefined;

/** Where the item is being shown from, for refs and command hints. */
export type TimelineRenderContext = ReferenceOrigin & {
  issueNumber: number;
  cardOf?: CardOf;
};

/**
 * The one spelling of a comment id in this CLI. It is `comment view`'s
 * argument and the web's permalink fragment at once, so the string a reader
 * takes off a line pastes back into a command unchanged (T-283).
 */
export function commentRef(id: number): string {
  return `#comment-${id}`;
}

/** A run of adjacent hidden comments, collapsed into one line (T-281). */
export type HiddenRun = { type: "hidden_run"; comments: TimelineComment[] };

/** What a timeline read prints: an entry, or a placeholder standing for many. */
export type TimelineUnit = TimelineItem | HiddenRun;

/**
 * Collapse adjacent hidden comments into one placeholder each.
 *
 * Only *adjacent* ones, and events break a run: hiding the comments around a
 * status change must not take the status change off the page with them. This
 * is the rule the web's `groupTimeline` already applies to its own folds —
 * order is never rearranged, and any other kind of entry ends a group.
 */
export function groupHiddenRuns(items: TimelineItem[]): TimelineUnit[] {
  const units: TimelineUnit[] = [];
  for (const item of items) {
    if (item.type !== "comment" || !isHidden(item)) {
      units.push(item);
      continue;
    }
    const open = units.at(-1);
    if (open?.type === "hidden_run") open.comments.push(item);
    else units.push({ type: "hidden_run", comments: [item] });
  }
  return units;
}

/** The entries one unit stands for, for slicing and for `--json`. */
export function unitItems(unit: TimelineUnit): TimelineItem[] {
  return unit.type === "hidden_run" ? unit.comments : [unit];
}

export function hasHiddenRun(items: TimelineItem[]): boolean {
  return groupHiddenRuns(items).some((unit) => unit.type === "hidden_run");
}

/**
 * `… 7 hidden comments (#comment-3401 … #comment-3419)`.
 *
 * The id range travels with the count so a reader can `comment view` one of
 * them without expanding the whole run first.
 */
export function renderHiddenRun(run: HiddenRun, paint: Painter): string {
  const n = run.comments.length;
  const first = run.comments[0]?.id ?? 0;
  const last = run.comments.at(-1)?.id ?? first;
  const range =
    first === last
      ? commentRef(first)
      : `${commentRef(first)} … ${commentRef(last)}`;
  return paint("dim", `… ${n} hidden ${plural(n, "comment")} (${range})`);
}

/**
 * Printed once per output that collapsed anything, never per placeholder: a
 * card can carry eight runs, and repeating the flag eight times is noise
 * where saying it once is enough.
 *
 * It says what the gap is for as well as how to open it, because a reader —
 * an agent above all — who reads the gap as lost information goes and digs
 * up a discussion that already reached its conclusion.
 */
export const HIDDEN_HINT = [
  "hint: comments were hidden to keep settled discussion out of this read — what they",
  "      concluded is in the remaining comments and the spec. Add --include-hidden to",
  "      read them.",
].join("\n");

/**
 * A body on an activity line. A positive `summaryChars` cuts it to one
 * folded line — what `--summary` asks for; at 0 the whole body goes out,
 * first line on the header and the rest indented two spaces so a reader
 * (and a `^\S` split) can still tell one entry from the next. Two spaces,
 * not four: at four a fenced code block inside the body would parse as an
 * indented one.
 */
function bodyBlock(text: string, summaryChars: number): string {
  if (summaryChars > 0) return summarize(text, summaryChars);
  const [head, ...rest] = text.trim().split("\n");
  return [
    head,
    ...rest.map((line) => (line.trim() === "" ? "" : `  ${line}`)),
  ].join("\n");
}

/**
 * ` (claude-code, <session>)` for a write an agent reported provenance
 * for, empty for a human one — a stream several agent sessions write to is
 * unreadable without it, and `watch` filters by exactly this session id.
 *
 * `undefined` is in the signature because responses are cast, not parsed: a
 * server predating the field sends no such key, and reading `.agent` off
 * that would take down the whole line.
 */
function agentSuffix(context: AgentContext | null | undefined): string {
  if (context === undefined || context === null) return "";
  const session =
    context.session_id === undefined ? "" : `, ${context.session_id}`;
  return ` (${context.agent}${session})`;
}

/**
 * A person as a comment or answer line names them, provenance included.
 * Shared by both renderers so they cannot come to spell one author two
 * ways; the event lines paint themselves dim whole and inline the suffix
 * instead.
 */
function personLabel(
  user: { display_name?: string; login: string },
  context: AgentContext | null | undefined,
  paint: Painter,
): string {
  const suffix = agentSuffix(context);
  // An empty suffix is kept out of `paint`, which would otherwise wrap it
  // in a pair of escape sequences around nothing.
  return `${paint("cyan", personName(user))}${suffix === "" ? "" : paint("dim", suffix)}`;
}

export function renderTimelineItem(
  item: TimelineItem,
  paint: Painter,
  ctx: TimelineRenderContext,
): string {
  const when = relativeTime(item.created_at);
  const who = (user: { display_name?: string; login: string }): string =>
    personLabel(user, item.agent_context, paint);
  if (item.type === "comment") {
    const body = item.body
      .trimEnd()
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
    // Unconditional since T-283: the id is what a reader hands back to
    // `comment view/edit/delete` and what `#comment-<id>` links to, and the
    // reasoning that called it noise inside a whole card was overruled.
    const id = `${paint("dim", `${commentRef(item.id)} ·`)} `;
    const edited = item.edited_at ? " (edited)" : "";
    // Only ever seen where the body is being shown anyway — `--include-hidden`
    // and `--only-hidden` — so it reads as "this one is put away", not as an
    // apology for a missing body (T-281).
    const away = isHidden(item) ? ` ${paint("dim", "(hidden)")}` : "";
    const questions =
      item.component?.type === "questions"
        ? `\n${renderQuestions(item.component, paint).join("\n")}\n  ${paint(
            "dim",
            `(answer: web, or \`todou question answer ${ctx.issueNumber} ${item.id}\`)`,
          )}`
        : "";
    if (item.component?.type === "spec_comment") {
      const anchor = item.component.anchor;
      const lines = anchorLines(anchor);
      const resolved = item.resolved_at === null ? "unresolved" : "resolved";
      const quote = anchor.quote
        .split("\n")
        .map((line) => paint("dim", `  > ${line}`))
        .join("\n");
      return `${id}${who(item.author)} commented on ${anchor.path}:${lines} (v${anchor.version}, ${resolved})${edited}${away} ${when}:\n${quote}\n${body}`;
    }
    return `${id}${who(item.author)} commented${edited}${away} ${when}:\n${body}${questions}`;
  }
  const answered = item.type === "event" ? decodeAnswerEvent(item) : null;
  if (answered !== null) {
    return [
      `${who(item.actor)} answered ${commentRef(answered.comment_id)} ${when}:`,
      ...renderAnswerRecords(answered.answers, paint),
    ].join("\n");
  }
  if (item.event_type === "title_changed") {
    return paint(
      "dim",
      `${personName(item.actor)}${agentSuffix(item.agent_context)} renamed "${String(item.payload.from)}" → "${String(item.payload.to)}" ${when}`,
    );
  }
  const detail = eventDetail(item, ctx);
  return paint(
    "dim",
    `${personName(item.actor)}${agentSuffix(item.agent_context)} ${item.event_type}${detail ? ` (${detail})` : ""} ${when}`,
  );
}

/** Where a spec annotation hangs: a line, a range, or the file as a whole. */
function anchorLines(anchor: {
  line_start: number | null;
  line_end: number | null;
}): string {
  if (anchor.line_start === null) return "file";
  return anchor.line_end === anchor.line_start
    ? `L${anchor.line_start}`
    : `L${anchor.line_start}-${anchor.line_end}`;
}

/**
 * What a bare `--summary` means. Truncating at all is opt-in since T-283 —
 * 83% of this tracker's comments are longer than this, and an agent handed
 * the first fifth of an instruction has to fetch the rest — so the number
 * only has to be the width someone asking for one line per entry wants.
 */
export const BARE_SUMMARY_CHARS = 120;

/** Where a one-line entry is being shown, and how much body it may show. */
export type ActivityLineContext = TimelineRenderContext & {
  /** The issue's ref as this stream spells it: "T-146", or "backend/7". */
  refLabel: string;
  /** 0 = the whole body; a positive width = cut to it, one line per entry. */
  summaryChars: number;
};

/**
 * One entry, one block — what a watch prints and a sentinel greps. The
 * header line starts at column 0 and every continuation line is indented,
 * so a `^\S` split still separates one entry from the next; `--summary`
 * asks for the stricter shape of exactly one line per entry.
 *
 * A comment shows its body, not just its type: a stream that says "user
 * commented" and stops there is one whose reader misses instructions
 * addressed to them, which is the failure T-175 was filed for — and one
 * that shows the first 120 characters leaves the reader fetching the rest
 * by hand, which is T-283. Events reuse `eventDetail` verbatim so the two
 * renderers cannot drift apart in how they word a status change.
 */
export function renderActivityLine(
  item: TimelineItem,
  paint: Painter,
  ctx: ActivityLineContext,
): string {
  const ref = paint("bold", ctx.refLabel);
  const when = relativeTime(item.created_at);
  const who = (user: { display_name?: string; login: string }): string =>
    personLabel(user, item.agent_context, paint);
  if (item.type === "comment") {
    const edited = item.edited_at ? " (edited)" : "";
    const where =
      item.component?.type === "spec_comment"
        ? ` on ${item.component.anchor.path}:${anchorLines(item.component.anchor)} (v${item.component.anchor.version}, ${item.resolved_at === null ? "unresolved" : "resolved"})`
        : "";
    const questions =
      item.component?.type === "questions"
        ? ` [questions ×${item.component.questions.length}]`
        : "";
    // The badge is this block's count header, so it stays under `--summary`
    // even though the block it heads does not: the options are what makes
    // the entry multi-line, and the reader who asked for one line per entry
    // still has to learn there are questions waiting.
    const asked =
      ctx.summaryChars === 0 && item.component?.type === "questions"
        ? `\n${renderQuestions(item.component, paint, { descriptions: false }).join("\n")}`
        : "";
    // One entry per line here, so collapsing a run would mean nothing; what
    // the reader needs instead is an explained line rather than a blank body
    // where the elided text used to be (T-281).
    const said = isHidden(item)
      ? paint("dim", "(hidden)")
      : `${bodyBlock(item.body, ctx.summaryChars)}${asked}`;
    return `${ref} ${paint("dim", commentRef(item.id))} ${who(item.author)} commented${where}${edited} ${when}${questions}: ${said}`;
  }
  const answered = decodeAnswerEvent(item);
  if (answered !== null) {
    const answers = answered.answers
      .map((a) => {
        const parts = [
          ...(a.declined ? ["declined"] : []),
          ...a.selected.map((s) => s.label),
          ...(a.other === null ? [] : [a.other]),
        ];
        return `${a.key}=${parts.join(", ")}`;
      })
      .join("; ");
    return `${ref} ${who(item.actor)} answered ${commentRef(answered.comment_id)} ${when}: ${bodyBlock(answers, ctx.summaryChars)}`;
  }
  const opened = openedCard(item, ctx);
  if (opened !== undefined) {
    // The title rides on the header, quoted, the way `title_changed` spells a
    // rename — so everything after the colon is still the body, and nothing
    // after it is the title. It is not `--summary`'s business either (T-283):
    // 88 characters is the longest one this tracker has.
    const head = `${ref} ${paint(
      "dim",
      `${personName(item.actor)}${agentSuffix(item.agent_context)} opened "${opened.title}" ${when}`,
    )}`;
    const body = opened.body === null ? "" : opened.body.trim();
    return body === "" ? head : `${head}: ${bodyBlock(body, ctx.summaryChars)}`;
  }
  const detail = eventDetail(item, ctx);
  return `${ref} ${paint(
    "dim",
    `${personName(item.actor)}${agentSuffix(item.agent_context)} ${item.event_type}${detail ? ` (${detail})` : ""} ${when}`,
  )}`;
}

/**
 * The card an `opened` entry announces, or undefined when this line has to
 * stay as it was. The event's payload is `{}` — the title and body were never
 * in this stream — so the whole shape depends on a resolver having run
 * (T-286); one that could not name the card leaves the plain line, which is
 * what every caller that passes no resolver at all gets.
 */
function openedCard(
  item: TimelineItem,
  ctx: TimelineRenderContext,
): { title: string; body: string | null } | undefined {
  if (item.type !== "event" || item.event_type !== "opened") return undefined;
  if (ctx.project === undefined) return undefined;
  return ctx.cardOf?.(ctx.project, ctx.issueNumber);
}

/**
 * The parenthetical after an event's type: what actually changed, plus a
 * follow-up command for spec events. Payloads are untyped over the wire,
 * so a shape this code does not recognize falls back to the scalar dump
 * instead of crashing on a newer server.
 */
function eventDetail(event: TimelineEvent, ctx: TimelineRenderContext): string {
  const payload = event.payload;
  switch (event.event_type) {
    case "closed":
    case "reopened":
    case "status_changed": {
      if (payload.from === undefined && payload.to === undefined) {
        return scalarDetail(payload);
      }
      return `${nested(payload.from, "name")} → ${nested(payload.to, "name")}`;
    }
    // `renderTimelineItem` words this one as prose before ever reaching
    // here; the one-line renderer has no room for prose and needs the
    // parenthetical, so the titles live here rather than in a scalar dump.
    case "title_changed":
      return `"${String(payload.from)}" → "${String(payload.to)}"`;
    case "label_added":
    case "label_removed":
      return nested(payload.label, "name");
    case "assigned":
    case "unassigned":
      // The payload only ever stored `{id, login}`, so historical events
      // have no display name to show (T-149).
      return `@${nested(payload.user, "login")}`;
    // One event type since T-266. A reference from this project is spelled
    // in its format; one from elsewhere is spelled self-containedly, so it
    // pastes straight back into any command that takes an issue.
    case "referenced":
    case "cross_referenced": {
      const target = referenceTarget(payload, ctx);
      if (target === null) return scalarDetail(payload);
      const card =
        target.slug === null
          ? undefined
          : ctx.cardOf?.(target.slug, target.number);
      const title = card === undefined ? "" : ` "${card.title}"`;
      // The comment the mention was written in, where the payload recorded
      // one: `comment view` takes this string as its argument (T-283).
      const where =
        typeof payload.by_comment === "number"
          ? ` ${commentRef(payload.by_comment)}`
          : "";
      return `by ${target.ref}${title}${where}`;
    }
    case "moved_in": {
      const from =
        typeof payload.from_project === "string" &&
        typeof payload.from_number === "number"
          ? `${payload.from_project}/${payload.from_number}`
          : "another project";
      const status =
        typeof payload.status_from === "string" &&
        typeof payload.status_to === "string" &&
        payload.status_from !== payload.status_to
          ? ` (${payload.status_from} → ${payload.status_to})`
          : "";
      const dropped = Array.isArray(payload.dropped_labels)
        ? payload.dropped_labels.filter(
            (l): l is string => typeof l === "string",
          )
        : [];
      const lost =
        dropped.length > 0 ? `; dropped labels: ${dropped.join(", ")}` : "";
      return `from ${from}${status}${lost}`;
    }
    case "moved_out":
      return typeof payload.to_project === "string" &&
        typeof payload.to_number === "number"
        ? `to ${payload.to_project}/${payload.to_number}`
        : "to another project";
    case "attachment_added":
      return payload.attachment === undefined
        ? scalarDetail(payload)
        : nested(payload.attachment, "filename");
    case "spec_pushed": {
      const spec = SpecPushedPayload.safeParse(payload);
      if (!spec.success) return scalarDetail(payload);
      const files = (
        [
          [spec.data.added.length, "added"],
          [spec.data.changed.length, "changed"],
          [spec.data.removed.length, "removed"],
        ] as const
      )
        .filter(([n]) => n > 0)
        .map(([n, word]) => `${n} ${word}`)
        .join(", ");
      const message =
        spec.data.message === null ? "" : ` — ${spec.data.message}`;
      return `v${spec.data.version}${files ? `: ${files}` : ""}${message} · ${specPullHint(ctx, spec.data.version)}`;
    }
    case "spec_review": {
      const review = SpecReviewPayload.safeParse(payload);
      if (!review.success) return scalarDetail(payload);
      const { version, verdict, annotation_count } = review.data;
      const outcome = {
        approve: "approved",
        request_changes: "changes requested",
        comment: "commented",
      }[verdict];
      const notes =
        annotation_count > 0 ? `, ${annotation_count} annotation(s)` : "";
      // A `comment` round that left no annotations has nothing to list, so
      // it points at the documents; every other combination keeps the hint
      // it already had.
      const hint =
        verdict === "approve" ||
        (verdict === "comment" && annotation_count === 0)
          ? specPullHint(ctx, version)
          : `use \`todou spec comments ${ctx.issueNumber} --unresolved\` to view`;
      return `v${version} ${outcome}${notes} · ${hint}`;
    }
    case "spec_comments_resolved": {
      if (!Array.isArray(payload.comment_ids)) return scalarDetail(payload);
      const paths = Array.isArray(payload.paths)
        ? payload.paths.filter((p): p is string => typeof p === "string")
        : [];
      const where = paths.length > 0 ? ` on ${paths.join(", ")}` : "";
      return `${payload.comment_ids.length} annotation(s)${where}`;
    }
    default:
      return scalarDetail(payload);
  }
}

/** Which card a reference event points at, and how this reader spells it. */
export type ReferenceTarget = {
  /** What follows `by `, in the spelling this stream uses. */
  ref: string;
  /** `cardOf`'s key for that card; null = no project here can name it. */
  slug: string | null;
  number: number;
};

/**
 * Where a reference came from, decided once for both readers of the answer:
 * the line that spells it, and the batch resolver that fetches its title
 * (activity-cards.ts). Two copies of this reasoning would eventually disagree
 * about which card a title belongs to, and a line naming one card while
 * quoting another's title is worse than a line with no title at all.
 *
 * `null` means the payload is a shape this code does not recognize, which is
 * the caller's cue to dump its scalars rather than invent a ref.
 */
export function referenceTarget(
  payload: Record<string, unknown>,
  ctx: ReferenceOrigin,
): ReferenceTarget | null {
  const number = payload.by_issue;
  if (typeof number !== "number") return null;
  const id = payload.by_project_id;
  const legacy =
    typeof payload.by_project === "string" ? payload.by_project : null;
  const local =
    // Neither spelling: a local reference from before the merge, which is
    // the only kind the old `referenced` type ever held.
    (typeof id !== "number" && legacy === null) ||
    (typeof id === "number" && id === ctx.projectId);
  if (local) {
    return {
      ref: formatRef(ctx.refPrefix, number),
      slug: ctx.project ?? null,
      number,
    };
  }
  const slug = ctx.slugOfProject?.(id) ?? legacy;
  // An id nobody could name still pastes back in: the server reads a
  // project id wherever it reads a slug.
  if (slug === null) {
    return typeof id === "number"
      ? { ref: `${id}/${number}`, slug: null, number }
      : null;
  }
  return { ref: `${slug}#${number}`, slug, number };
}

/**
 * Pinned to the entry's own version — the current version may already be
 * newer than the one this event talks about. `<empty-dir>` (rather than
 * `<dir>`) steers the reader away from a directory with existing files:
 * pull overwrites same-named files and keeps foreign .md files unless
 * --prune deletes them, and a hint should not suggest either hazard.
 */
function specPullHint(ctx: TimelineRenderContext, version: number): string {
  return `use \`todou spec pull ${ctx.issueNumber} --version ${version} <empty-dir>\` to view`;
}

/** A string field off a nested payload object; "?" mirrors the web's fallback. */
function nested(v: unknown, key: "name" | "login" | "filename"): string {
  return typeof v === "object" && v !== null && key in v
    ? String((v as Record<string, unknown>)[key])
    : "?";
}

function scalarDetail(payload: Record<string, unknown>): string {
  return Object.entries(payload)
    .filter(([, v]) => typeof v === "string" || typeof v === "number")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
}
