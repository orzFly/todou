import { Button } from "@orz/ui/components/button";
import { TabNav, TabNavLink } from "@orz/ui/components/tab-nav";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@orz/ui/components/tooltip";
import { Link } from "@tanstack/react-router";
import { type CapabilityId, can, type MemberRole } from "@todou/shared";
import { PlusIcon } from "lucide-react";
import { useNavCurrent } from "@/lib/nav-current.ts";

/**
 * The project's modules, in the order they give up their room on the row:
 * the last one waits in the `⋯` first. Shared with the project switcher, which
 * keeps the current module across a switch.
 */
export const projectTabs = [
  { to: "/projects/$slug", label: "List", exact: true },
  { to: "/projects/$slug/board", label: "Board", exact: false },
  {
    to: "/projects/$slug/insights",
    label: "Insights",
    exact: false,
    cap: "insights.read",
  },
  {
    // Gated on the member list because that is the page's reason to exist:
    // a guest, who cannot see members, would find only catalogs it already
    // meets on its own cards (T-788).
    to: "/projects/$slug/settings",
    label: "Settings",
    exact: false,
    cap: "member.list",
  },
] as const satisfies readonly {
  to: string;
  label: string;
  exact: boolean;
  cap?: CapabilityId;
}[];

type ProjectTab = (typeof projectTabs)[number];

/**
 * `undefined` is "not known yet", which shows every tab: hiding them until
 * the project answers would blink the row for everyone to spare a guest the
 * reverse.
 */
const shows = (tab: ProjectTab, role: MemberRole | null | undefined) =>
  !("cap" in tab) || role === undefined || can(role, tab.cap);

/**
 * Project-level navigation (T-62), in the header: on the one row from `sm`,
 * on the project row below it. What does not fit goes into the `⋯` from the
 * end, the current module last.
 */
export function ProjectNav({
  slug,
  className,
  viewerRole,
}: {
  slug: string;
  className?: string;
  viewerRole?: MemberRole | null;
}) {
  const current = useNavCurrent();
  return (
    <TabNav aria-label="Project" className={className}>
      {projectTabs
        .filter((tab) => shows(tab, viewerRole))
        .map((tab) => (
          <TabNavLink
            key={tab.label}
            asChild
            current={current({ ...tab, params: { slug } }) || undefined}
          >
            <Link
              to={tab.to}
              params={{ slug }}
              activeOptions={{ exact: true, includeSearch: false }}
            >
              {tab.label}
            </Link>
          </TabNavLink>
        ))}
    </TabNav>
  );
}

/**
 * Creating an issue, one click from every project module and absent exactly
 * where there is no project to file into (T-104). Labelled on the one row;
 * an icon on the phone's project row, which the tabs and the search share.
 */
export function NewIssueButton({
  slug,
  className,
  iconOnly = false,
}: {
  slug: string;
  className?: string;
  iconOnly?: boolean;
}) {
  const link = (
    <Link to="/projects/$slug/issues/new" params={{ slug }}>
      <PlusIcon />
      {!iconOnly && "New issue"}
    </Link>
  );
  if (!iconOnly) {
    return (
      <Button size="sm" asChild className={className}>
        {link}
      </Button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-sm"
          asChild
          className={className}
          aria-label="New issue"
        >
          {link}
        </Button>
      </TooltipTrigger>
      <TooltipContent>New issue</TooltipContent>
    </Tooltip>
  );
}
