import { useRef, useState } from "react";

type PagedAppendState<P> = {
  key: string;
  generation: number;
  pages: P[];
  pending: boolean;
  error: Error | null;
};

function emptyState<P>(key: string, generation: number): PagedAppendState<P> {
  return { key, generation, pages: [], pending: false, error: null };
}

export function usePagedAppend<P>(resetKey: string): {
  pages: P[];
  pending: boolean;
  error: Error | null;
  append: (load: () => Promise<P>) => void;
} {
  const [state, setState] = useState<PagedAppendState<P>>(() =>
    emptyState(resetKey, 0),
  );
  const inFlight = useRef<number | null>(null);

  const nextGeneration = state.generation + 1;
  if (state.key !== resetKey) {
    setState(emptyState(resetKey, nextGeneration));
  }
  const current =
    state.key === resetKey ? state : emptyState<P>(resetKey, nextGeneration);

  function append(load: () => Promise<P>) {
    const requestKey = resetKey;
    const requestGeneration = current.generation;
    if (inFlight.current === requestGeneration) return;

    inFlight.current = requestGeneration;
    setState((value) =>
      value.key === requestKey && value.generation === requestGeneration
        ? { ...value, pending: true }
        : value,
    );

    void (async () => {
      try {
        const page = await load();
        setState((value) =>
          value.key === requestKey && value.generation === requestGeneration
            ? {
                ...value,
                pages: [...value.pages, page],
                pending: false,
                error: null,
              }
            : value,
        );
      } catch (caught) {
        const error =
          caught instanceof Error ? caught : new Error(String(caught));
        setState((value) =>
          value.key === requestKey && value.generation === requestGeneration
            ? { ...value, pending: false, error }
            : value,
        );
      } finally {
        if (inFlight.current === requestGeneration) inFlight.current = null;
      }
    })();
  }

  return {
    pages: current.pages,
    pending: current.pending,
    error: current.error,
    append,
  };
}
