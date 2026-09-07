import type {
  AgentContext,
  SpecInfo,
  SpecReviewStatus,
  TimelineItem,
  TodouClient,
} from "@todou/shared";
import { formatRef } from "@todou/shared";
import { cursorRecord } from "./api-command.ts";
import { openChangeNudges } from "./change-nudges.ts";
import type { Clock } from "./clock.ts";
import { type Painter, plural } from "./format.ts";
import { refFormat } from "./refs.ts";
import { fetchRefPrefix } from "./resolve.ts";
import { drainTimeline, renderActivityLine, tailCursor } from "./timeline.ts";
import {
  quietNote,
  resolveSelfFilter,
  retryTransient,
  runWatchLoop,
  watchRetryOptions,
} from "./watch-loop.ts";

/**
 * The review gate, as one call (T-208). `write-cursor.ts` is the other half
 * of this story: it decides which cursor a write hands its waiter. This
 * module takes that cursor and blocks until the spec has been judged.
 *
 * Both entry points — `spec push --wait` and `spec wait` — run this same
 * code, so they cannot drift on what `--since` means, what the exits are
 * called, or what the output looks like.
 */

export type SpecOutcomeName = "approved" | "changes_requested" | "feedback";

export type SpecOutcome = {
  outcome: SpecOutcomeName;
  review_status: SpecReviewStatus;
  unresolved_comments: number;
  /** Of those, the ones anchored to an older version — see `judgeSpec`. */
  carried_comments: number;
  version: number;
};

/**
 * The verdict, read off the spec's state rather than off the event stream:
 * an unrelated wake-up misread as an approval is worse than the idle wait it
 * would replace. `null` means nobody has judged this version yet.
 */
export function judgeSpec(info: SpecInfo): SpecOutcome | null {
  const state = {
    review_status: info.review_status,
    unresolved_comments: info.unresolved_comments,
    carried_comments: carriedComments(info),
    version: info.current_version,
  };
  // Approved beats outstanding annotations on purpose. "Approved, and fix
  // this nit while you are in there" is a verdict, not a revision round;
  // the count rides along on the outcome line so the nit is not lost.
  if (info.review_status === "approved") {
    return { outcome: "approved", ...state };
  }
  if (info.review_status === "changes_requested") {
    return { outcome: "changes_requested", ...state };
  }
  // A push resets the verdict but never the annotation count, so an
  // unreviewed version still carrying *older* annotations is the pusher's
  // own doing: it addressed a review and forgot to resolve what it
  // addressed. Annotations anchored to the current version are the other
  // case entirely — only a `comment` review can have left them there
  // (T-277), and that round judged nothing, so it belongs in `feedback`.
  if (state.carried_comments > 0) {
    return { outcome: "changes_requested", ...state };
  }
  return null;
}

/**
 * Widened against the response type for the same reason
 * `servedVersionCursor` is: the CLI ships ahead of every deployment at
 * least once, and a server predating T-277 sends no such key. Falling back
 * to the whole count reproduces that server's own behaviour, where an
 * unreviewed version with anything outstanding meant a revision round.
 */
function carriedComments(info: SpecInfo): number {
  return (
    (info as { unresolved_carried_comments?: number })
      .unresolved_carried_comments ?? info.unresolved_comments
  );
}

function outcomeLine(outcome: SpecOutcome, paint: Painter): string {
  const n = outcome.unresolved_comments;
  const annotations = `${n} ${plural(n, "unresolved annotation")}`;
  const version = `spec v${outcome.version}`;
  if (outcome.outcome === "approved") {
    return [
      paint("green", "approved"),
      version,
      ...(n > 0 ? [annotations] : []),
    ].join(" · ");
  }
  if (outcome.outcome === "changes_requested") {
    return [
      paint("yellow", "changes requested"),
      version,
      // Naming the state keeps the line honest where the routing is the
      // same but the cause is not: nobody requested changes here, the
      // pusher left annotations unresolved. Since T-277 the two counts can
      // differ — a `comment` round adds annotations on the current version,
      // which are not what made this a revision round — so the split is
      // spelled out rather than letting the total claim to be carried.
      outcome.review_status !== "unreviewed"
        ? annotations
        : outcome.carried_comments === n
          ? `${annotations} carried over — no new verdict`
          : `${annotations}, ${outcome.carried_comments} carried over — no new verdict`,
    ].join(" · ");
  }
  return `${paint("cyan", "feedback")} · no verdict on ${version} yet`;
}

/**
 * Where the current version was pushed, as the server reported it. Widened
 * against the response type on purpose: the schema calls the field
 * required, a server predating it sends nothing at all, and the CLI ships
 * ahead of every deployment at least once — the same posture `spec push`
 * takes towards its own cursor (T-182).
 */
function servedVersionCursor(info: SpecInfo): string | undefined {
  return (info as { current_version_cursor?: string }).current_version_cursor;
}

