import type { TimelineEvent, TimelineItem, TodouClient } from "@todou/shared";
import { formatRef, SpecPushedPayload, SpecReviewPayload } from "@todou/shared";
import { type Painter, personName, relativeTime, summarize } from "./format.ts";
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
  opts: { after?: string; types?: string } & SelfFilter = {},
): Promise<{ items: TimelineItem[]; cursor: string | undefined }> {
  return drainPaged("timeline", opts.after, (after) =>
    client.getTimeline(project, number, {
      after,
      types: opts.types,
      exclude_actor: opts.excludeActor,
      exclude_agent_session: opts.excludeAgentSession,
      limit: 100,
    }),
  );
}

/** Where the item is being shown from, for refs and command hints. */
export type TimelineRenderContext = {
  issueNumber: number;
  refPrefix: string | null;
  /**
   * Head a comment block with `comment <id> ·`. Off everywhere the block
   * sits inside a card the reader is looking at whole — there the id is
   * noise. `comment list`/`view` turn it on because handing the id back is
   * what they exist for: it is `comment edit/delete/view`'s argument and
   * the `#comment-<id>` permalink (T-183).
   */
  showId?: boolean;
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
};

export function renderTimelineItem(
  item: TimelineItem,
  paint: Painter,
  ctx: TimelineRenderContext,
): string {
  const when = relativeTime(item.created_at);
  if (item.type === "comment") {
    const body = item.body
      .trimEnd()
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
    const id = ctx.showId ? `${paint("dim", `comment ${item.id} ·`)} ` : "";
    const edited = item.edited_at ? " (edited)" : "";
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
      return `${id}${paint("cyan", personName(item.author))} commented on ${anchor.path}:${lines} (v${anchor.version}, ${resolved})${edited} ${when}:\n${quote}\n${body}`;
    }
    return `${id}${paint("cyan", personName(item.author))} commented${edited} ${when}:\n${body}${questions}`;
  }
  const answered = item.type === "event" ? decodeAnswerEvent(item) : null;
  if (answered !== null) {
    return [
      `${paint("cyan", personName(item.actor))} answered comment ${answered.comment_id} ${when}:`,
      ...renderAnswerRecords(answered.answers, paint),
    ].join("\n");
  }
  if (item.event_type === "title_changed") {
    return paint(
      "dim",
      `${personName(item.actor)} renamed "${String(item.payload.from)}" → "${String(item.payload.to)}" ${when}`,
    );
  }
  const detail = eventDetail(item, ctx);
  return paint(
    "dim",
    `${personName(item.actor)} ${item.event_type}${detail ? ` (${detail})` : ""} ${when}`,
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

/** Where a one-line entry is being shown, and how much body it may show. */
export type ActivityLineContext = TimelineRenderContext & {
  /** The issue's ref as this stream spells it: "T-146", or "backend/7". */
  refLabel: string;
  summaryChars: number;
};

/**
 * One entry, exactly one line — what a watch prints and a sentinel greps.
 *
 * A comment shows the start of its body, not just its type: a stream that
 * says "user commented" and stops there is one whose reader misses
 * instructions addressed to them, which is the failure T-175 was filed for.
 * Events reuse `eventDetail` verbatim so the two renderers cannot drift
 * apart in how they word a status change.
 */
export function renderActivityLine(
  item: TimelineItem,
  paint: Painter,
  ctx: ActivityLineContext,
): string {
  const ref = paint("bold", ctx.refLabel);
  const when = relativeTime(item.created_at);
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
    return `${ref} ${paint("cyan", personName(item.author))} commented${where}${edited} ${when}${questions}: ${summarize(item.body, ctx.summaryChars)}`;
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
    return `${ref} ${paint("cyan", personName(item.actor))} answered comment ${answered.comment_id} ${when}: ${summarize(answers, ctx.summaryChars)}`;
  }
  const detail = eventDetail(item, ctx);
  return `${ref} ${paint(
    "dim",
    `${personName(item.actor)} ${item.event_type}${detail ? ` (${detail})` : ""} ${when}`,
  )}`;
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
      if (typeof payload.by_issue !== "number") return scalarDetail(payload);
      const id = payload.by_project_id;
      const legacy =
        typeof payload.by_project === "string" ? payload.by_project : null;
      // Neither spelling: a local reference from before the merge, which is
      // the only kind the old `referenced` type ever held.
      if (typeof id !== "number" && legacy === null) {
        return `by ${formatRef(ctx.refPrefix, payload.by_issue)}`;
      }
      if (typeof id === "number" && id === ctx.projectId) {
        return `by ${formatRef(ctx.refPrefix, payload.by_issue)}`;
      }
      const slug = ctx.slugOfProject?.(id) ?? legacy;
      // An id nobody could name still pastes back in: the server reads a
      // project id wherever it reads a slug.
      if (slug === null) {
        return typeof id === "number"
          ? `by ${id}/${payload.by_issue}`
          : scalarDetail(payload);
      }
      return `by ${slug}#${payload.by_issue}`;
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
      const outcome = verdict === "approve" ? "approved" : "changes requested";
      const notes =
        annotation_count > 0 ? `, ${annotation_count} annotation(s)` : "";
      const hint =
        verdict === "approve"
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
