import { cn } from "@orz/ui";
import { Button } from "@orz/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@orz/ui/components/dropdown-menu";
import { Pane } from "@orz/ui/components/pane";
import { Skeleton } from "@orz/ui/components/skeleton";
import { ThemeMenu } from "@orz/ui/components/theme-menu";
import { TooltipProvider } from "@orz/ui/components/tooltip";
import { useMediaQuery } from "@orz/ui/hooks/use-media-query";
import {
  useAutoHideHeader,
  useVisualViewportInsets,
} from "@orz/ui/hooks/viewport-chrome";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  useLinkProps,
  useLocation,
  useMatches,
  useMatchRoute,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { can, type Me, type Project } from "@todou/shared";
import { Fragment, type ReactNode, Suspense, useMemo, useRef } from "react";
import { api, authModeQuery, projectQuery } from "@/api/queries.ts";
import { useUserEvents } from "@/api/useUserEvents.ts";
import { VersionFooter } from "@/components/footer.tsx";
import { InboxButton } from "@/components/inbox-button.tsx";
import { PagePending } from "@/components/page-skeleton.tsx";
import { NewIssueButton, ProjectNav } from "@/components/project-nav.tsx";
import { ProjectSwitcher } from "@/components/project-switcher.tsx";
import { SearchBox } from "@/components/search-box.tsx";
import { SearchToggle } from "@/components/search-toggle.tsx";
import {
  ACCOUNT_SETTINGS,
  groupCategories,
} from "@/components/settings-categories.ts";
import { ProjectIcon } from "@/components/shared/project-icon.tsx";
import { ReturnViewProvider } from "@/components/shared/return-context.tsx";
import { NavBackControl } from "@/components/shared/return-link.tsx";
import { UnsavedChangesGuard } from "@/components/shared/unsaved-guard.tsx";
import { displayNameOf, UserChip } from "@/components/shared/user-chip.tsx";
import { SpecReviewSessionProvider } from "@/components/spec/spec-review-session-provider.tsx";
import { MD_UP, SM_UP } from "@/lib/breakpoints.ts";
import { ShellHeaderContext } from "@/lib/shell-header.ts";
import { useProjectRefs } from "@/lib/use-project-refs.ts";

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
  // Below `sm` a project page has a second row, holding what is the project's
  // own: its tabs, its search and its create button. Mounted in one row or the
  // other, never both: the tabs measure themselves to fold, and a copy hidden
  // by CSS has nothing to measure and a second `aria-current` to announce.
  const oneRow = useMediaQuery(SM_UP);
  const projectRow = slug != null && !oneRow;
  useVisualViewportInsets();
  // Below `sm` on every page, the one-row ones too, so whether the header
  // slides away never depends on which page the reader is on (T-594). Not
  // while a notice is up: the connection banner rides in the header, and
  // sliding it away hid the one thing saying why the page had stopped.
  const pathname = useLocation({ select: (location) => location.pathname });
  const headerRef = useRef<HTMLElement>(null);
  useAutoHideHeader(headerRef, !oneRow && notice === undefined, pathname);
  const project = useQuery({
    ...projectQuery(slug ?? ""),
    enabled: slug != null,
  });
  // Unknown until the project answers — and on a server predating the field —
  // which shows everything rather than blinking it in for everyone.
  const viewerRole = project.data?.viewer_role;
  // The search page holds a box of its own, wide enough for a real query, so
  // the header's would be a second one and `/` would have two places to land.
  const matchRoute = useMatchRoute();
  const onSearchPage =
    matchRoute({ to: "/projects/$slug/search", includeSearch: false }) !==
    false;
  const maySearch =
    (viewerRole === undefined || can(viewerRole, "search.run")) &&
    !onSearchPage;
  const searchBox = wide && slug != null && maySearch;

  return (
    // Around the header and `<main>` alike, and here rather than in main.tsx:
    // every test that mounts the shell does so without main.tsx.
    <TooltipProvider>
      <ShellHeaderContext.Provider value={headerRef}>
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
              {/* Pinned to the visual viewport's top rather than the layout's, so a
              keyboard-panned page keeps it on screen; `--header-hide` is
              the share it has slid away on a phone (T-585, T-594). Full width,
              as the pages that fill the viewport are: a header centred over a
              board starting at the window's edge put the two out of line. */}
              <Pane purpose="banner" edge="bottom" asChild>
                <header
                  ref={headerRef}
                  data-header-follow=""
                  className="sticky z-40"
                  style={{
                    top: "calc(var(--vv-top, 0px) - var(--header-hide, 0px))",
                  }}
                >
                  {/* How the row gives way as it narrows: the search box down to
                  its least, then the tabs into their `⋯`, then the project name,
                  then the account name. The tabs take what their links need
                  before anything that grows beside them, and give it up before
                  anything that shrinks (TabNav sizes itself); the search box
                  grows only into what is left, and its auto margin takes the
                  rest, so it docks against the account cluster. Between the two
                  names, shrink weights decide (T-500). `relative` is the anchor
                  the collapsed search expands against. */}
                  <div
                    data-shell-row="primary"
                    className="relative flex h-11 items-stretch gap-2 px-4"
                  >
                    <div className="flex min-w-0 shrink-[1000] items-center gap-2 self-center overflow-x-clip">
                      <Link
                        to="/projects"
                        // Only the projects page itself: elsewhere this is the
                        // first step of a breadcrumb, and the tabs say where
                        // the reader is.
                        activeOptions={{ exact: true, includeSearch: false }}
                        aria-label="todou"
                        className="relative flex shrink-0 items-center gap-2 font-semibold touch:hit-area"
                      >
                        <span aria-hidden>🥔</span>
                        {slug == null && <span>todou</span>}
                      </Link>
                      {slug != null && (
                        <>
                          <span
                            aria-hidden
                            className="text-muted-foreground/50"
                          >
                            /
                          </span>
                          <ProjectLink slug={slug} project={project.data} />
                          <ProjectSwitcher slug={slug} />
                        </>
                      )}
                    </div>
                    {slug != null && oneRow && (
                      <ProjectNav slug={slug} viewerRole={viewerRole} />
                    )}
                    {searchBox && (
                      <SearchBox
                        slug={slug}
                        className="ml-auto max-w-80 min-w-32 shrink-0 grow basis-32 self-center"
                        focusWidth="w-80"
                      />
                    )}
                    {/* Shrinkable only because one thing in here has a smaller
                    form: the account button's name ellipsises (T-486). The rest
                    are icons with nothing to give, and every `Button` is
                    `shrink-0`. */}
                    <div
                      className={cn(
                        "flex min-w-0 items-center gap-1 self-center",
                        !searchBox && "ml-auto",
                      )}
                    >
                      {!wide && oneRow && slug != null && maySearch && (
                        <SearchToggle slug={slug} />
                      )}
                      {slug != null && oneRow && <NewIssueButton slug={slug} />}
                      <InboxButton />
                      <ThemeMenu />
                      <AccountMenu
                        me={me}
                        accountUnavailable={accountUnavailable}
                      />
                    </div>
                  </div>
                  {projectRow && (
                    <div
                      data-shell-row="project"
                      className="relative flex min-h-9 items-stretch gap-2 px-4"
                    >
                      {/* Mounted rather than hidden by a class, because "exactly
                      one back control on screen" is the rule this and the
                      page's own copy have to keep between them, and a copy CSS
                      has hidden is still a copy (T-461). */}
                      {backControl !== undefined && (
                        <div className="flex shrink-0 items-center gap-1 self-center">
                          <NavBackControl
                            kind={backControl}
                            slug={slug}
                            number={number}
                          />
                          <span
                            aria-hidden
                            className="text-muted-foreground/50"
                          >
                            |
                          </span>
                        </div>
                      )}
                      <ProjectNav slug={slug} viewerRole={viewerRole} />
                      <div className="ml-auto flex shrink-0 items-center gap-1 self-center">
                        {maySearch && <SearchToggle slug={slug} />}
                        <NewIssueButton slug={slug} iconOnly />
                      </div>
                    </div>
                  )}
                  {/* The connection banner lives INSIDE the header, not after it:
                  the header is sticky, so a bar after it either scrolls away
                  behind the backdrop-blur or — pinned sticky — lands on the
                  same strip the page's own toolbars pin to and gets covered by
                  them. In here it rides the sticky chrome; the header grows,
                  and every pinned toolbar shifts down with it because they all
                  measure this same element through useHeaderHeight(). */}
                  {notice}
                </header>
              </Pane>
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
      </ShellHeaderContext.Provider>
    </TooltipProvider>
  );
}

