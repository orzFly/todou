import { useMatchRoute } from "@tanstack/react-router";

export type NavCurrent = "page" | "location" | false;

export interface NavPlace {
  to: string;
  params?: Record<string, string>;
  /** Current only on its own address, never on the pages beneath it. */
  exact: boolean;
}

/**
 * Which of a nav's places the reader is in: `"page"` on the place's own
 * address, `"location"` on a page beneath it, `false` elsewhere. The project
 * tabs, the settings categories and the switcher all ask this one question, so
 * the switcher can never land on a module the tabs do not mark.
 *
 * Computed here rather than read off `Link`'s own matching, because `Link`
 * sets `aria-current="page"` on every fuzzy match and merges it last, over
 * whatever the caller passed. Callers' links therefore match exactly
 * (`activeOptions={{ exact: true, includeSearch: false }}`), which agrees
 * with `"page"` here and leaves `"location"` standing on the pages below.
 * Search params never count: a filtered list is still the list (T-79).
 */
export function useNavCurrent(): (place: NavPlace) => NavCurrent {
  const matchRoute = useMatchRoute();
  return ({ to, params, exact }) => {
    const match = (fuzzy: boolean) =>
      matchRoute({ to, params, fuzzy, includeSearch: false } as Parameters<
        typeof matchRoute
      >[0]) !== false;
    if (match(false)) return "page";
    if (!exact && match(true)) return "location";
    return false;
  };
}
