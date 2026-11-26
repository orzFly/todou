import { createContext, type RefObject, useContext } from "react";

/**
 * The app shell's `<header>`, for the pages under it: their scroll insets
 * count it, and their sticky layers stack beneath it. Outside the shell (a
 * test rendering one page) it is `null`, which reads as no header at all.
 */
export const ShellHeaderContext = createContext<RefObject<HTMLElement | null>>({
  current: null,
});

export function useShellHeader(): RefObject<HTMLElement | null> {
  return useContext(ShellHeaderContext);
}
