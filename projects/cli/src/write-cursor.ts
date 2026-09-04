import type { AgentContext, TimelineItem, TodouClient } from "@todou/shared";
import { formatRef } from "@todou/shared";
import type { Clock } from "./clock.ts";
import { CliError } from "./errors.ts";
import type { Painter } from "./format.ts";
import { drainTimeline, renderActivityLine } from "./timeline.ts";
import {
  describeError,
  resolveSelfFilter,
  retryTransient,
  watchRetryOptions,
} from "./watch-loop.ts";

/**
 * The waiting half of a write (T-182). `spec push` and `comment add` are
 * the two writes somebody then waits on — for a verdict, for an answer —
 * and both used to hand the waiter nothing, so the wait started at a "now"
 * taken *after* the write and skipped whatever landed in between. The
 * server now mints the position of the write itself; this module is the
 * command-side half, shared so the two cannot drift on flag names, output
 * shape or the meaning of `--since`.
 */

/** Body characters a missed entry shows, matching `issue watch`'s default. */
const SUMMARY_CHARS = 120;

export type WriteCursorFlags = {
  json: boolean;
  printCursor: boolean;
  since: string | undefined;
  /** Only `spec push` has one; see the conflict below. */
  wait?: boolean;
};

/**
 * Checked before the write runs, never after: a rejected flag combination
 * must cost nothing, and a spec version or a comment posted only to be
 * followed by a usage error is not something the caller can undo.
 */
export function assertWriteCursorFlags(flags: WriteCursorFlags): void {
  if (flags.wait && flags.printCursor) {
    throw new CliError(
      "--wait and --print-cursor both want stdout",
      "--print-cursor hands the cursor to a second command that waits; --wait does the waiting here, and prints the outcome instead",
    );
  }
  if (flags.printCursor && flags.json) {
    throw new CliError(
      "--print-cursor and --json both want stdout",
      "drop one — --json already carries the cursor as a field",
    );
  }
  if (flags.since === "") {
    throw new CliError(
      "--since was given an empty cursor",
      "a `cursor=$(…)` capture that failed leaves it empty — an empty --since would mean the whole timeline, so it is refused instead",
    );
  }
}

export type WriteCursorOutcome = {
  /** Where to start waiting; undefined when the server minted none. */
  cursor: string | undefined;
  /** What landed in the caller's blind window; null without `--since`. */
  missed: TimelineItem[] | null;
};

export async function collectWriteCursor(args: {
  client: TodouClient;
  project: string;
  number: number;
  /**
   * The cursor the write's own response carried. Optional against the
   * response type on purpose: a server predating T-182 sends no such
   * field, and the CLI ships ahead of every deployment at least once.
   */
  served: string | undefined;
  since: string | undefined;
  agentContext: AgentContext | null;
  note: (line: string) => void;
  clock: Clock;
}): Promise<WriteCursorOutcome> {
  const { since } = args;
  if (since === undefined) return { cursor: args.served, missed: null };

  // The caller's own cursor is echoed back rather than replaced by the
  // server's newer one: everything reported here is still ahead of it, so
  // a caller that drops this stderr gets the same entries again from the
  // next watch. At-least-once beats a tidier cursor.
  const retry = watchRetryOptions({ poll: true }, args.note, args.clock);
  try {
    const self = await resolveSelfFilter(args.client, args.agentContext, retry);
    const { items } = await retryTransient(
      () =>
        drainTimeline(args.client, args.project, args.number, {
          after: since,
          ...self,
        }),
      retry,
    );
    return { cursor: since, missed: items };
  } catch (error) {
    // The write itself has already landed. Failing the command here would
    // take its id or version down with it and invite a retry of a write
    // that succeeded, so the gap report degrades to a warning.
    args.note(
      `could not read what landed since --since: ${describeError(error)}`,
    );
    return { cursor: since, missed: null };
  }
}

export type WriteCursorEmit = {
  json: boolean;
  printCursor: boolean;
  paint: Painter;
  /** How this project spells refs; only the missed lines need it. */
  refPrefix: string | null;
  issueNumber: number;
  /** stdout, one write per call, newline added here. */
  write: (text: string) => void;
  note: (line: string) => void;
  /**
   * Set when more records follow this one on stdout: the write is the head
   * of a stream rather than the whole answer, so under `--json` it has to
   * be one compact NDJSON line carrying this discriminator instead of an
   * indented document (T-208).
   */
  compact?: { type: string };
  /**
   * What the text-mode cursor line names as the command to resume with, or
   * `null` to leave the line out because whatever runs next prints the
   * position itself. Two `cursor:` lines in one output — the write's and the
   * wait's, identical whenever the wait returns at once — read as a glitch,
   * and the useful one is the wait's: after a wake-up the write's position
   * has already been consumed.
   */
  cursorHint?: string | null;
};

/**
 * The three output postures of a write, in one place. `data` is the
 * command's own `--json` object; `human` its prose summary. The cursor
 * overrides whatever `data` carried, because under `--since` the reported
 * position is the caller's, not the server's.
 */
export function emitWriteResult(
  emit: WriteCursorEmit,
  outcome: WriteCursorOutcome,
  data: object,
  human: () => string,
): void {
  if (emit.json) {
    const payload = {
      ...(emit.compact === undefined ? {} : emit.compact),
      ...data,
      ...(outcome.cursor === undefined ? {} : { cursor: outcome.cursor }),
      ...(outcome.missed === null ? {} : { missed: outcome.missed }),
    };
    emit.write(
      emit.compact === undefined
        ? JSON.stringify(payload, null, 2)
        : JSON.stringify(payload),
    );
    return;
  }
  if (emit.printCursor) {
    for (const line of human().split("\n")) emit.note(line);
    noteMissed(emit, outcome.missed);
    emit.write(requireCursor(outcome.cursor));
    return;
  }
  const hint =
    emit.cursorHint === undefined
      ? "issue watch --since <cursor>"
      : emit.cursorHint;
  emit.write(
    [
      human(),
      ...(outcome.cursor === undefined || hint === null
        ? []
        : [emit.paint("dim", `cursor: ${outcome.cursor} (${hint})`)]),
    ].join("\n"),
  );
  noteMissed(emit, outcome.missed);
}

/**
 * Under `--print-cursor` stdout is the whole product, so an absent cursor
 * cannot be passed over quietly: the capture would come back empty and the
 * wait would silently restart from "now" — the very failure this flag
 * exists to make impossible.
 */
function requireCursor(cursor: string | undefined): string {
  if (cursor !== undefined) return cursor;
  throw new CliError(
    "the server returned no cursor to print",
    "it predates T-182; pass --since with a cursor you already hold, or take one with `todou watch -p <proj> --poll --print-cursor`",
  );
}

function noteMissed(
  emit: WriteCursorEmit,
  missed: TimelineItem[] | null,
): void {
  if (missed === null || missed.length === 0) return;
  emit.note(
    emit.paint(
      "dim",
      `${missed.length} ${missed.length === 1 ? "entry" : "entries"} landed since --since (a watch from that cursor replays them):`,
    ),
  );
  for (const item of missed) {
    emit.note(
      renderActivityLine(item, emit.paint, {
        refLabel: formatRef(emit.refPrefix, emit.issueNumber),
        issueNumber: emit.issueNumber,
        refPrefix: emit.refPrefix,
        summaryChars: SUMMARY_CHARS,
      }),
    );
  }
}
