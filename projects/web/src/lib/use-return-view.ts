import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRegisterReturnCollection,
  useReturnRegistry,
  useReturnRegistryChanges,
  useReturnViewer,
} from "@/components/shared/return-context.tsx";
import {
  extraPagesOf,
  type InboxTab,
  locateRegion,
  type PagedRange,
  RETURN_VIEW_VERSION,
  type ReturnTarget,
  type ReturnView,
  regionOf,
  type ScrollArea,
  type ScrollCandidate,
  type ScrollRegion,
} from "@/lib/return-view.ts";
import {
  readCurrentReturnEntry,
  updateReturnEntry,
} from "@/lib/return-view-history.ts";

/**
 * The half of T-407 that touches the DOM: sampling what a collection page
 * looks like, and putting it back.
 *
 * A page describes itself — its address, its pagination lanes, its scrolling
 * regions — and this hook owns everything that is the same on all five of
 * them: when a snapshot is written, which events retire a restore, and the
 * order the three restore steps run in. Five copies of that order would be
 * five chances to get "locate before the rows exist" wrong.
 */

export type ReturnCollection = {
  /** Where this page is, rebuilt from the URL on every render. */
  target: ReturnTarget;
  /** Inbox tab to include in a detail page's return URL. */
  tab?: InboxTab;
  /** Who a user page is about, for the back link's accessible name. */
  userLabel?: string;
  /** Whether the page's own rows are on screen and measurable. */
  ready: boolean;
};

/** How long after the last scroll event the entry is rewritten. */
const SCROLL_IDLE_MS = 150;
/** How many following rows are remembered as stand-ins for the anchor. */
const CANDIDATE_LIMIT = 12;
/** How many frames a restore waits for its rows to arrive and be sized. */
const LAYOUT_ATTEMPTS = 40;

let snapshotCounter = 0;

function leading(rect: DOMRect, axis: "x" | "y"): number {
  return axis === "x" ? rect.left : rect.top;
}

function scrollOf(element: HTMLElement | null): { x: number; y: number } {
  if (element === null) return { x: window.scrollX, y: window.scrollY };
  return { x: element.scrollLeft, y: element.scrollTop };
}

/** Where the region's visible content starts, in viewport coordinates. */
function originOf(area: ScrollArea, element: HTMLElement | null): number {
  const inset = area.inset?.() ?? 0;
  if (element === null) return inset;
  return leading(element.getBoundingClientRect(), area.axis ?? "y") + inset;
}

function sampleArea(area: ScrollArea): ScrollRegion {
  const axis = area.axis ?? "y";
  const element = area.element();
  const { x, y } = scrollOf(element);
  const start = originOf(area, element);
  const candidates: ScrollCandidate[] = [];
  for (const row of area.rows()) {
    const at = leading(row.element.getBoundingClientRect(), axis);
    // Rows above the visible edge are behind the chrome: they are not where
    // the reader was, and using one as the anchor would scroll the page to
    // put a hidden row back under the header.
    if (at < start) continue;
    candidates.push({ id: row.id, offset: at - start });
    if (candidates.length >= CANDIDATE_LIMIT) break;
  }
  return {
    region: area.region,
    x: Math.max(x, 0),
    y: Math.max(y, 0),
    candidates,
  };
}

function maxScrollOf(element: HTMLElement | null, axis: "x" | "y"): number {
  if (element === null) {
    const root = document.documentElement;
    return axis === "x"
      ? root.scrollWidth - window.innerWidth
      : root.scrollHeight - window.innerHeight;
  }
  return axis === "x"
    ? element.scrollWidth - element.clientWidth
    : element.scrollHeight - element.clientHeight;
}

/**
 * Put one region back, and say whether it could be.
 *
 * `false` means the page is not there yet rather than that the position was
 * refused: a region with nowhere to scroll AND no rows in it, for a snapshot
 * that remembered both, is a column whose cards have not arrived — and
 * writing 0 into it is the failure the card names, a position "restored" onto
 * a skeleton. A region that has its rows and still cannot scroll is simply
 * shorter than it was, and the clamp below is the right answer for it.
 */
