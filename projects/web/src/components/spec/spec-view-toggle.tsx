import { Link } from "@tanstack/react-router";
import type { SpecSearch, SpecView } from "@/lib/spec-search.ts";
import { cn } from "@/lib/utils.ts";

const OPTIONS: Array<{ value: SpecView; label: string; title: string }> = [
  {
    value: "rendered",
    label: "rendered",
    title: "Read the document with the changed blocks highlighted",
  },
  {
    value: "source",
    label: "source",
    title: "Read the unified diff of the markdown source",
  },
];

const SEGMENT =
  "flex-1 rounded-full px-2 py-0.5 text-center text-xs leading-5 transition-colors";

/**
 * How a comparison is drawn: the rendered document with its changed blocks
 * washed, or the unified diff of the source (T-192).
 *
 * Fixed width by design — the toolbar's slot geometry has to survive both
 * labels and both states (T-190).
 */
export function SpecViewToggle({
  slug,
  issueNumber,
  view,
  disabled,
  searchFor,
}: {
  slug: string;
  issueNumber: number;
  view: SpecView;
  /** Reading without a baseline: there is no comparison to draw. */
  disabled: boolean;
  searchFor: (view: SpecView) => SpecSearch;
}) {
  const params = { slug, number: String(issueNumber) };
  return (
    <fieldset
      // The tooltip hangs on the group: disabled buttons swallow pointer
      // events, their own `title` included.
      title={disabled ? "Pick a baseline to compare against" : undefined}
      className="inline-flex w-36 shrink-0 rounded-full border p-0.5"
      aria-label="comparison view"
    >
      {OPTIONS.map((option) =>
        disabled ? (
          <button
            key={option.value}
            type="button"
            disabled
            className={cn(SEGMENT, "text-muted-foreground/50")}
          >
            {option.label}
          </button>
        ) : (
          <Link
            key={option.value}
            to="/projects/$slug/issues/$number/spec"
            params={params}
            search={searchFor(option.value)}
            title={option.title}
            // Exact, or the router would read the shorter rendered url as a
            // prefix of the longer one and light both segments up.
            activeOptions={{ exact: true, includeSearch: true }}
            className={cn(
              SEGMENT,
              option.value === view
                ? "bg-foreground font-medium text-background"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </Link>
        ),
      )}
    </fieldset>
  );
}
