import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  useMatches,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import type { Me } from "@todou/shared";
import { type ReactNode, Suspense, useMemo } from "react";
import { api, authModeQuery, projectQuery } from "@/api/queries.ts";
import { useUserEvents } from "@/api/useUserEvents.ts";
import { VersionFooter } from "@/components/footer.tsx";
import { InboxButton } from "@/components/inbox-button.tsx";
import { PagePending } from "@/components/page-skeleton.tsx";
import { NewIssueButton, ProjectNav } from "@/components/project-nav.tsx";
import { ProjectSwitcher } from "@/components/project-switcher.tsx";
import { SearchBox } from "@/components/search-box.tsx";
import { SearchToggle } from "@/components/search-toggle.tsx";
import { ProjectIcon } from "@/components/shared/project-icon.tsx";
import { ReturnViewProvider } from "@/components/shared/return-context.tsx";
import { NavBackControl } from "@/components/shared/return-link.tsx";
import { UnsavedChangesGuard } from "@/components/shared/unsaved-guard.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import { SpecReviewSessionProvider } from "@/components/spec/spec-review-session-provider.tsx";
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
import { Skeleton } from "@/components/ui/skeleton";
import { MD_UP, SM_UP, useMediaQuery } from "@/lib/use-media-query.ts";
import { useProjectRefs } from "@/lib/use-project-refs.ts";
import { cn } from "@/lib/utils";