function applyArea(
  area: ScrollArea,
  remembered: ScrollRegion,
  /** Stop waiting: place whatever the region can hold, even if that is 0. */
  force = false,
): boolean {
  const axis = area.axis ?? "y";
  const element = area.element();
  const wanted = axis === "x" ? remembered.x : remembered.y;
  const maxScroll = maxScrollOf(element, axis);
  const rows = new Map(area.rows().map((row) => [row.id, row] as const));
  if (
    !force &&
    maxScroll <= 0 &&
    rows.size === 0 &&
    (remembered.candidates.length > 0 || wanted > 0)
  ) {
    return false;
  }
  const start = originOf(area, element);
  const current = scrollOf(element);
  const here = axis === "x" ? current.x : current.y;
  const to = locateRegion(
    { y: wanted, candidates: remembered.candidates },
    (id) => {
      const row = rows.get(id);
      if (row === undefined) return undefined;
      // Back into the region's own scroll coordinates: where this row would
      // sit if the region were scrolled to its origin.
      return leading(row.element.getBoundingClientRect(), axis) - start + here;
    },
    maxScroll,
  );
  if (element === null) {
    window.scrollTo(axis === "x" ? { left: to } : { top: to });
    return true;
  }
  if (axis === "x") element.scrollLeft = to;
  else element.scrollTop = to;
  return true;
}

function sameTarget(a: ReturnTarget, b: ReturnTarget): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Wire a collection page into return navigation: keep its history entry
 * describing what is on screen, and — arriving with a snapshot — put that
 * description back.
 */
