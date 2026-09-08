import type { HidePolicy, SkipReason, TodouClient } from "@todou/shared";
import { selectHidable } from "@todou/shared";
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

const REASONS: Record<SkipReason, string> = {
  open_question: "question unanswered",
  unresolved_anchor: "spec annotation unresolved",
  kept_tail: "within the tail kept back",
  already: "already in that state",
  not_a_comment: "not a comment on this card",
};

export type HideOutcome = {
  /** Ids this run wrote, in timeline order. */
  written: number[];
  /** Ids it left alone, each with its reason. */
  skipped: Array<{ id: number; reason: SkipReason }>;
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
  const { pick, skip } = selectHidable(items, policy, {
    hidden: opts.hidden,
  });
  const outcome: HideOutcome = { written: pick, skipped: skip };

  if (opts.dryRun) {
    return { ...outcome, preview: preview(items, pick, skip, opts.hidden) };
  }
  for (let at = 0; at < pick.length; at += BATCH) {
    await client.setCommentsHidden(project, number, {
      hidden: opts.hidden,
      comment_ids: pick.slice(at, at + BATCH),
    });
  }
  return { ...outcome, preview: [] };
}

function preview(
  items: Awaited<ReturnType<typeof drainTimeline>>["items"],
  pick: number[],
  skip: Array<{ id: number; reason: SkipReason }>,
  hidden: boolean,
): string[] {
  const byId = new Map(
    items
      .filter((item) => item.type === "comment")
      .map((item) => [item.id, item] as const),
  );
  const verb = hidden ? "hide" : "unhide";
  const lines = [`would ${verb} ${pick.length} comment(s)`];
  for (const id of pick.slice(0, DRY_RUN_PICKS)) {
    const comment = byId.get(id);
    const who = comment?.author.login ?? "";
    const when = comment === undefined ? "" : relativeTime(comment.created_at);
    lines.push(
      `  ${commentRef(id)}  ${who}  ${when}  ${summarize(comment?.body ?? "", 60)}`,
    );
  }
  if (pick.length > DRY_RUN_PICKS) {
    lines.push(`  … ${pick.length - DRY_RUN_PICKS} more`);
  }
  if (skip.length > 0) {
    lines.push("", `would skip ${skip.length} comment(s)`);
    for (const entry of skip) {
      lines.push(`  ${commentRef(entry.id)}  ${REASONS[entry.reason]}`);
    }
  }
  return lines;
}

/**
 * `hid 8 comment(s) on T-281 · 2 skipped (… --dry-run to see why)`. The
 * command that would explain the skips is spelled out, because the reason a
 * comment stayed behind is the one thing this line cannot fit.
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
  return `${paint("bold", `${verb} ${outcome.written.length} comment(s)`)}${paint(
    "dim",
    ` on ${opts.issueRef}${skipped}`,
  )}`;
}
