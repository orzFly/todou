import type { ChangeStream, TodouClient } from "@todou/shared";
import type { Clock } from "./clock.ts";
import { isTransientError } from "./watch-loop.ts";

/**
 * A stream that has said nothing for three heartbeats (the server pings
 * every 30s) is not idle, it is dead: a proxy can hold the client side of
 * a connection open long after the upstream went away. Same bound, same
 * reason, as the web client's STALL_TIMEOUT_MS.
 */
const STALL_MS = 90_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export type ChangeNudges = {
  /**
   * Waits up to `maxMs`, returning as soon as the feed says something in
   * the watch set changed. Falls back to `intervalSec` pacing whenever the
   * feed is not carrying us, so a caller is never blind for longer than a
   * poll would have been.
   */
  wait: (maxMs: number) => Promise<void>;
  close: () => void;
};

/**
 * The SSE half of `todou watch` (T-123): a subscription to the user-level
 * change feed (T-122), reduced to the single bit the watch loop needs —
 * "there may be something to pull".
 *
 * The pointer is deliberately all it is. Events carry no timeline data and
 * arrive with no delivery guarantee, so the loop keeps draining `/activity`
 * from its cursor exactly as it did while polling; the cursor stays the
 * durable primitive and the feed only decides *when* to drain. A dropped
 * event costs latency, never an entry. That also means the self-filter
 * (T-121) is untouched by any of this: what counts as "not mine" is still
 * decided by the drain's query, which the feed cannot reach.
 *
 * Opening is best-effort. A server with no such endpoint — anything that
 * fails in a way REST would call permanent — is abandoned on the spot and
 * the watch polls exactly as before, without a word to the user.
 */
export async function openChangeNudges(opts: {
  client: TodouClient;
  /** Slugs whose events count; null = every project the token can read. */
  projects: Set<string> | null;
  /**
   * Narrows the feed to one card, for the watches that drain one card
   * (T-208). An event carrying no issue number — a project-level action —
   * still wakes the caller: one drain that finds nothing is cheaper than a
   * missed wake-up, and only events that name a *different* card are known
   * to be irrelevant.
   */
  issue?: number;
  /** Poll cadence to fall back on while the feed is down. */
  intervalSec: number;
  clock: Clock;
  /** Test seam for reconnect jitter. */
  random?: () => number;
}): Promise<ChangeNudges> {
  const { client, projects, clock } = opts;
  const random = opts.random ?? Math.random;

  let stream: ChangeStream | null = null;
  let latched = false;
  let wake: (() => void) | null = null;
  let lastAlive = clock.now();
  let failures = 0;
  /** Instant before which re-opening is pointless; see backOff. */
  let retryAt = 0;
  /** This server has no feed to give us: poll, and stop asking. */
  let abandoned = false;
  let disposed = false;

  const backOff = () => {
    failures += 1;
    const cap = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** (failures - 1),
    );
    retryAt = clock.now() + cap / 2 + random() * (cap / 2);
  };

  const onAlive = () => {
    lastAlive = clock.now();
    // Bytes on the wire are the only proof the feed works, so the backoff
    // resets here rather than on a connect that might drop right after.
    failures = 0;
  };

  const nudge = () => {
    latched = true;
    wake?.();
  };

  const tryConnect = async () => {
    try {
      const opened = await client.openChangeStream({
        onAlive,
        onEvent: (event) => {
          if (projects !== null && !projects.has(event.project)) return;
          if (
            opts.issue !== undefined &&
            event.issue_number !== undefined &&
            event.issue_number !== opts.issue
          ) {
            return;
          }
          nudge();
        },
      });
      if (disposed) {
        opened.close();
        return;
      }
      stream = opened;
      lastAlive = clock.now();
      void opened.closed.then(() => {
        if (stream !== opened) return; // already replaced or closed by us
        stream = null;
        backOff();
        // Whatever the drop swallowed is behind the cursor, not lost, so
        // the recovery is simply to pull once before waiting again.
        nudge();
      });
    } catch (error) {
      // Permanent by REST's own yardstick (404 on a server predating
      // T-122, 401/403, a 2xx that is not a stream) — retrying it would
      // only burn requests for the rest of a twelve-hour watch.
      if (!isTransientError(error)) abandoned = true;
      else backOff();
    }
  };

  await tryConnect();

  return {
    wait: async (maxMs: number): Promise<void> => {
      // Consuming the latch here can never drop an event: it means no more
      // than "drain now", and every caller drains the instant this
      // returns — including for an event that lands mid-drain, which the
      // drain's own request will already have covered.
      if (latched) {
        latched = false;
        return;
      }
      if (
        stream === null &&
        !abandoned &&
        !disposed &&
        clock.now() >= retryAt
      ) {
        await tryConnect();
        if (latched) {
          latched = false;
          return;
        }
      }
      // While the feed is down this is plain polling. While it is up a
      // timed drain still happens, because a stream can die without
      // saying so — just a rare one: whichever of the stall bound and
      // --interval asks the server less often. Someone who asked to poll
      // every five minutes wanted the server left alone, and gaining a
      // push transport is no reason to start knocking more.
      const idleMs =
        stream === null
          ? opts.intervalSec * 1000
          : Math.max(opts.intervalSec * 1000, STALL_MS);
      const ms = Math.min(maxMs, idleMs);
      if (ms > 0) {
        const abort = new AbortController();
        await Promise.race([
          new Promise<void>((resolve) => {
            wake = resolve;
          }),
          clock.sleep(ms, abort.signal),
        ]);
        wake = null;
        abort.abort();
      }
      latched = false;
      if (stream !== null && clock.now() - lastAlive >= STALL_MS) {
        stream.close();
        stream = null;
        retryAt = 0; // a stall is not a failure to back off from
      }
    },
    close: () => {
      disposed = true;
      stream?.close();
      stream = null;
      wake?.();
    },
  };
}
