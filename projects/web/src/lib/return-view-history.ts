import type { HistoryState, RouterHistory } from "@tanstack/react-router";
import {
  type PendingRestore,
  parseReturnView,
  type ReturnView,
} from "@/lib/return-view.ts";

/**
 * Where a return snapshot lives: one namespaced key inside the browser
 * history entry the reader is standing on (T-407).
 *
 * History state rather than the URL, a store, or a module variable, because
 * each alternative fails a case the card names. The URL would follow a copied
 * permalink to somebody who was never on that list. A store keyed by project
 * or card would let two tabs — or two entries for the same address — overwrite
 * each other. A module variable would not survive the reader pressing reload
 * on the card they are reading.
 */

/** The one key this feature owns. Everything else in the entry is somebody else's. */
const NAMESPACE = "todouReturn";

export type ReturnEntry = {
  /** A collection entry's own view, still being updated as the reader reads. */
  view?: ReturnView;
  /** A collection entry whose restore has not finished. */
  pending?: PendingRestore;
  /** A detail entry's frozen origin, which no later scroll may rewrite. */
  origin?: ReturnView;
};

/**
 * What a link hands the router as its `state`.
 *
 * The shape is what it is because of where `HistoryState` is declared.
 * Applications are meant to add their own fields to it by augmenting
 * `@tanstack/history`, which this package does not depend on — and without an
 * augmentation it is an interface with no members, so TypeScript's weak-type
 * rule rejects anything with a field of its own as having "no properties in
 * common". Intersecting it back in is what makes the value assignable without
 * declaring a second copy of the router's own history just to win a type.
 *
 * A function rather than a value so the router resolves it when it builds the
 * navigation: a link drawn before the reader scrolled still hands over where
 * they ended up.
 */
export type ReturnLinkState = (
  previous: unknown,
) => HistoryState & { todouReturn: ReturnEntry };

/**
 * Entries whose write to the browser never landed, so a reader whose history
 * state is unavailable — quota, a hardened environment — still gets a working
 * back link for as long as the tab lives. Keyed by `__TSR_index`, the one
 * per-entry value `history.replace` preserves; `key` is re-minted on every
 * replace and would name a different slot each time.
 *
 * A reload empties this, which is the documented degradation: the snapshot is
 * gone, and the back link falls back to the project's default list rather
 * than to a lie.
 */
const sessionEntries = new Map<number, ReturnEntry>();

/**
 * The parts of the router this module touches. Spelled out rather than taking
 * the router whole, because one of them is `_scroll` — see `writeReturnEntry`.
 */
export type ReturnHost = {
  history: RouterHistory;
  _scroll: { next: boolean };
};

function indexOf(history: RouterHistory): number {
  return history.location.state.__TSR_index;
}

function rawEntry(state: unknown): Record<string, unknown> | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const held = (state as Record<string, unknown>)[NAMESPACE];
  if (typeof held !== "object" || held === null) return undefined;
  return held as Record<string, unknown>;
}

/**
 * Read this entry's snapshot for `viewerId`.
 *
 * `viewerId` is `undefined` while the account is still in flight, and that
 * case returns nothing rather than guessing: applying a snapshot before
 * knowing who is asking is how one account's filters end up on another's
 * screen. The caller re-reads once the account lands.
 */
export function readReturnEntry(
  state: unknown,
  viewerId: number | undefined,
  fallbackIndex?: number,
): ReturnEntry {
  if (viewerId === undefined) return {};
  const held =
    rawEntry(state) ??
    (fallbackIndex === undefined
      ? undefined
      : (sessionEntries.get(fallbackIndex) as
          | Record<string, unknown>
          | undefined));
  if (held === undefined) return {};
  const view = parseReturnView(held.view, viewerId);
  const origin = parseReturnView(held.origin, viewerId);
  const pendingHeld = held.pending;
  let pending: PendingRestore | undefined;
  if (typeof pendingHeld === "object" && pendingHeld !== null) {
    const raw = pendingHeld as Record<string, unknown>;
    const target = parseReturnView(raw.view, viewerId);
    if (target !== null)
      pending = { view: target, locate: raw.locate === true };
  }
  return {
    ...(view === null ? {} : { view }),
    ...(origin === null ? {} : { origin }),
    ...(pending === undefined ? {} : { pending }),
  };
}

/** This entry's snapshot, read straight off the router's current location. */
export function readCurrentReturnEntry(
  host: ReturnHost,
  viewerId: number | undefined,
): ReturnEntry {
  const { history } = host;
  return readReturnEntry(history.location.state, viewerId, indexOf(history));
}

/**
 * Rewrite this entry's snapshot in place, keeping every other field the
 * router and its plugins put there.
 *
 * Two flags on the call earn their keep. `ignoreBlocker` because this is an
 * annotation, not a navigation: without it a reader with an unsaved draft
 * would be asked to confirm leaving the page every time they stopped
 * scrolling (T-431 installed that blocker, and it answers PUSH *and* REPLACE
 * — `@tanstack/history`, `tryNavigation`). The explicit `flush` because the
 * queued write is a microtask that `pagehide` does not wait for, and because
 * a synchronous native call is the only version whose failure this `catch`
 * can see.
 *
 * Returns whether the browser took it.
 */
export function writeReturnEntry(
  host: ReturnHost,
  entry: ReturnEntry,
): boolean {
  const { history } = host;
  const index = indexOf(history);
  const next = { ...history.location.state, [NAMESPACE]: entry };
  // The router treats every history event as a navigation and scrolls to the
  // top once the resulting render lands (`scroll-restoration.js`, the
  // `onRendered` subscriber, which reads `_scroll.next` and defaults it to
  // true). A real navigation sets that flag through `commitLocation`; this is
  // not one, so it has to say so itself — without this line the page jumps to
  // the top every time the reader stops scrolling, which is exactly when a
  // snapshot is written. The flag heals itself: the subscriber restores it,
  // and any real navigation sets it before its own render.
  host._scroll.next = false;
  try {
    history.replace(history.location.href, next, { ignoreBlocker: true });
    history.flush();
    sessionEntries.delete(index);
    return true;
  } catch {
    sessionEntries.set(index, entry);
    return false;
  }
}

/** Update this entry's snapshot from what it already holds. */
export function updateReturnEntry(
  host: ReturnHost,
  viewerId: number | undefined,
  update: (previous: ReturnEntry) => ReturnEntry,
): boolean {
  return writeReturnEntry(host, update(readCurrentReturnEntry(host, viewerId)));
}

/**
 * Drop the in-memory half at logout. The entries already written into the
 * browser's history cannot be reached to be rewritten — which is why every
 * read re-checks `userId` against whoever is asking now.
 */
export function clearReturnMemory(): void {
  sessionEntries.clear();
}
