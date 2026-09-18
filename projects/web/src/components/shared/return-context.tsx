import { useRouter, useRouterState } from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import type { ReturnLane, ReturnView, ScrollArea } from "@/lib/return-view.ts";
import {
  type ReturnLinkState,
  readCurrentReturnEntry,
} from "@/lib/return-view-history.ts";

/**
 * Who is going to be returned where (T-407).
 *
 * One provider covers the whole authenticated app because the two halves of
 * the question sit on opposite sides of the routed page: a collection page
 * *offers* an origin, and the header's own search box — which is chrome, not
 * page — *consumes* one. A provider wrapped around `<Outlet/>` would leave the
 * search box passing no origin at all, and a card opened from it would come
 * back to the project default while the identical card opened from a row in
 * the list behind it came back to the list.
 */

type CollectionRegistration = {
  /** The page's current view, already sampled — cheap to call per click. */
  read: () => ReturnView;
};

/**
 * The lanes and regions a page is made of, gathered from wherever they
 * actually live. A grouped list's pages belong to each group component and a
 * board column's scroll offset to each column, so the page above them cannot
 * describe either; they register instead.
 *
 * Registration happens during render, not in an effect. It has to: the
 * restore driver runs in an effect, and a registry filled one render later
 * would have the driver deciding what is still owed from the shape the page
 * had before this render. Writing the same key with the same value twice — as
 * Strict Mode's double render does — changes nothing, so the write is safe to
 * repeat.
 */
type Registry = {
  lanes: Map<string, ReturnLane>;
  areas: Map<string, ScrollArea>;
  /**
   * Bumped whenever a registration's contents change. A restore asks a lane
   * for one page and then has to notice that it arrived — but the lane belongs
   * to a child (a status group, a board column) whose commit re-renders
   * nothing above it. This is the signal that crosses that gap; without it the
   * replay asks for page two and waits forever.
   */
  version: number;
  listeners: Set<() => void>;
  /**
   * Retire the page's restore. Lives here rather than being returned to the
   * page alone because the actions that mean "the reader has taken over" —
   * a Load more of their own, a tab — happen inside the same components that
   * register the lanes, not in the page above them.
   */
  cancel: () => void;
};

type ReturnContextValue = {
  viewerId: number | undefined;
  registry: Registry;
  /**
   * The collection page on screen, if this is one. A ref rather than state:
   * the registration changes as the reader scrolls, and a context value that
   * re-rendered every subscriber on a scroll frame would re-render every row
   * of the list being scrolled.
   */
  collection: RefObject<CollectionRegistration | null>;
  /** The frozen origin this *detail* entry arrived with, if any. */
  inherited: ReturnView | undefined;
};

const ReturnContext = createContext<ReturnContextValue | null>(null);

