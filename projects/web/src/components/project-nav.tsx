import { Link, useMatchRoute } from "@tanstack/react-router";
import { CheckIcon, EllipsisIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * Shared with the project switcher, which keeps the active tab across a
 * switch — so this stays the whole list, `behind` and all. `behind` says the
 * tab rides in the `···` menu rather than on the row (T-454).
 */
export const projectTabs = [
  { to: "/projects/$slug", label: "List", exact: true, behind: false },
  { to: "/projects/$slug/board", label: "Board", exact: false, behind: false },
  {
    to: "/projects/$slug/insights",
    label: "Insights",
    exact: false,
    behind: true,
  },
  {
    to: "/projects/$slug/settings",
    label: "Settings",
    exact: false,
    behind: true,
  },
] as const;

type ProjectTab = (typeof projectTabs)[number];

const onTheRow = projectTabs.filter((tab) => !tab.behind);
const behindMore = projectTabs.filter((tab) => tab.behind);

/**
 * The row's shape, worn by the tabs and by the `···` alike. One padding at
 * every width: T-389 halved it below `sm` to fit a fourth tab onto the phone
 * row, and the `···` is what bought that room back (T-454).
 */
const TAB =
  "rounded-md px-3 py-1 text-sm text-muted-foreground hover:text-foreground";

/** What being on this page looks like, wherever the row chooses to say it. */
const MARK = "bg-accent text-foreground font-medium";

/**
 * The two bands where the row has room for the active module to stand on it,
 * measured on this header with the shortest project name (T-454). Below `sm`
 * the tabs share a row with two icon buttons and fit from 360px; from `sm` the
 * same tabs share one row with the project name, the search box and the create
 * button, and do not fit again until 864.
 *
 * Two bands rather than a threshold, because the room does not grow with the
 * viewport: at 700 the pulled-out tab squeezed the project name from 46px to
 * 4px, while at 390 — a narrower screen — it fits with room to spare. No
 * single `min-width` can say that, which is why this is not one.
 *
 * The widths are approximate by construction: 864 is where a project called
 * "Todou" stops paying for the tab out of the search box's slack, and a longer
 * name moves that edge right. Being wrong costs a few pixels of project name,
 * which is why measuring it exactly is not worth a ResizeObserver here.
 */
const ON_THE_ROW = "hidden min-[360px]:max-sm:block min-[864px]:block";

/**
 * Exactly the widths `ON_THE_ROW` hides at. The mark has to be in one place or
 * the other: a row reading `List Board ···` with nothing lit says the reader is
 * nowhere.
 */
const MARK_ON_MORE =
  "max-[360px]:bg-accent max-[360px]:font-medium max-[360px]:text-foreground sm:max-[864px]:bg-accent sm:max-[864px]:font-medium sm:max-[864px]:text-foreground";

function NavTab({
  tab,
  slug,
  className,
}: {
  tab: ProjectTab;
  slug: string;
  className?: string;
}) {
  return (
    <Link
      to={tab.to}
      params={{ slug }}
      // includeSearch off: exact mode deep-equals the whole search object,
      // so filter params like ?category=closed would drop the highlight (T-79).
      activeOptions={{ exact: tab.exact, includeSearch: false }}
      className={cn(TAB, className)}
      activeProps={{ className: MARK }}
    >
      {tab.label}
    </Link>
  );
}

/**
 * Project-level navigation (T-62). Lives in the floating header: inline on
 * wide screens, on its own second row below `sm`, where it shares the row
 * with the create button.
 *
 * Only List and Board stand on the row; Insights and Settings ride behind the
 * `···`, which is what gave the row back the width Insights had taken (T-454).
 * The module you are actually in comes back out onto the row where there is
 * room for it (`ON_THE_ROW`), and where there is not, the `···` wears the mark
 * instead — either way something on the row says where the reader is. It stays
 * in the menu as well, still marked: the menu is the list of what is there,
 * not the list of where you are not.
 */
export function ProjectNav({
  slug,
  className,
}: {
  slug: string;
  className?: string;
}) {
  const matchRoute = useMatchRoute();
  // `fuzzy` is `exact` inverted, so the pulled-out tab and its menu twin
  // decide by the same rule the `Link`s below highlight by.
  const pulledOut = behindMore.find((tab) =>
    matchRoute({ to: tab.to, params: { slug }, fuzzy: !tab.exact }),
  );

  return (
    // nowrap so a squeezed header truncates the project name instead of
    // wrapping the tabs, which would push the create button off its row.
    <nav className={cn("flex items-center gap-1 whitespace-nowrap", className)}>
      {onTheRow.map((tab) => (
        <NavTab key={tab.label} tab={tab} slug={slug} />
      ))}
      {pulledOut && (
        <NavTab tab={pulledOut} slug={slug} className={ON_THE_ROW} />
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="More"
            className={cn(TAB, "flex", pulledOut && MARK_ON_MORE)}
          >
            <EllipsisIcon className="size-4" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        {/* The trigger is one glyph wide and the content takes the trigger's
            width, so the floor is the whole measurement here. */}
        <DropdownMenuContent align="start" className="min-w-36">
          {behindMore.map((tab) => (
            <DropdownMenuItem key={tab.label} asChild>
              <Link
                to={tab.to}
                params={{ slug }}
                activeOptions={{ exact: tab.exact, includeSearch: false }}
                // Not the row's `bg-accent`: that is also what a menu item
                // wears under the pointer, and two rows that look alike stop
                // saying which one is the page you are on.
                activeProps={{ className: "font-medium text-foreground" }}
              >
                {tab.label}
                {tab === pulledOut && (
                  <CheckIcon className="ml-auto" aria-hidden />
                )}
              </Link>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>
  );
}

/**
 * Creating an issue, one click from every project module and absent exactly
 * where there is no project to file into (T-104). From `sm` up it sits in
 * the header's account cluster, after the search box; below that it moves
 * to the project row, which has room the first row does not.
 *
 * It stays an icon on that row to leave room for the tabs and the search
 * toggle on narrow phones. aria-label rather than the visible text, because
 * a `display: none` label is not announced either.
 */
export function NewIssueButton({
  slug,
  className,
}: {
  slug: string;
  className?: string;
}) {
  return (
    <Button size="sm" asChild className={className}>
      <Link
        to="/projects/$slug/issues/new"
        params={{ slug }}
        aria-label="New issue"
      >
        <PlusIcon />
        <span className="hidden sm:inline">New issue</span>
      </Link>
    </Button>
  );
}
