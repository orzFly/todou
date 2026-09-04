import { useEffect, useRef } from "react";

/** Where `/` must not steal the keystroke: the reader is already typing. */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

/**
 * `/` reaches the project's search from anywhere on the page.
 *
 * Two callers answer the key differently — the box takes focus, the
 * collapsed toggle has to appear first — but the rule for when the key is
 * ours to take is the same for both, and this is the one place it is written.
 */
export function useSlashShortcut(onSlash: () => void): void {
  // The search box re-renders on every keystroke; the listener must not be
  // torn down and re-attached that often, so the callback goes in a ref.
  const slash = useRef(onSlash);
  useEffect(() => {
    slash.current = onSlash;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      slash.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
