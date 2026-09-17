import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * The way a Quote reply reaches the comment box.
 *
 * The box is the page's, a sibling of the timeline; the menu that fires this
 * sits deep inside one comment. Nothing else connects them, and threading a
 * callback down would put a prop on every row between.
 */
type QuoteReply = {
  /** The comment box claims the channel on mount; the return unclaims it. */
  register: (sink: (markdown: string) => void) => () => void;
  /** Whether there is a box to write into — a trashed card has none. */
  available: boolean;
  quote: (markdown: string) => void;
};

const NOT_PROVIDED: QuoteReply = {
  register: () => () => {},
  available: false,
  quote: () => {},
};

const Ctx = createContext<QuoteReply>(NOT_PROVIDED);

export function QuoteReplyProvider({ children }: { children: ReactNode }) {
  const sink = useRef<((markdown: string) => void) | null>(null);
  const [available, setAvailable] = useState(false);

  // Stable, deliberately: the box registers from an effect keyed on this
  // identity, and a `register` that changed with `available` would unregister
  // and re-register itself forever.
  const register = useCallback((next: (markdown: string) => void) => {
    sink.current = next;
    setAvailable(true);
    return () => {
      if (sink.current !== next) return;
      sink.current = null;
      setAvailable(false);
    };
  }, []);
  const quote = useCallback((markdown: string) => sink.current?.(markdown), []);

  const value = useMemo<QuoteReply>(
    () => ({ register, available, quote }),
    [register, available, quote],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useQuoteReply(): QuoteReply {
  return useContext(Ctx);
}

/** The comment box's side: this mount is where quotes land. */
export function useQuoteSink(sink: (markdown: string) => void): void {
  const { register } = useQuoteReply();
  const latest = useRef(sink);
  latest.current = sink;
  useEffect(() => register((markdown) => latest.current(markdown)), [register]);
}
