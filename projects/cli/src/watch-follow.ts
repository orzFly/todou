import { Option } from "clipanion";
import type { Clock } from "./clock.ts";
import { CliError } from "./errors.ts";
import type { makePainter } from "./format.ts";
import { detectPermissionMode } from "./harness/claude-code.ts";
import { openPeerPush, type PeerPush } from "./peer-push.ts";
import { describeError } from "./watch-loop.ts";

/** Which channel a standing watch delivers each batch over. */
export type Transport = "stdout" | "uds";

/**
 * The batching window a standing watch defaults to. The receiving side
 * appends ~140 tokens of boilerplate to every peer message with no way to
 * turn it off, so ten notifications pay for it ten times while one merged
 * notification pays once: message *count* costs far more than message
 * length, which makes waiting a minute to merge almost always the better
 * trade. `--debounce 0` opts back into immediate delivery.
 */
export const FOLLOW_DEBOUNCE_SEC = 60;

/**
 * The display label a push attests to, `<prefix>-<subject>`. It only decides
 * how the receiving session names the sender and takes no part in its
 * admission check, so unlike the permission mode there is nothing here to
 * get wrong. The subject is what keeps a project watch and three card
 * watches apart in a TUI that otherwise shows the same sender four times;
 * the prefix is spelled once, here, so no caller can spell it differently.
 */
const FROM_PREFIX = "todou-watch";

/**
 * What to change, per receipt status. `crossSessionInbound` short-circuits
 * the receiving session's admission check *ahead* of its own-process rule,
 * so it holds or refuses even a background process that session started
 * itself — which is why it is the setting to name in every refusal here.
 */
const REJECTION_HINT: Record<string, string> = {
  held: 'queued for approval — crossSessionInbound: "accept" delivers without confirming each one',
  refused: 'crossSessionInbound is set to "refuse"',
  denied: "the user declined it",
  dropped: "the session discarded it",
  expired: "it aged out unread",
  unreachable: "the session's socket could not be written to",
};

/**
 * One spelling of `--follow` for every command that has it. A factory rather
 * than a shared constant because clipanion reads the option off the instance
 * and never asks where the value came from — and because this flag's parsing
 * has a trap in it (`tolerateBoolean` below) that two hand-written copies
 * would eventually disagree about.
 */
export function followOption(): string | boolean | undefined {
  // `tolerateBoolean` only accepts `--follow=<value>`, never `--follow
  // <value>`, so a bare `--follow` cannot swallow the next argument.
  return Option.String("--follow", {
    tolerateBoolean: true,
    description:
      "Stay resident and deliver every batch: =stdout (the default) or =uds to push into the Claude Code session (conflicts with --poll)",
  });
}

/**
 * `--follow`, `--follow=stdout`, `--follow=uds` (alias
 * `claude-code-messaging`), or null when the flag is absent — plus every
 * contradiction the flag can be in, refused here rather than at each call
 * site. Splitting the two apart is how a second command ends up parsing the
 * flag and silently skipping half its validation, which nothing would report
 * until a user walked into it.
 *
 * The transport is deliberately not inferred from the environment. A
 * supervisor that runs a command and reads its stdout is started *by* the
 * session, so CLAUDE_CODE_MESSAGING_SOCKET is set for it too — guessing by
 * that variable would send exactly the batches that belong on stdout down
 * the push channel instead. A bare `--follow` means stdout because stdout is
 * the transport with no outside dependency.
 */
export function followTransport(opts: {
  raw: string | boolean | undefined;
  poll: boolean;
  /** Omitted by a command that has no `--print-cursor` to conflict with. */
  printCursor?: boolean;
  socket: string | undefined;
}): Transport | null {
  const { raw } = opts;
  if (raw === undefined || raw === false) return null;
  let transport: Transport;
  if (raw === true || raw === "stdout") {
    transport = "stdout";
  } else if (raw === "uds" || raw === "claude-code-messaging") {
    transport = "uds";
  } else {
    throw new CliError(
      `unknown --follow transport "${raw}"`,
      "valid transports: stdout (the default), uds (alias claude-code-messaging)",
    );
  }
  if (opts.poll) {
    throw new CliError(
      "--follow conflicts with --poll",
      "--poll checks once and leaves; --follow is the opposite — it never leaves",
    );
  }
  if (opts.printCursor) {
    throw new CliError(
      "--follow conflicts with --print-cursor",
      "--print-cursor writes one bare cursor and exits; a standing watch keeps minting them",
    );
  }
  if (transport === "uds" && !opts.socket) {
    throw new CliError(
      "CLAUDE_CODE_MESSAGING_SOCKET is not set in this environment",
      "--follow=uds pushes to the Claude Code session that exports it — use --follow=stdout anywhere else",
    );
  }
  return transport;
}

/**
 * How every batch ends. `since` appears only in standing mode, where the
 * pair states the range this batch covers — so a reader comparing one
 * message's `since` against the previous one's `cursor` can tell for itself
 * whether a notification went missing, instead of that being knowable only
 * on the sending side. A one-shot batch has no predecessor to abut and
 * keeps the single `cursor:` line it always had.
 */