export async function waitForSpecReview(args: {
  client: TodouClient;
  project: string;
  number: number;
  /**
   * The cursor the caller already holds — a push's own position, or a
   * `--since` it was given. Undefined means "start where the current
   * version was pushed", which is what a cold re-entry wants.
   */
  from: string | undefined;
  /** This session's harness identity, for the self-filter below. */
  agentContext: AgentContext | null;
  debounceSec: number;
  timeoutSec: number;
  intervalSec: number;
  paint: Painter;
  clock: Clock;
  note: (line: string) => void;
  /** The command's own `outputBatch`: NDJSON under --json, prose otherwise. */
  emitBatch: (records: unknown[], human: () => string) => void;
}): Promise<number> {
  const { client, project, number, timeoutSec } = args;
  const retry = watchRetryOptions(
    { poll: false, forever: true },
    args.note,
    args.clock,
  );
  const readSpec = () =>
    retryTransient(() => client.getSpec(project, number), retry);

  let info = await readSpec();
  let baseline: string | undefined = args.from ?? servedVersionCursor(info);
  if (baseline === undefined) {
    args.note(
      "this server does not report where the current version was pushed; " +
        "waiting from now instead — anything said between the push and now " +
        "stays unread (the verdict itself is still read from the spec state)",
    );
    baseline = await retryTransient(
      () => tailCursor(client, project, number),
      retry,
    );
    // That cursor was taken after the state read above, so a verdict landing
    // between the two would sit behind both. One more read closes it; the
    // other two ways in are already ordered write-then-read.
    info = await readSpec();
  }

  const refPrefix = await fetchRefPrefix(client, project);
  // The one cursor line of the whole gate — `spec push --wait` leaves its own
  // out — so it names the card. A prefix-less project spells refs `#23`,
  // which a shell reads as a comment: the bare number is what pastes back.
  const resumeHint = `spec wait ${refPrefix === null ? number : formatRef(refPrefix, number)} --since <cursor>`;
  const emit = (
    items: TimelineItem[],
    cursor: string | undefined,
    outcome: SpecOutcome,
  ): void =>
    args.emitBatch(
      [
        ...items,
        cursorRecord(cursor, refFormat(refPrefix)),
        { type: "outcome", ...outcome },
      ],
      () =>
        [
          ...items.map((item) =>
            renderActivityLine(item, args.paint, {
              refLabel: formatRef(refPrefix, number),
              issueNumber: number,
              // No flag reaches here, and this path exists for exactly the
              // case a truncated body ruins: somebody amended the
              // requirement in a plain comment instead of a verdict.
              summaryChars: 0,
              refPrefix,
            }),
          ),
          ...(cursor === undefined
            ? []
            : [args.paint("dim", `cursor: ${cursor} (${resumeHint})`)]),
          outcomeLine(outcome, args.paint),
        ].join("\n"),
    );

  // A wait only wakes for the future, so a verdict that is already in has to
  // be read before blocking rather than waited for.
  const settled = judgeSpec(info);
  if (settled !== null) {
    emit([], baseline, settled);
    return 0;
  }

  // This agent session, not the whole account — the same pair `issue watch`
  // uses. Filtering by account was safe while every review carried a
  // verdict, since the pusher's account was barred from reviewing at all;
  // a `comment` review is not (T-277), and a sibling agent on the shared
  // machine account is exactly who writes one. The price is that the
  // account's other sessions now wake this wait with ordinary comments too.
  const selfFilter = await resolveSelfFilter(client, args.agentContext, retry);
  const nudges = await openChangeNudges({
    client,
    projects: new Set([project]),
    issue: number,
    intervalSec: args.intervalSec,
    clock: args.clock,
  });

  let woke: TimelineItem[] = [];
  let cursor = baseline;
  try {
    await runWatchLoop<TimelineItem>({
      poll: false,
      forever: true,
      timeoutSec,
      intervalSec: args.intervalSec,
      debounceSec: args.debounceSec,
      baseline,
      retry,
      clock: args.clock,
      wait: nudges.wait,
      onQuiet: (_cursor, totalMs) =>
        args.note(
          quietNote("still waiting for a verdict", timeoutSec, totalMs),
        ),
      // No `types` filter: a plain comment — an amended requirement, a
      // question back — has to wake the waiter as surely as a verdict does.
      drain: (after) =>
        drainTimeline(client, project, number, { after, ...selfFilter }),
      onItems: (items, next) => {
        woke = items;
        cursor = next ?? cursor;
      },
      // Unreachable under `forever`, which returns only with entries or by
      // throwing; the loop demands the callback anyway.
      onEmpty: () => {},
    });
  } finally {
    nudges.close();
  }

  const fresh = await readSpec();
  emit(
    woke,
    cursor,
    judgeSpec(fresh) ?? {
      outcome: "feedback",
      review_status: fresh.review_status,
      unresolved_comments: fresh.unresolved_comments,
      carried_comments: carriedComments(fresh),
      version: fresh.current_version,
    },
  );
  return 0;
}
