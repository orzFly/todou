import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { type Clock, systemClock } from "./clock.ts";
import { describeError } from "./watch-loop.ts";

/** Receipt statuses that mean the message did not reach the session. */
const NEGATIVE = new Set(["held", "refused", "denied", "dropped", "expired"]);

/** How long a pushed batch stays unconfirmed before it counts as landed. */
const RECEIPT_WINDOW_MS = 30_000;

/**
 * Consecutive `send` failures tolerated before giving up. Bounded because
 * every failure leaves its batch in the pending queue, and a queue that
 * grows for the length of a twelve-hour watch is its own problem.
 */
const MAX_FAILURES = 3;

/** Why the push channel is unusable: a receipt status, or `unreachable`. */
export type Rejection = { status: string; reason?: string };

/** One push's worth of entries and the cursor range they cover. */
type Batch<T> = {
  items: T[];
  since: string | undefined;
  cursor: string | undefined;
};

export type PeerPush<T> = {
  /**
   * Renders and writes one push, then returns — it does not wait out the
   * receipt window. `since` is where this batch starts, `cursor` where it
   * ends; a batch merged with earlier unsent ones keeps the oldest `since`,
   * so the range still abuts the last successful push. Never throws: a
   * failed write leaves the batch queued and shows up in `rejected` or in
   * `unconfirmed()`, both of which the caller reads anyway.
   */
  send(
    items: T[],
    since: string | undefined,
    cursor: string | undefined,
  ): Promise<void>;
  /** Set once the channel is known unusable; the caller then degrades. */
  readonly rejected: Rejection | null;
  /** Everything not known to have landed: unsent plus still-in-window. */
  unconfirmed(): Batch<T>;
  /** Resolves when `rejected` is set, so a quiet phase can be cut short. */
  whenRejected: Promise<void>;
  close(): void;
};

/**
 * Wraps a push body in the envelope that lets the receiving session name its
 * sender. The receiver re-serializes the attributes it parsed and compares
 * the result byte for byte against what arrived, dropping the whole envelope
 * on any difference — so the attribute order, the single space between
 * attributes, and the newline on each side of the body are all load-bearing
 * rather than cosmetic.
 */
export function wrapEnvelope(opts: {
  from: string;
  fromName?: string;
  fromMode?: string;
  body: string;
}): string {
  const attrs = [
    `from="${opts.from}"`,
    ...(opts.fromName === undefined ? [] : [`from-name="${opts.fromName}"`]),
    ...(opts.fromMode === undefined ? [] : [`from-mode="${opts.fromMode}"`]),
  ];
  return `<cross-session-message ${attrs.join(" ")}>\n${opts.body}\n</cross-session-message>`;
}

export type PeerPushOptions<T> = {
  /** The target session's socket, from CLAUDE_CODE_MESSAGING_SOCKET. */
  target: string;
  /** One push body from a batch and the cursor range it covers. */
  render: (
    items: T[],
    since: string | undefined,
    cursor: string | undefined,
  ) => string;
  /** Display label on the receiving side; never part of its admission check. */
  fromName: string;
  /** Attested permission mode, where it can be read without guessing. */
  fromMode?: "bypass" | "prompting";
  clock?: Clock;
  receiptWindowMs?: number;
  /** Test seam; production leaves it unset and a real socket is dialled. */
  dial?: (target: string, line: string) => Promise<void>;
};

/**
 * The cross-session push transport behind `watch --follow=uds` (T-252): one
 * message per batch to the Claude Code session that started this process,
 * plus the listener its receipts come back on.
 *
 * Three wire details were measured rather than documented, and each fails
 * silently when written differently: `from` must be a `uds:` URI holding an
 * absolute `.sock` path or no receipt is sent at all; `msg_id` must be a
 * UUID, because a custom format still delivers but comes back with no
 * `orig_msg_id` to correlate; and receipts arrive on a connection the
 * receiver opens, so the listener stays up for the whole watch.
 *
 * Success is the absence of bad news. A session set to `accept` delivers
 * straight through and sends no `delivered` receipt, so the verdict can only
 * be "nothing negative arrived inside the window" — which is why `send`
 * returns immediately and the window is a confidence interval rather than a
 * wait. Blocking on it would charge every silent success 30 seconds, and
 * saving that wait is the whole point of pushing.
 */