export function cursorLines(
  since: string | undefined,
  cursor: string | undefined,
  paint: ReturnType<typeof makePainter>,
): string[] {
  return [
    ...(since === undefined ? [] : [paint("dim", `since: ${since}`)]),
    paint("dim", `cursor: ${cursor}`),
  ];
}

/** The standing-mode plumbing a watch branch hands to `runWatchLoop`. */
export type Follow<T> = {
  afterItems?: (
    items: T[],
    cursor: string | undefined,
  ) => Promise<"continue" | "stop">;
  shouldStop?: () => boolean;
  wait: ((maxMs: number) => Promise<void>) | undefined;
  /** Where the batch being delivered starts; unset outside standing mode. */
  since: () => string | undefined;
  /** True while a push owns delivery, so stdout must stay empty. */
  silent: boolean;
  /** Records a position the loop reported, for the exit flush. */
  seen: (cursor: string | undefined) => void;
  /** Hands over what is not known to have landed, then closes. */
  finish: () => void;
};

/**
 * The standing-mode plumbing (T-252): the two hooks `runWatchLoop` needs,
 * a wait a refusal can cut short, and the flush that hands over whatever
 * is not known to have been delivered.
 *
 * A push that cannot be opened degrades here instead of pushing blind.
 * The failure this flag exists to remove is a batch disappearing into a
 * hold with nobody the wiser, so a watch that cannot confirm delivery has
 * no business claiming any: it falls back to the one batch and the exit
 * that `todou watch` has always done.
 */
export async function openFollow<T>(opts: {
  transport: Transport | null;
  /** Names the command in a push header, so a reader can re-run it. */
  label: string;
  /** What this watch is on, for the sender's display name. */
  subject: string;
  baseline: string | undefined;
  intervalSec: number;
  wait: ((maxMs: number) => Promise<void>) | undefined;
  render: (
    items: T[],
    since: string | undefined,
    cursor: string | undefined,
  ) => string;
  emit: (
    items: T[],
    since: string | undefined,
    cursor: string | undefined,
  ) => void;
  socket: string | undefined;
  sessionId: string | undefined;
  clock: Clock;
  note: (line: string) => void;
  /** Test seam; production leaves it unset and a real socket is dialled. */
  open?: typeof openPeerPush;
}): Promise<Follow<T>> {
  /** Newest position the loop has reported, for the exit flush. */
  let seenCursor = opts.baseline;
  /** Where the next batch's range starts: the last delivered cursor. */
  let rangeStart = opts.baseline;
  const oneShot: Follow<T> = {
    wait: opts.wait,
    since: () => undefined,
    silent: false,
    seen: () => {},
    finish: () => {},
  };
  if (opts.transport === null) return oneShot;

  let opened: PeerPush<T> | null = null;
  if (opts.transport === "uds") {
    const open = opts.open ?? openPeerPush;
    try {
      opened = await open<T>({
        // `followTransport` refuses an unset socket before any I/O.
        target: opts.socket as string,
        clock: opts.clock,
        fromName: `${FROM_PREFIX}-${opts.subject}`,
        // Attested only where the transcript is unambiguous: an
        // unattested message is held only if the target session is in
        // bypass, while a wrongly attested one is held outright.
        fromMode: detectPermissionMode(opts.sessionId),
        render: (items, since, cursor) =>
          [
            `${opts.label} — ${items.length} new ${items.length === 1 ? "entry" : "entries"}`,
            opts.render(items, since, cursor),
          ].join("\n"),
      });
    } catch (error) {
      opts.note(
        `--follow=uds could not open its receipt socket (${describeError(error)}) — ` +
          "delivering one batch and exiting, as without --follow",
      );
      return oneShot;
    }
  }

  const push = opened;
  return {
    since: () => rangeStart,
    silent: push !== null,
    seen: (cursor) => {
      seenCursor = cursor;
    },
    wait:
      push === null
        ? opts.wait
        : (maxMs) =>
            // Racing the refusal is what makes it noticed during the
            // quiet phase, where `shouldStop` can then act on it,
            // instead of whenever the next batch happens to land.
            Promise.race([
              (
                opts.wait ??
                ((ms: number) =>
                  opts.clock.sleep(Math.min(opts.intervalSec * 1000, ms)))
              )(maxMs),
              push.whenRejected,
            ]),
    afterItems: async (items, cursor) => {
      if (push !== null) await push.send(items, rangeStart, cursor);
      rangeStart = cursor;
      seenCursor = cursor;
      return push?.rejected ? "stop" : "continue";
    },
    shouldStop: push === null ? undefined : () => push.rejected !== null,
    finish: () => {
      if (push === null) return;
      const held = push.unconfirmed();
      // The one moment uds mode writes to stdout. Whatever ended the
      // watch — a refusal, a fatal error — the background task's own
      // completion notice carries this over, which is the behaviour from
      // before this flag: print and exit, only with the accumulated
      // batches. The position goes out even with nothing held, so a
      // restart has a `--since` to resume from.
      opts.emit(held.items, held.since, held.cursor ?? seenCursor);
      const why = push.rejected;
      if (why !== null) {
        opts.note(
          `--follow=uds stopped: push ${why.status} ` +
            `(${REJECTION_HINT[why.status] ?? "the receiving session did not take it"})` +
            `${why.reason === undefined ? "" : ` — ${why.reason}`}`,
        );
      }
      push.close();
    },
  };
}