export function ReturnViewProvider({
  viewerId,
  children,
}: {
  viewerId: number | undefined;
  children: ReactNode;
}) {
  const router = useRouter();
  const collection = useRef<CollectionRegistration | null>(null);
  const registry = useRef<Registry>({
    lanes: new Map(),
    areas: new Map(),
    cancel: () => undefined,
    version: 0,
    listeners: new Set(),
  });
  // Subscribed to the entry INDEX, not to the state object. Every scroll-idle
  // write replaces the current entry's state, and a subscriber on the state
  // itself would re-render the whole shell — header, chrome and page — once
  // per pause in a scroll. The index changes only when the reader actually
  // moves between entries, which is exactly when a different origin applies.
  const entryIndex = useRouterState({
    select: (state) => state.location.state.__TSR_index,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies(entryIndex): the read's trigger, not one of its inputs — it names which entry `router.history` is standing on, which the history object cannot report reactively. Without it a detail page would keep showing whichever entry's origin was current when this provider first rendered.
  const inherited = useMemo(
    () => readCurrentReturnEntry(router, viewerId).origin,
    [router, viewerId, entryIndex],
  );
  const value = useMemo(
    () => ({ viewerId, collection, inherited, registry: registry.current }),
    [viewerId, inherited],
  );
  return (
    <ReturnContext.Provider value={value}>{children}</ReturnContext.Provider>
  );
}

function useReturnContext(): ReturnContextValue | null {
  return useContext(ReturnContext);
}

/** The viewer a snapshot must belong to, or `undefined` before the account lands. */
export function useReturnViewer(): number | undefined {
  return useReturnContext()?.viewerId;
}

/**
 * Register this page as the collection a detail link should return to. Only
 * one page is ever on screen, so the last registration wins and the unmount
 * clears it — a stale reader left behind would hand the next page's links an
 * origin describing a list nobody is looking at.
 */
export function useRegisterReturnCollection(read: () => ReturnView): void {
  const context = useReturnContext();
  const latest = useRef(read);
  latest.current = read;
  const collection = context?.collection;
  useEffect(() => {
    if (collection === undefined) return;
    const registration = { read: () => latest.current() };
    collection.current = registration;
    return () => {
      // Only if still ours: under React's mount/unmount ordering the next
      // page can register before this cleanup runs.
      if (collection.current === registration) collection.current = null;
    };
  }, [collection]);
}

/**
 * Declare one pagination lane of the collection on screen. The name is the
 * lane's identity in a snapshot: `flat` for an ungrouped body, `status:<id>`
 * per group, so two groups read to different depths come back to different
 * depths and a renamed status changes nothing.
 */
export function useRegisterReturnLane(lane: ReturnLane | null): void {
  const context = useReturnContext();
  const registry = context?.registry;
  const name = lane?.lane;
  if (registry !== undefined && lane !== null) {
    registry.lanes.set(lane.lane, lane);
  }
  // Announced after the commit, not during the render that wrote it: telling
  // the page above to advance while this one is still rendering is exactly the
  // update React refuses.
  // biome-ignore lint/correctness/useExhaustiveDependencies(lane?.loaded): what the announcement is FOR — the values the page reads out of the registry, which the effect body reaches through the registry rather than through a closure.
  // biome-ignore lint/correctness/useExhaustiveDependencies(lane?.canLoadMore): as above.
  // biome-ignore lint/correctness/useExhaustiveDependencies(lane?.exhausted): as above.
  useEffect(() => {
    if (registry === undefined) return;
    announce(registry);
  }, [registry, lane?.loaded, lane?.canLoadMore, lane?.exhausted]);
  useEffect(() => {
    if (registry === undefined || name === undefined) return;
    return () => {
      registry.lanes.delete(name);
      announce(registry);
    };
  }, [registry, name]);
}

function announce(registry: Registry): void {
  registry.version += 1;
  for (const listener of registry.listeners) listener();
}

/** Declare one scrolling region of the collection on screen. */
export function useRegisterReturnArea(area: ScrollArea | null): void {
  const context = useReturnContext();
  const registry = context?.registry;
  const name = area?.region;
  if (registry !== undefined && area !== null) {
    registry.areas.set(area.region, area);
  }
  useEffect(() => {
    if (registry === undefined || name === undefined) return;
    announce(registry);
    return () => {
      registry.areas.delete(name);
      announce(registry);
    };
  }, [registry, name]);
}

/**
 * Run `onChange` whenever any registration changes.
 *
 * A restore asks a lane for one page and then has to notice that it arrived,
 * but the lane belongs to a child — a status group, a board column — whose
 * commit re-renders nothing above it. Going through React state would cost
 * two more renders per page; this is the direct line, and the callback reads
 * the registry it was told about rather than anything a render captured.
 */
export function useReturnRegistryChanges(onChange: () => void): void {
  const registry = useReturnContext()?.registry;
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    if (registry === undefined) return;
    const listener = () => latest.current();
    registry.listeners.add(listener);
    return () => {
      registry.listeners.delete(listener);
    };
  }, [registry]);
}

/** Everything registered right now, for the page's own capture and restore. */
export function useReturnRegistry(): Registry | undefined {
  return useReturnContext()?.registry;
}

/**
 * Give up on restoring this page. For the gestures that say the reader has
 * taken the view over deliberately: their own Load more, a tab, anything the
 * URL does not already describe. A filter or a group needs no call — those
 * change the page's target, which retires the restore on its own.
 */
export function useCancelReturnRestore(): () => void {
  const registry = useReturnContext()?.registry;
  const held = useRef(registry);
  held.current = registry;
  const cancel = useRef(() => held.current?.cancel());
  return cancel.current;
}

/**
 * What a link leaving for a detail page should freeze.
 *
 * On a collection page that is the page itself. On a detail page it is
 * whatever origin this entry arrived with, passed along unchanged: a card
 * reached from a card returns to the list both were opened from, not to the
 * card in between. Origins never nest, so no chain of cards can build a loop.
 */
export function useReturnOrigin(): ReturnView | undefined {
  const context = useReturnContext();
  return context?.collection.current?.read() ?? context?.inherited;
}

/**
 * The `state` for a link into a detail page, or `undefined` where there is no
 * origin to carry — an absent `state` is what keeps a card opened from
 * nowhere free of one.
 *
 * A function rather than a value, for two reasons. The router resolves it
 * when it builds the navigation, so the origin is read at the click rather
 * than at the render that drew the link — a list scrolled since then hands
 * over where the reader actually is. And its identity is stable, so drawing a
 * hundred rows does not hand a hundred links a hundred new props.
 *
 * It must stay free of side effects: the router also builds a location to
 * resolve every link's `href`, so this runs on renders, on preloads and on
 * clicks that are then cancelled.
 */
export function useReturnLinkState(): ReturnLinkState | undefined {
  const context = useReturnContext();
  const held = useRef<ReturnContextValue | null>(context);
  held.current = context;
  const updater = useRef<ReturnLinkState>((_previous: unknown) => {
    const value = held.current;
    const origin = value?.collection.current?.read() ?? value?.inherited;
    return { todouReturn: origin === undefined ? {} : { origin } };
  });
  // Decided at render, because whether an origin exists at all does not
  // change under the reader's feet: a collection page has one for as long as
  // it is mounted, and a detail entry's inherited origin is fixed when the
  // entry is created.
  const has =
    context !== null &&
    (context.collection.current !== null || context.inherited !== undefined);
  return has ? updater.current : undefined;
}

/** The `state` that hands a collection page its own view back to restore. */
export function restoreLinkState(view: ReturnView): ReturnLinkState {
  return () => ({ todouReturn: { pending: { view, locate: true } } });
}
