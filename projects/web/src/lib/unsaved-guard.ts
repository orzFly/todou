import { useEffect, useRef } from "react";

export type NavigationLocation = {
  routeId: string;
  params: Record<string, unknown>;
};

export type NavigationContext = {
  current: NavigationLocation;
  next: NavigationLocation;
};

/** Answers "does this surface hold work that leaving would destroy?" */
export type DirtySource = () => boolean;

/**
 * True when this source remains available after the proposed in-app
 * navigation. Document unloads intentionally have no context and therefore
 * never use this escape hatch.
 */
export type DirtySourceSurvival = (navigation: NavigationContext) => boolean;

type RegisteredDirtySource = {
  isDirty: DirtySource;
  survives?: DirtySourceSurvival;
};

const sources = new Set<RegisteredDirtySource>();

/**
 * Registers a predicate, not a flag: the only reader is the guard, and it
 * reads once — at `beforeunload`, and again before a navigation commits — so
 * nothing has to re-render on the way from clean to dirty. Returns the
 * unregister.
 */
export function registerDirtySource(
  source: DirtySource,
  survives?: DirtySourceSurvival,
): () => void {
  const registered = { isDirty: source, survives };
  sources.add(registered);
  return () => {
    sources.delete(registered);
  };
}

/** True when any registered surface would lose unsaved work. */
export function hasUnsavedWork(navigation?: NavigationContext): boolean {
  for (const source of sources) {
    if (
      source.isDirty() &&
      (navigation === undefined || source.survives?.(navigation) !== true)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Registers `isDirty` for the calling component's lifetime. The predicate
 * rides in a ref so the effect below keeps an empty dependency list: a
 * subscription that changed identity every render would tear itself down and
 * rebuild on each keystroke.
 */
export function useDirtySource(
  isDirty: () => boolean,
  survives?: DirtySourceSurvival,
): void {
  const current = useRef({ isDirty, survives });
  current.current = { isDirty, survives };
  useEffect(
    () =>
      registerDirtySource(
        () => current.current.isDirty(),
        (navigation) => current.current.survives?.(navigation) === true,
      ),
    [],
  );
}