export function useReturnView(collection: ReturnCollection): {
  /** A restore is still owed something. */
  restoring: boolean;
  /**
   * Retire the restore outright, for the actions that mean the reader has
   * taken over the view: a filter, a group, a tab, a Load more of their own.
   * Scrolling is deliberately NOT one of them — see `takeOver`.
   */
  cancel: () => void;
} {
  const router = useRouter();
  const viewerId = useReturnViewer();
  const registry = useReturnRegistry();
  const latest = useRef(collection);
  latest.current = collection;

  const snapshotId = useRef<string>("");
  if (snapshotId.current === "") {
    snapshotCounter += 1;
    snapshotId.current = `s${snapshotCounter}`;
  }

  /** The view as last sampled: what a link leaving right now would freeze. */
  const sampled = useRef<ReturnView | null>(null);
  /**
   * What the entry was last written with. Compared before every write, because
   * a write is not free: it notifies the router, which reloads the current
   * match. Without this, every click anywhere on a collection page — a status
   * menu, a label picker, a checkbox — would cost one, for a snapshot
   * identical to the one already there.
   */
  const persisted = useRef("");

  /**
   * Everything about the view that is not a measurement: the address, the
   * inbox tab, how deep each lane has been read. Cheap enough to redo on
   * every link, which it has to be — the reading position is only re-measured
   * when the reader scrolls or reaches for the page, but a tab they just
   * switched, or a search word they just typed, changes nothing the DOM would
   * report and everything about where they should come back to.
   */
  const describe = useCallback(
    (measured: ScrollRegion[]): ReturnView => {
      const page = latest.current;
      return {
        v: RETURN_VIEW_VERSION,
        userId: viewerId ?? 0,
        snapshotId: snapshotId.current,
        target: page.target,
        ...(page.tab === undefined ? {} : { tab: page.tab }),
        ...(page.userLabel === undefined ? {} : { userLabel: page.userLabel }),
        pages: [...(registry?.lanes.values() ?? [])].map(
          (lane): PagedRange => ({ lane: lane.lane, extraPages: lane.loaded }),
        ),
        scroll: measured,
      };
    },
    [viewerId, registry],
  );

  const sample = useCallback((): ReturnView => {
    const page = latest.current;
    const view = describe(
      page.ready ? [...(registry?.areas.values() ?? [])].map(sampleArea) : [],
    );
    sampled.current = view;
    return view;
  }, [describe, registry]);

  // What a link leaving right now freezes. The measurements are reused rather
  // than retaken, because the router builds a location for every link on the
  // page on every render — measuring per row per render would make a long
  // list unscrollable for the sake of a click that may never come.
  useRegisterReturnCollection(
    useCallback(() => describe(sampled.current?.scroll ?? []), [describe]),
  );

  const [pending, setPending] = useState<{
    view: ReturnView;
    locate: boolean;
    /**
     * Invalidated wholesale by a filter, group or tab change. A late page
     * from an earlier generation must not be counted towards a target the
     * reader has already left behind.
     */
    generation: number;
  } | null>(null);
  const generation = useRef(0);
  /**
   * The same value, set synchronously. The effect that writes the entry runs
   * in the commit the restore target was read in, when `pending` is still the
   * state from the render before — and it would strip a target it has not
   * seen yet out of the entry it is meant to preserve.
   */
  const pendingNow = useRef<{ view: ReturnView; locate: boolean } | null>(null);
  /**
   * How deep each lane was when it was last asked for a page. A lane reports
   * itself loadable again the moment its request resolves, which is a render
   * or two before the page it brought is committed — and asking in that gap
   * fetches the same cursor twice. The reader's own Retry is what re-asks
   * after a failure, and that advances the lane.
   */
  const asked = useRef(new Map<string, number>());
  /**
   * A placement is already walking the frames. The step runs again on every
   * render and every registration change, and the walk can last many frames
   * while a column's cards arrive — without this it would start a second walk
   * over the same regions, and each would place them once.
   */
  const placing = useRef(false);

  const cancel = useCallback(() => {
    generation.current += 1;
    placing.current = false;
    pendingNow.current = null;
    asked.current.clear();
    setPending(null);
  }, []);
  if (registry !== undefined) registry.cancel = cancel;

  /**
   * The reader scrolled for themselves. That retires the *positioning* only:
   * they read far enough to load those pages once, so the pages still come —
   * but nothing may move the viewport out from under them afterwards.
   */
  const takeOver = useCallback(() => {
    if (pendingNow.current !== null) pendingNow.current.locate = false;
    setPending((value) =>
      value === null || !value.locate ? value : { ...value, locate: false },
    );
  }, []);

  // Restore targets arrive on an entry, so they are read when the reader
  // steps onto one: this mount, and every later BACK/FORWARD/GO. Deliberately
  // not a subscription to `location.state` — this hook rewrites that state on
  // every pause in a scroll, and a subscriber would re-read its own writes.
  useEffect(() => {
    const read = () => {
      const entry = readCurrentReturnEntry(router, viewerId);
      const view = entry.pending?.view ?? entry.view;
      if (view === undefined) return;
      if (!sameTarget(view.target, latest.current.target)) return;
      generation.current += 1;
      const locate = entry.pending?.locate ?? true;
      asked.current.clear();
      pendingNow.current = { view, locate };
      setPending({ view, locate, generation: generation.current });
    };
    read();
    return router.history.subscribe(({ action }) => {
      if (action.type === "PUSH" || action.type === "REPLACE") return;
      read();
    });
  }, [router, viewerId]);

  // Keep the entry describing this page. Sampling rides an animation frame;
  // only the pauses reach the browser's history, because each write notifies
  // the router and a write per scroll event would do so sixty times a second.
  useEffect(() => {
    let frame = 0;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const persist = () => {
      if (viewerId === undefined) return;
      const view = sampled.current;
      if (view === null) return;
      const serialised = JSON.stringify(view);
      if (serialised === persisted.current) return;
      persisted.current = serialised;
      updateReturnEntry(router, viewerId, (previous) => ({
        ...previous,
        view,
      }));
    };
    const onScroll = () => {
      if (frame === 0) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          sample();
        });
      }
      if (idle !== undefined) clearTimeout(idle);
      idle = setTimeout(persist, SCROLL_IDLE_MS);
    };
    // Before a click can become a navigation, so the entry the reader steps
    // back onto describes where they actually were even when they clicked
    // mid-scroll. Capture phase and passive: this must not be able to change
    // what the click then does.
    const onPointerDown = () => {
      sample();
      persist();
    };
    window.addEventListener("scroll", onScroll, {
      passive: true,
      capture: true,
    });
    window.addEventListener("pointerdown", onPointerDown, {
      passive: true,
      capture: true,
    });
    window.addEventListener("pagehide", persist);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      if (idle !== undefined) clearTimeout(idle);
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("pointerdown", onPointerDown, {
        capture: true,
      });
      window.removeEventListener("pagehide", persist);
    };
  }, [router, viewerId, sample]);

  // A gesture, not a scroll event: the restore's own `scrollTo` produces
  // scroll events too, and treating those as the reader taking over would
  // cancel every restore the moment it started working.
  useEffect(() => {
    if (pending === null || !pending.locate) return;
    const keys = new Set([
      "ArrowUp",
      "ArrowDown",
      "PageUp",
      "PageDown",
      "Home",
      "End",
      " ",
    ]);
    const onKey = (event: KeyboardEvent) => {
      if (keys.has(event.key)) takeOver();
    };
    window.addEventListener("wheel", takeOver, { passive: true });
    window.addEventListener("touchmove", takeOver, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("wheel", takeOver);
      window.removeEventListener("touchmove", takeOver);
      window.removeEventListener("keydown", onKey);
    };
  }, [pending, takeOver]);

  // The browser restores the window scroll of a popped entry on its own, and
  // keeps re-applying it as the document grows — which is precisely while the
  // replayed pages are arriving. Held off for the length of the restore only,
  // so pages this feature does not manage keep the browser's behaviour.
  useEffect(() => {
    if (pending === null) return;
    if (!("scrollRestoration" in window.history)) return;
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    return () => {
      window.history.scrollRestoration = previous;
    };
  }, [pending]);

  /**
   * One step of the restore, run whenever something it is waiting for might
   * have changed: a page committing in a child, a query answering, a render.
   * It reads refs rather than a render's values, because the thing that most
   * often moves it on — a replayed page landing in a lane a child owns —
   * re-renders nothing here.
   */
  const step = useRef<() => void>(() => undefined);
  step.current = () => {
    const owedTo = pendingNow.current;
    if (owedTo === null) return;
    if (!sameTarget(owedTo.view.target, latest.current.target)) {
      cancel();
      return;
    }
    const owed = [...(registry?.lanes.values() ?? [])].filter(
      (lane) => lane.loaded < extraPagesOf(owedTo.view, lane.lane),
    );
    // A lane with nothing left to give is finished rather than stuck: the rows
    // behind it are gone, and waiting for them would hold the restore open
    // forever. A lane that is merely busy — a request in flight, or a page
    // that failed and is waiting on the reader's Retry — is still owed, and
    // falling through here would throw away the record of what it owes.
    const waiting = owed.filter((lane) => !lane.exhausted);
    const reachable = waiting.filter(
      (lane) =>
        lane.canLoadMore && asked.current.get(lane.lane) !== lane.loaded,
    );
    if (reachable.length > 0) {
      for (const lane of reachable) {
        asked.current.set(lane.lane, lane.loaded);
        lane.loadMore();
      }
      return;
    }
    if (waiting.length > 0) return;
    if (!latest.current.ready) return;
    if (!owedTo.locate) {
      // Nothing left to position, and the pages are in: the entry now
      // describes the page as it stands rather than as it was asked to be.
      pendingNow.current = null;
      setPending(null);
      return;
    }
    // Positioned a frame at a time until the page can actually hold the
    // position: a board arriving with a warm cache reports itself ready on
    // the render that commits its columns, a frame or more before the cards
    // in them have any height, and a region with nothing to scroll would
    // take 0 for an answer. Bounded, so a page that never grows — every row
    // since deleted — settles at the top instead of retrying forever.
    if (placing.current) return;
    placing.current = true;
    const view = owedTo.view;
    let attempts = 0;
    const place = () => {
      attempts += 1;
      const unplaced: { area: ScrollArea; remembered: ScrollRegion }[] = [];
      for (const area of registry?.areas.values() ?? []) {
        const remembered = regionOf(view, area.region);
        if (remembered === undefined) continue;
        if (!applyArea(area, remembered)) unplaced.push({ area, remembered });
      }
      if (unplaced.length > 0 && attempts < LAYOUT_ATTEMPTS) {
        requestAnimationFrame(place);
        return;
      }
      // The rows never came. Place those regions anyway rather than leaving
      // them where they happened to be: with nothing to scroll the clamp
      // answers 0, which is where an emptied list belongs.
      for (const area of unplaced) applyArea(area.area, area.remembered, true);
      placing.current = false;
      pendingNow.current = null;
      setPending(null);
    };
    requestAnimationFrame(place);
  };

  useReturnRegistryChanges(useCallback(() => step.current(), []));
  // Also after every render of this page, which is what carries the first
  // step: on the render a snapshot is read, nothing has announced yet.
  useEffect(() => {
    step.current();
  });

  // What is still owed goes into the entry, so a reload lands back in the
  // middle of the restore rather than at the top of page one: the sampling
  // above keeps rewriting `view` with the half-built page underneath, and
  // only this record still knows what the reader actually asked for. With the
  // restore finished the entry stops advertising a target it no longer owes.
  // biome-ignore lint/correctness/useExhaustiveDependencies(pending): the trigger, not an input — the write reads `pendingNow`, which is the same value set a render earlier, and running only when the restore's state changes is what keeps this off the scroll path.
  useEffect(() => {
    // Not while the account is in flight. A snapshot belongs to a reader, so
    // one written before anyone is known could not be read back — and this
    // write would take the restore target out of the entry on the way past,
    // which is the shape the first browser run of T-407 failed in.
    if (viewerId === undefined) return;
    persisted.current = JSON.stringify(sample());
    const owed = pendingNow.current;
    updateReturnEntry(router, viewerId, (previous) => {
      const { pending: _retired, ...rest } = previous;
      return {
        ...rest,
        ...(sampled.current === null ? {} : { view: sampled.current }),
        ...(owed === null
          ? {}
          : { pending: { view: owed.view, locate: owed.locate } }),
      };
    });
  }, [pending, router, viewerId, sample]);

  return { restoring: pending !== null, cancel };
}