export async function openPeerPush<T>(
  opts: PeerPushOptions<T>,
): Promise<PeerPush<T>> {
  const clock = opts.clock ?? systemClock;
  const receiptWindowMs = opts.receiptWindowMs ?? RECEIPT_WINDOW_MS;
  const dial = opts.dial ?? dialSocket;
  // Bound to the *target's* directory on purpose: a reply address in the
  // same directory only has to end in `.sock`, while any other permitted
  // directory also constrains the file name to a pid-derived shape.
  const self = join(dirname(opts.target), `todou-watch-${process.pid}.sock`);
  const from = `uds:${self}`;

  const outstanding: Array<Batch<T> & { msgId: string; expiresAt: number }> =
    [];
  /** The batch not yet known to have been written; merged into the next. */
  let awaiting: Batch<T> | null = null;
  let rejected: Rejection | null = null;
  let failures = 0;
  let closed = false;
  let announce: () => void = () => {};
  const whenRejected = new Promise<void>((resolve) => {
    announce = resolve;
  });

  const reject = (next: Rejection) => {
    if (rejected !== null) return;
    rejected = next;
    announce();
  };

  // Silence past the window is the only "delivered" this channel has, so a
  // receipt for an already-pruned batch is late news about a success.
  const prune = () => {
    const now = clock.now();
    while ((outstanding[0]?.expiresAt ?? Number.POSITIVE_INFINITY) <= now) {
      outstanding.shift();
    }
  };

  const receipt = (line: string) => {
    if (line.trim() === "") return;
    let frame: {
      type?: unknown;
      action?: unknown;
      status?: unknown;
      reason?: unknown;
      orig_msg_id?: unknown;
    };
    try {
      frame = JSON.parse(line);
    } catch {
      return; // A foreign or half-written frame is not our business.
    }
    if (frame.type !== "control" || frame.action !== "peer_message_status") {
      return;
    }
    if (typeof frame.status !== "string" || !NEGATIVE.has(frame.status)) return;
    prune();
    if (!outstanding.some((batch) => batch.msgId === frame.orig_msg_id)) return;
    reject({
      status: frame.status,
      ...(typeof frame.reason === "string" ? { reason: frame.reason } : {}),
    });
  };

  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (
        let nl = buffer.indexOf("\n");
        nl !== -1;
        nl = buffer.indexOf("\n")
      ) {
        receipt(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    // A peer that writes its receipt and hangs up may never send the
    // newline, so the last buffered fragment is a whole line after `end`.
    socket.on("end", () => {
      receipt(buffer);
      buffer = "";
    });
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });

  // A crash leaves the socket node behind and bind would fail EADDRINUSE.
  rmSync(self, { force: true });
  await new Promise<void>((resolve, reject_) => {
    server.once("error", reject_);
    server.listen(self, () => {
      server.removeListener("error", reject_);
      // Nothing to do about a later listener error, and an unhandled one
      // would take the whole watch down with it.
      server.on("error", () => {});
      resolve();
    });
  });

  return {
    send: async (items, since, cursor) => {
      const batch: Batch<T> =
        awaiting === null
          ? { items: [...items], since, cursor }
          : {
              items: [...awaiting.items, ...items],
              since: awaiting.since,
              cursor,
            };
      awaiting = batch;
      const msgId = randomUUID();
      const content = wrapEnvelope({
        from,
        fromName: opts.fromName,
        fromMode: opts.fromMode,
        body: opts.render(batch.items, batch.since, batch.cursor),
      });
      const frame = JSON.stringify({
        type: "user",
        // Queued rather than interrupting: a batch of tracker activity is
        // news the agent should see next, not mid-turn.
        priority: "next",
        from,
        msg_id: msgId,
        message: { role: "user", content },
      });
      try {
        await dial(opts.target, `${frame}\n`);
      } catch (error) {
        failures += 1;
        const code = (error as NodeJS.ErrnoException).code;
        // The socket being gone means the session is gone: there is no
        // recipient to queue for, however many times we try.
        if (
          code === "ENOENT" ||
          code === "ECONNREFUSED" ||
          failures >= MAX_FAILURES
        ) {
          reject({ status: "unreachable", reason: describeError(error) });
        }
        return;
      }
      failures = 0;
      awaiting = null;
      outstanding.push({
        ...batch,
        msgId,
        expiresAt: clock.now() + receiptWindowMs,
      });
    },
    get rejected() {
      return rejected;
    },
    unconfirmed: () => {
      prune();
      const batches = [
        ...outstanding,
        ...(awaiting === null ? [] : [awaiting]),
      ];
      return {
        items: batches.flatMap((batch) => batch.items),
        since: batches[0]?.since,
        cursor: batches.at(-1)?.cursor,
      };
    },
    whenRejected,
    close: () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.close();
      rmSync(self, { force: true });
    },
  };
}

/** One frame per connection, write end shut so the peer sees its length. */
function dialSocket(target: string, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(target);
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.on("error", settle);
    socket.on("connect", () => socket.end(line, () => settle()));
  });
}
