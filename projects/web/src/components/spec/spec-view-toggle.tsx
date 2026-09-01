import { Link } from "@tanstack/react-router";
import type { SpecSearch, SpecView } from "@/lib/spec-search.ts";
import { cn } from "@/lib/utils.ts";

const OPTIONS: Array<{
  value: SpecView;
  label: string;
  /** What the presentation draws against a baseline… */
  comparingTitle: string;
  /** …and what it draws while a single version is being read. */
  plainTitle: string;
}> = [
  {
    value: "rendered",
    label: "rendered",
    comparingTitle: "Read the document with the changed blocks highlighted",
    plainTitle: "Read the rendered document",
  },
  {
    value: "source",
    label: "source",
    comparingTitle: "Read the unified diff of the markdown source",
    plainTitle: "Read this version's raw markdown source",
  },
];

const SEGMENT =
  "flex-1 rounded-full px-2 py-0.5 text-center text-xs leading-5 transition-colors";

const SEGMENT_ON = "bg-foreground font-medium text-background";
const SEGMENT_OFF = "text-muted-foreground hover:text-foreground";

/**
 * How the document is drawn: rendered or as its markdown source (T-192).
 *
 * Orthogonal to whether anything is being compared — all four quadrants
 * exist, so the control is never disabled. Only the state it writes to
 * changes: a comparison is shareable and moves through the URL, reading one
 * version is a session stance and moves through a callback (T-200).
 */
export function SpecViewToggle({
  slug,
  issueNumber,
  view,
  searchFor,
  onSelect,
}: {
  slug: string;
  issueNumber: number;
  view: SpecView;
} & (
  | { searchFor: (view: SpecView) => SpecSearch; onSelect?: never }
  | { searchFor?: never; onSelect: (view: SpecView) => void }
)) {
  const params = { slug, number: String(issueNumber) };
  return (
    <fieldset
      // items-center rather than the default stretch: a segment is 24px tall
      // and h-7 leaves a 22px padding box, so stretching flattens the pill
      // instead of letting it overhang the padding evenly (T-194).
      className="inline-flex h-7 shrink-0 items-center rounded-full border p-0.5"
      aria-label="comparison view"
    >
      {OPTIONS.map((option) =>
        searchFor === undefined ? (
          <button
            key={option.value}
            type="button"
            aria-pressed={option.value === view}
            title={option.plainTitle}
            onClick={() => onSelect(option.value)}
            className={cn(
              SEGMENT,
              "cursor-pointer",
              option.value === view ? SEGMENT_ON : SEGMENT_OFF,
            )}
          >
            {option.label}
          </button>
        ) : (
          <Link
            key={option.value}
            to="/projects/$slug/issues/$number/spec"
            params={params}
            search={searchFor(option.value)}
            title={option.comparingTitle}
            // Exact, or the router would read the shorter rendered url as a
            // prefix of the longer one and light both segments up.
            activeOptions={{ exact: true, includeSearch: true }}
            className={cn(
              SEGMENT,
              option.value === view ? SEGMENT_ON : SEGMENT_OFF,
            )}
          >
            {option.label}
          </Link>
        ),
      )}
    </fieldset>
  );
}
