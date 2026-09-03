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
import { ProjectNav } from "@/components/project-nav.tsx";
import { ProjectSwitcher } from "@/components/project-switcher.tsx";
import { SearchBox } from "@/components/search-box.tsx";
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
  const project = useQuery({
    ...projectQuery(slug ?? ""),
    enabled: slug != null,
  });

  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4">
          {/* Grows so the nav it holds can push its create button out to
              the account cluster, instead of trailing after Settings. */}
          <div className="flex min-w-0 flex-1 items-center gap-2">
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
                <ProjectNav
                  slug={slug}
                  className="ml-2 hidden flex-1 sm:flex"
                />
              </>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {/* Wide screens only. Narrower than `md` the header already has
                a second row, and the box moves down to it rather than
                squeezing the project name out of this one. */}
            {slug != null && (
              <SearchBox slug={slug} className="hidden w-48 md:block" />
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
        {slug != null && (
          <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 pb-2 md:hidden">
            <ProjectNav slug={slug} className="flex-1 sm:hidden" />
            <SearchBox
              slug={slug}
              className="max-w-48 flex-1 sm:max-w-none"
              listAlign="stretch"
            />
          </div>
        )}
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      {!fillsViewport && <VersionFooter />}
    </div>
  );
}
