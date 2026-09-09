import type {
  CrossedReason,
  HidePolicy,
  SkipReason,
  TodouClient,
} from "@todou/shared";
import { SKIP_REASON_LABEL, selectHidable } from "@todou/shared";
import { type Painter, relativeTime, summarize } from "./format.ts";
import { commentRef, drainTimeline } from "./timeline.ts";

/**
 * The shared half of `comment hide` and `comment unhide` (T-281): pick the
 * comments, or explain what a `--dry-run` would have picked.
 *
 * Both directions run the same selectors on purpose. Unhiding is not a
 * repair of a mistake but an entry of its own, so `--to` and `--all` have to
 * mean there what they mean when hiding.
 */

/** One transaction's worth of ids; a bigger selection goes in several. */
const BATCH = 500;

/**
 * How many picks a `--dry-run` lists before it says "… N more". The skips
 * are never trimmed: they are the half a reader opened `--dry-run` to
 * inspect, while the picks are volume.
 */
const DRY_RUN_PICKS = 10;

/** What hiding does to each crossing, which `unhide` will not take back. */
const CROSSED_EFFECT: Record<CrossedReason, string> = {
  open_question: "declined",
  unresolved_anchor: "resolved",
};

export type HideOutcome = {
  /** Ids this run wrote, in timeline order. */
  written: number[];
  /** Ids it left alone, each with its reason. */
  skipped: Array<{ id: number; reason: SkipReason }>;
  /** Ids it wrote that were not settled, and so got settled (T-307). */
  crossed: Array<{ id: number; reason: CrossedReason }>;
  /** What the server reported settling; absent on a `--dry-run`. */
  settled?: { declined: number[]; resolved: number[] };
};

export async function applyHidePolicy(
  client: TodouClient,
  project: string,
  number: number,
  policy: HidePolicy,
  opts: { hidden: boolean; dryRun: boolean },
): Promise<HideOutcome & { preview: string[] }> {
  // Hidden bodies are wanted here: a `--dry-run` quotes the comments it is
  // about to put away, and quoting an empty string tells the reader nothing.
  const { items } = await drainTimeline(client, project, number, {
    includeHidden: true,
  });
  const { pick, skip, crossed } = selectHidable(items, policy, {
    hidden: opts.hidden,
  });
  const outcome: HideOutcome = { written: pick, skipped: skip, crossed };

  if (opts.dryRun) {
    return { ...outcome, preview: preview(items, outcome, opts.hidden) };
  }
  const declined: number[] = [];
  const resolved: number[] = [];
  for (let at = 0; at < pick.length; at += BATCH) {
    const result = await client.setCommentsHidden(project, number, {
      hidden: opts.hidden,
      comment_ids: pick.slice(at, at + BATCH),
    });
    // Cast, not parsed: a server predating T-307 sends no `settled` at all,
    // and reading it as "settled nothing" is the right answer there.
    const settled = result.settled ?? null;
    if (settled === null) continue;
    declined.push(...settled.declined_questions);
    resolved.push(...settled.resolved_annotations);
  }
  return { ...outcome, settled: { declined, resolved }, preview: [] };
}

function preview(
  items: Awaited<ReturnType<typeof drainTimeline>>["items"],
  outcome: HideOutcome,
  hidden: boolean,
): string[] {
  const byId = new Map(
    items
      .filter((item) => item.type === "comment")
      .map((item) => [item.id, item] as const),
  );
  const verb = hidden ? "hide" : "unhide";
  const lines = [`would ${verb} ${outcome.written.length} comment(s)`];
  for (const id of outcome.written.slice(0, DRY_RUN_PICKS)) {
    const comment = byId.get(id);
    const who = comment?.author.login ?? "";
    const when = comment === undefined ? "" : relativeTime(comment.created_at);
    lines.push(
      `  ${commentRef(id)}  ${who}  ${when}  ${summarize(comment?.body ?? "", 60)}`,
    );
  }
  if (outcome.written.length > DRY_RUN_PICKS) {
    lines.push(`  … ${outcome.written.length - DRY_RUN_PICKS} more`);
  }
  if (outcome.crossed.length > 0) {
    lines.push(
      "",
      `would settle ${outcome.crossed.length} comment(s) while hiding — unhide does not undo this`,
    );
    for (const entry of outcome.crossed) {
      lines.push(
        `  ${commentRef(entry.id)}  ${SKIP_REASON_LABEL[entry.reason]} → ${CROSSED_EFFECT[entry.reason]}`,
      );
    }
  }
  if (outcome.skipped.length > 0) {
    lines.push("", `would skip ${outcome.skipped.length} comment(s)`);
    for (const entry of outcome.skipped) {
      lines.push(
        `  ${commentRef(entry.id)}  ${SKIP_REASON_LABEL[entry.reason]}`,
      );
    }
  }
  return lines;
}

/**
 * `hid 8 comment(s) on T-281 · 2 skipped (… --dry-run to see why)`. The
 * command that would explain the skips is spelled out, because the reason a
 * comment stayed behind is the one thing this line cannot fit.
 *
 * What the hide settled is counted here rather than hinted at: it is the
 * half of the write `unhide` cannot take back.
 */
export function hideSummary(
  outcome: HideOutcome,
  opts: { hidden: boolean; issueRef: string; dryRunCommand: string },
  paint: Painter,
): string {
  const verb = opts.hidden ? "hid" : "unhid";
  const skipped =
    outcome.skipped.length === 0
      ? ""
      : ` · ${outcome.skipped.length} skipped (${opts.dryRunCommand} to see why)`;
  const declined = outcome.settled?.declined.length ?? 0;
  const resolved = outcome.settled?.resolved.length ?? 0;
  const settled = [
    declined === 0 ? null : `declined ${declined} unanswered question(s)`,
    resolved === 0 ? null : `resolved ${resolved} annotation(s)`,
  ].filter((part): part is string => part !== null);
  return (
    `${paint("bold", `${verb} ${outcome.written.length} comment(s)`)}` +
    `${paint("dim", ` on ${opts.issueRef}${skipped}`)}` +
    `${settled.length === 0 ? "" : paint("bold", ` · ${settled.join(" · ")}`)}`
  );
}