/**
 * The breadcrumb's project step. Not a `Link`: on the List page it points at
 * the same address as the List tab, and `Link` would mark both current — it
 * merges `aria-current` last, over anything passed to it. The tabs say where
 * the reader is.
 */
function ProjectLink({ slug, project }: { slug: string; project?: Project }) {
  const { "aria-current": _current, ...link } = useLinkProps({
    to: "/projects/$slug",
    params: { slug },
  });
  // The directory, not this project's own `useRefPrefix`, although that one is
  // right here: the two disagree on a contested prefix, and a REF shown in the
  // breadcrumb while the switcher two pixels away has dropped it is worse than
  // either rule on its own.
  const one = useMemo(() => (project ? [project] : undefined), [project]);
  const refs = useProjectRefs(one);
  const name = project?.name ?? slug;
  return (
    <a
      {...link}
      className="relative flex min-w-5 items-center gap-1.5 font-semibold hover:underline touch:hit-area"
    >
      <ProjectIcon
        aria-hidden="true"
        project={{
          slug,
          name,
          prefix: refs.get(slug)?.prefix ?? null,
          icon_url: project?.icon_url,
        }}
        className="size-5 shrink-0"
      />
      <span className="truncate">{name}</span>
    </a>
  );
}

function AccountMenu({
  me,
  accountUnavailable,
}: {
  me?: Me;
  accountUnavailable: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      queryClient.clear();
      // Without the flag, /login in oidc mode heads straight back to the
      // IdP, whose session outlives ours (T-636).
      navigate({ to: "/login", search: { logged_out: true } });
    },
  });
  // In forward mode the login state belongs to the reverse proxy — a local
  // "log out" would do nothing and come back signed in.
  const authMode = useQuery(authModeQuery);
  const canLogout = authMode.data?.mode !== "forward";

  if (me === undefined) {
    return accountUnavailable ? (
      /* No result is coming: say so, in the skeleton's own footprint, rather
      than spin. The text is the assertion contract — a bare div would be
      indistinguishable from "nothing was rendered at all". */
      <span className="text-muted-foreground flex h-7 items-center px-2.5 text-sm">
        Account unavailable
      </span>
    ) : (
      /* The account button's own footprint (`size="sm"` is h-7 px-2.5), so
      the row does not reshuffle when /api/me lands. No menu hangs off it:
      there is no account to act on yet. */
      <div className="flex h-7 items-center gap-1 px-2.5">
        <Skeleton className="size-5 rounded-full" />
        <Skeleton className="h-4 w-16" />
      </div>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* The one control in the cluster that may narrow (T-500); the menu's
        label spells out the whole name the ellipsis cut. */}
        <Button variant="ghost" size="sm" className="min-w-0 shrink">
          <UserChip user={me} link={false} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="flex flex-col">
          <span className="text-foreground">{displayNameOf(me)}</span>
          <span className="text-muted-foreground font-normal">@{me.login}</span>
        </DropdownMenuLabel>
        {groupCategories(ACCOUNT_SETTINGS).map((run) => (
          <Fragment key={run.items[0]?.to}>
            <DropdownMenuSeparator />
            {run.group && <DropdownMenuLabel>{run.group}</DropdownMenuLabel>}
            {run.items.map(({ to, label, icon: Icon }) => (
              <DropdownMenuItem key={to} asChild>
                <Link to={to}>
                  <Icon />
                  {label}
                </Link>
              </DropdownMenuItem>
            ))}
          </Fragment>
        ))}
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
  );
}
