import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";

/**
 * Which hidden runs this page has opened (T-281).
 *
 * One store for all four entries — the per-run `Reveal`, the section rule's
 * `Reveal all`, the floating bar's mirror of it, and a `#comment-<id>`
 * anchor landing inside a run. They are four doors into one mechanism, not
 * four mechanisms, and a second copy of this state is how they would come
 * to disagree about what is open.
 *
 * It lives above both the bar and the timeline because the bar is
 * `aria-hidden`: it may only mirror something the document still holds, so
 * the rule inside the timeline is the body and the bar reads the same state.
 *
 * Nothing here is written to the server. Revealing changes what this page
 * shows; putting a comment back for everyone is the crossed-out eye on the
 * comment itself, which is a write.
 */
type RevealedRuns = {
  isRevealed: (key: string) => boolean;
  reveal: (key: string) => void;
  revealAll: () => void;
  /** Hidden comments still collapsed, as the timeline last counted them. */
  hiddenCount: number;
  reportHidden: (count: number) => void;
};

const NOT_PROVIDED: RevealedRuns = {
  isRevealed: () => false,
  reveal: () => {},
  revealAll: () => {},
  hiddenCount: 0,
  reportHidden: () => {},
};

const Ctx = createContext<RevealedRuns>(NOT_PROVIDED);

export function RevealedRunsProvider({ children }: { children: ReactNode }) {
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [all, setAll] = useState(false);
  const [hiddenCount, setHiddenCount] = useState(0);

  const value = useMemo<RevealedRuns>(
    () => ({
      isRevealed: (key) => all || keys.has(key),
      reveal: (key) =>
        setKeys((open) => (open.has(key) ? open : new Set(open).add(key))),
      revealAll: () => setAll(true),
      hiddenCount,
      // Naturally idempotent: revealing is one-way, so a run that is open
      // stays open and re-reporting the same count re-renders nothing.
      reportHidden: setHiddenCount,
    }),
    [all, keys, hiddenCount],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRevealedRuns(): RevealedRuns {
  return useContext(Ctx);
}
