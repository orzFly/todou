import { useEffect, useRef } from "react";

/** Answers "does this surface hold work that leaving would destroy?" */
export type DirtySource = () => boolean;

const sources = new Set<DirtySource>();

/**
 * Registers a predicate, not a flag: the only reader is the guard, and it
 * reads once — at `beforeunload`, and again before a navigation commits — so
 * nothing has to re-render on the way from clean to dirty. Returns the
 * unregister.
 */
export function registerDirtySource(source: DirtySource): () => void {
  sources.add(source);
  return () => {
    sources.delete(source);
  };
}

/** True when any registered surface holds unsaved work. */
export function hasUnsavedWork(): boolean {
  for (const source of sources) {
    if (source()) return true;
  }
  return false;
}

/**
 * Registers `isDirty` for the calling component's lifetime. The predicate
 * rides in a ref so the effect below keeps an empty dependency list: a
 * subscription that changed identity every render would tear itself down and
 * rebuild on each keystroke.
 */
export function useDirtySource(isDirty: () => boolean): void {
  const predicate = useRef(isDirty);
  predicate.current = isDirty;
  useEffect(() => registerDirtySource(() => predicate.current()), []);
}
