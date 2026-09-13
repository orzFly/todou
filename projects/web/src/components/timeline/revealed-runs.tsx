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

export function RevealedRunsProvider({
  card,
  children,
}: {
  /** Which card is on screen. Nothing about it enters a run key; it decides
   *  only when this state folds back. */
  card: string;
  children: ReactNode;
}) {
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [all, setAll] = useState(false);
  const [hiddenCount, setHiddenCount] = useState(0);

  // Adjusted during the render that sees the new card, not from an effect:
  // an effect lets the tree commit once still holding the last card's runs,
  // which is the leak itself. The children rendered here are the new card's,
  // so none of them can see the stale set either.
  //
  // A `key` would reset the same state without this state variable, but it
  // wraps the whole left column — the bar, the title, the body, the spec row,
  // the attachments — and the two children that genuinely need a fresh
  // instance, `Timeline` and `Composer`, already carry keys of their own.
  //
  // Idempotent, which is what Strict Mode's double render asks of it and what
  // the `Composer` reset (T-317) could not offer: the second pass sees the
  // same stale `shown`, writes the same values again, and React throws the
  // first pass away before either reaches the children.
  const [shown, setShown] = useState(card);
  if (shown !== card) {
    setShown(card);
    setKeys(new Set());
    setAll(false);
    setHiddenCount(0);
  }

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