export function AppShell({
  me,
  children,
  notice,
  accountUnavailable = false,
}: {
  /**
   * Absent until `/api/me` answers. The header is rendered anyway (T-265):
   * nothing else in it needs an account — the slug comes from the route, and
   * the switcher, the nav, the search and the inbox each hold their own query.
   */
  me?: Me;
  children: ReactNode;
  /**
   * Rendered between the header and `<main>` by the owner of the failure
   * that produced it (`AuthedLayout`); passing `undefined` draws nothing.
   * The shell itself never reads a query to decide this, so mounting it
   * standalone stays seed-free.
   */
  notice?: ReactNode;
  /**
   * The account is known to be unreachable (`/api/me` failed cold and is not
   * going to answer), so the slot holds a static "unavailable" notice instead
   * of the loading skeleton, which would otherwise spin forever. Same height
   * as the skeleton, so the header row does not reshuffle.
   */
  accountUnavailable?: boolean;
}) {
  // One user-level stream for every page and every readable project (T-122),
  // and since T-276 one for every tab of the account: the lock and the
  // channel are named after this id, so signing in as somebody else does not
  // inherit the previous identity's stream. Held shut until the account is
  // known: with no session there is none to subscribe to, and an
  // unauthenticated visitor would collect a run of 401s on the way to /login.
  useUserEvents(me?.id);
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

  // This route takes `<main>` as a flex child of a viewport-tall root, so the
  // space under the header is what flex leaves rather than a constant that can
  // disagree with it; the version footer stays unrendered for the same reason.
  const fillsViewport = useMatches({
    select: (matches) => matches.some((m) => m.staticData.fillsViewport),
  });

  // Which back control this route asks the nav for, from the deepest match
  // that names one (T-461). A primitive, so `select` can compare it and the
  // whole shell is not re-rendered by every unrelated match change.
  const backControl = useMatches({
    select: (matches) => {
      for (let i = matches.length - 1; i >= 0; i--) {
        const kind = matches[i]?.staticData.backControl;
        if (kind !== undefined) return kind;
      }
      return undefined;
    },
  });
  // Present on every route under /projects/$slug; the header morphs into a
  // breadcrumb with the project nav there (T-62). `number` rides along for the
  // spec route, whose way back is the card the spec belongs to.
  const { slug, number } = useParams({ strict: false });
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
  // The directory, not this project's own `useRefPrefix`, although that one is
  // right here: the two disagree on a contested prefix, and a REF shown in the
  // breadcrumb while the switcher two pixels away has dropped it is worse than
  // either rule on its own.
  const one = useMemo(
    () => (project.data ? [project.data] : undefined),
    [project.data],
  );
  const refs = useProjectRefs(one);

  return (
    <SpecReviewSessionProvider>
      {/* Outside the header/`<main>` split on purpose: the collection pages
          that offer a return origin are inside `<main>`, while the search box
          that consumes one is chrome. A provider around the routed page would
          leave a card opened from the search box with no way back (T-407). */}
      <ReturnViewProvider viewerId={me?.id}>
        <div
          className={cn(
            "bg-background",
            fillsViewport ? "flex h-dvh flex-col" : "min-h-dvh",
          )}
        >
          <UnsavedChangesGuard />
          <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
            {/* `relative` is the anchor the collapsed search expands against. */}
            <div className="relative mx-auto flex h-14 max-w-6xl items-center gap-2 px-4">
              {/* Sized by its own content (`flex-auto`, not `flex-1`), which
              is what lets the row notice that this cluster is running out of
              room and take the width off the search box first — with a basis
              of 0 the browser cannot see what this wants, so the deficit fell
              on the project name every time (T-454). `min-w-0` is still what
              lets that name truncate once the box has nothing left to give,
              and `overflow-hidden` makes what is left over clip rather than
              lie on top of the box. */}
              <div className="flex min-w-0 flex-auto items-center gap-2 overflow-hidden">
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
                      className="flex min-w-0 items-center gap-1.5 font-semibold hover:underline"
                    >
                      <ProjectIcon
                        aria-hidden="true"
                        project={{
                          name: project.data?.name ?? slug,
                          prefix: refs.get(slug)?.prefix ?? null,
                          icon_url: project.data?.icon_url,
                        }}
                        className="size-5"
                      />
                      <span className="truncate">
                        {project.data?.name ?? slug}
                      </span>
                    </Link>
                    <ProjectSwitcher slug={slug} />
                    <ProjectNav slug={slug} className="ml-2 hidden sm:flex" />
                  </>
                )}
              </div>
              {/* Docked against the account cluster rather than centred, so
              that idle, focused and mid-resize all grow the box in the same
              direction — leftwards, over the nav (T-454). The shrink weight
              is what orders the two give-ways: against the left cluster's
              factor of 1 it takes all of any deficit, down to `min-w-32`,
              where flex freezes it and the rest of the deficit finally
              reaches the project name.

              Five digits rather than three because "nearly all" is not
              enough here. At 999 the cluster still absorbed about a thousandth
              of the deficit — 0.09px, under a device pixel but over Chrome's
              1/64px layout quantum — and the project name, left sitting that
              0.09px inside its own text, ellipsised itself to `Tod…` across
              every width where the box was mid-shrink. At 99999 the residue
              rounds away to nothing. */}
              {wide && slug != null && (
                <SearchBox
                  slug={slug}
                  className="w-80 min-w-32 shrink-[99999]"
                  focusWidth="w-80"
                />
              )}
              {/* Content-sized and unshrinkable: these buttons are the one
              thing in the row that has no smaller form to fall back to. */}
              <div className="flex flex-none items-center gap-1">
                {!wide && !hasProjectRow && slug != null && (
                  <SearchToggle slug={slug} />
                )}
                {slug != null && (
                  <NewIssueButton
                    slug={slug}
                    className="hidden sm:inline-flex"
                  />
                )}
                <InboxButton />
                <ThemeMenu />
                {me === undefined ? (
                  accountUnavailable ? (
                    /* No result is coming: say so, in the skeleton's own
                   footprint, rather than spin. The text is the assertion
                   contract — a bare div would be indistinguishable from
                   "nothing was rendered at all". */
                    <span className="text-muted-foreground flex h-7 items-center px-2.5 text-sm">
                      Account unavailable
                    </span>
                  ) : (
                    /* The account button's own footprint (`size="sm"` is h-7
                   px-2.5), so the row does not reshuffle when /api/me lands.
                   No menu hangs off it: there is no account to act on yet. */
                    <div className="flex h-7 items-center gap-1 px-2.5">
                      <Skeleton className="size-5 rounded-full" />
                      <Skeleton className="h-4 w-16" />
                    </div>
                  )
                ) : (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm">
                        <UserChip user={me} link={false} />
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
                )}
              </div>
            </div>
            {/* The project row, and the only thing that makes the header two
            rows tall. It ends at `sm`: from there on the first row seats the
            nav, the search and the create button itself. `relative` because
            the search expands over this row while it lives here. */}
            {slug != null && (
              <div className="relative mx-auto flex max-w-6xl items-center gap-2 px-4 pb-2 sm:hidden">
                {/* Mounted rather than hidden by a class, because "exactly one
                    back control on screen" is the rule this and the page's own
                    copy have to keep between them, and a copy CSS has hidden
                    is still a copy (T-461). */}
                {hasProjectRow && backControl !== undefined && (
                  <div className="flex shrink-0 items-center gap-1">
                    <NavBackControl
                      kind={backControl}
                      slug={slug}
                      number={number}
                    />
                    <span aria-hidden className="text-muted-foreground/50">
                      |
                    </span>
                  </div>
                )}
                <ProjectNav slug={slug} className="flex-1" />
                {hasProjectRow && <SearchToggle slug={slug} />}
                <NewIssueButton slug={slug} />
              </div>
            )}
            {/* The connection banner lives INSIDE the header, not after it: the
            header is sticky, so a bar after it either scrolls away behind the
            backdrop-blur or — pinned sticky — lands on the same strip the
            page's own toolbars pin to and gets covered by them. In here it
            rides the sticky chrome; the header grows, and every pinned
            toolbar shifts down with it because they all measure this same
            element through useHeaderHeight(). */}
            {notice}
          </header>
          {/* Drawn below the chrome on purpose: the router's own boundary wraps
          the root `<Outlet/>` (`Match.js:144`) above everything here, so a
          page waiting on a cold `useSuspenseQuery` used to take the whole
          shell down with it (T-265). Pages draw further boundaries inside
          this one. Component identity across a card switch comes from keys
          (`issue-detail.tsx`, T-324). */}
          <main
            className={cn(
              "px-4 pt-6",
              fillsViewport
                ? "flex min-h-0 flex-1 flex-col pb-4"
                : "mx-auto max-w-6xl pb-6",
            )}
          >
            <Suspense fallback={<PagePending />}>{children}</Suspense>
          </main>
          {!fillsViewport && <VersionFooter />}
        </div>
      </ReturnViewProvider>
    </SpecReviewSessionProvider>
  );
}
