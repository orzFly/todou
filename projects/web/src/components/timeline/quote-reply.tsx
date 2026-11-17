import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/** What a rendered body hands the floating Quote reply. */
export type QuoteTarget = {
  /** The stored markdown, read when the reader's selection settles. */
  body: () => string;
  /** The box whose right edge the button lines up with. */
  frame: () => Element;
};

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
  /** Rendered bodies a selection may be quoted from, by their element. */
  targets: Map<Element, QuoteTarget>;
};

const NOT_PROVIDED: QuoteReply = {
  register: () => () => {},
  available: false,
  quote: () => {},
  targets: new Map(),
};

const Ctx = createContext<QuoteReply>(NOT_PROVIDED);

export function QuoteReplyProvider({ children }: { children: ReactNode }) {
  const sink = useRef<((markdown: string) => void) | null>(null);
  const [available, setAvailable] = useState(false);
  const [targets] = useState(() => new Map<Element, QuoteTarget>());

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
    () => ({ register, available, quote, targets }),
    [register, available, quote, targets],
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

/**
 * A rendered body's side: selecting text inside the element this ref lands
 * on floats a Quote reply (T-723). A callback ref rather than an effect,
 * because the body element comes and goes with the editor while the entry
 * itself stays mounted.
 *
 * `frameRef` is for a body that is not a block of its own — an action's runs
 * inline in its sentence — and lines the button up with the row instead.
 */
export function useQuoteTarget(
  body: string,
  bodyRef: RefObject<HTMLElement | null>,
  frameRef?: RefObject<HTMLElement | null>,
): (el: HTMLElement | null) => void {
  const { targets } = useQuoteReply();
  const latest = useRef(body);
  latest.current = body;
  const registered = useRef<HTMLElement | null>(null);
  return useCallback(
    (el: HTMLElement | null) => {
      bodyRef.current = el;
      if (registered.current !== null) targets.delete(registered.current);
      registered.current = el;
      if (el === null) return;
      targets.set(el, {
        body: () => latest.current,
        frame: () => frameRef?.current ?? el,
      });
    },
    [targets, bodyRef, frameRef],
  );
}
