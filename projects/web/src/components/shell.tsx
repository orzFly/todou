import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  useMatches,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import type { Me } from "@todou/shared";
import type { ReactNode } from "react";
import { api, authModeQuery, projectQuery } from "@/api/queries.ts";
import { useUserEvents } from "@/api/useUserEvents.ts";
import { VersionFooter } from "@/components/footer.tsx";
import { InboxButton } from "@/components/inbox-button.tsx";
import { NewIssueButton, ProjectNav } from "@/components/project-nav.tsx";
import { ProjectSwitcher } from "@/components/project-switcher.tsx";
import { SearchBox } from "@/components/search-box.tsx";
import { SearchToggle } from "@/components/search-toggle.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import { ThemeMenu } from "@/components/theme-menu.tsx";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MD_UP, SM_UP, useMediaQuery } from "@/lib/use-media-query.ts";

export function AppShell({ me, children }: { me: Me; children: ReactNode }) {
  // One user-level stream for every page and every readable project (T-122).
  useUserEvents();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      queryClient.clear();
      navigate({ to: "/login" });
    },
  });

  // In forward mode the login state belongs to the reverse proxy — a local
  // "log out" would do nothing and come back signed in.
  const authMode = useQuery(authModeQuery);
  const canLogout = authMode.data?.mode !== "forward";

  // Board owns the viewport height; anything appended below it would add a
  // scrollbar to a page designed not to scroll.
  const fillsViewport = useMatches({
    select: (matches) => matches.some((m) => m.staticData.fillsViewport),
  });

  // Present on every route under /projects/$slug; the header morphs into a
  // breadcrumb with the project nav there (T-62).
  const { slug } = useParams({ strict: false });
  // A behavioural split, not a visibility one: below `md` the search is a
  // disclosure with its own state and keyboard exits, so exactly one of the
  // two is mounted and `/` has exactly one place to land.
  const wide = useMediaQuery(MD_UP);
  // Below `sm` there is a project row, and the search belongs on it: it
  // searches this project, so it sits with the project's own controls rather
  // than up among the account ones.
  const hasProjectRow = !useMediaQuery(SM_UP);
  const project = useQuery({
    ...projectQuery(slug ?? ""),
    enabled: slug != null,
  });

  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
        {/* `relative` is the anchor the collapsed search expands against. */}
        <div className="relative mx-auto flex h-14 max-w-6xl items-center gap-2 px-4">
          {/* The only cluster that may give ground: `min-w-0` lets the project
              name truncate, and `overflow-hidden` makes what is left over
              clip rather than lie on top of the search box. */}
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            <Link
              to="/projects"
              className="flex shrink-0 items-center gap-2 font-semibold"
            >
              <span aria-hidden>🥔</span>
              {slug == null && <span>todou</span>}
            </Link>
            {slug != null && (
              <>
                <span aria-hidden className="text-muted-foreground/50">
                  /
                </span>
                <Link
                  to="/projects/$slug"
                  params={{ slug }}
                  className="truncate font-semibold hover:underline"
                >
                  {project.data?.name ?? slug}
                </Link>
                <ProjectSwitcher slug={slug} />
                <ProjectNav slug={slug} className="ml-2 hidden sm:flex" />
              </>
            )}
          </div>
          {/* A fixed width per breakpoint, never shrinking, is what holds
              the box still: only the flanks give ground. */}
          {wide && slug != null && (
            <SearchBox slug={slug} className="w-40 shrink-0 lg:w-64 xl:w-80" />
          )}
          {/* No `min-w-0` here, deliberately: this cluster stops at its
              min-content width and the buttons are never squeezed. Both
              flanks being `flex-1` with the same floor is what leaves the
              box in the middle of the row. */}
          <div className="flex flex-1 items-center justify-end gap-1">
            {!wide && !hasProjectRow && slug != null && (
              <SearchToggle slug={slug} />
            )}
            {slug != null && (
              <NewIssueButton slug={slug} className="hidden sm:inline-flex" />
            )}
            <InboxButton />
            <ThemeMenu />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm">
                  <UserChip user={me} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {/* The chip in the trigger already carries the display name;
                    the label is what tells you which account that is. */}
                <DropdownMenuLabel>@{me.login}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/settings/profile">Profile</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/settings/agents">Agents</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/settings/tokens">Personal tokens</Link>
                </DropdownMenuItem>
                {canLogout && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => logout.mutate()}>
                      Log out
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {/* The project row, and the only thing that makes the header two
            rows tall. It ends at `sm`: from there on the first row seats the
            nav, the search and the create button itself. `relative` because
            the search expands over this row while it lives here. */}
        {slug != null && (
          <div className="relative mx-auto flex max-w-6xl items-center gap-2 px-4 pb-2 sm:hidden">
            <ProjectNav slug={slug} className="flex-1" />
            {hasProjectRow && <SearchToggle slug={slug} />}
            <NewIssueButton slug={slug} />
          </div>
        )}
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      {!fillsViewport && <VersionFooter />}
    </div>
  );
}
