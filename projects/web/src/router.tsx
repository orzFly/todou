import { useQuery } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Navigate,
  Outlet,
} from "@tanstack/react-router";
import { issueSearchSchema } from "@/api/issues.ts";
import { meQuery } from "@/api/queries.ts";
import { searchPageSchema } from "@/api/search.ts";
import {
  PagePending,
  type PageSkeletonKind,
} from "@/components/page-skeleton.tsx";
import { AppShell } from "@/components/shell.tsx";
import { TitleController } from "@/components/title-controller.tsx";
import { Toaster } from "@/components/ui/sonner";
import { parseSpecSearch } from "@/lib/spec-search.ts";
import { AgentsSettingsPage } from "@/pages/agents-settings.tsx";
import { BoardPage } from "@/pages/board.tsx";
import { CliAuthPage } from "@/pages/cli-auth.tsx";
import { InboxPage } from "@/pages/inbox.tsx";
import { IssueDetailPage } from "@/pages/issue-detail.tsx";
import { IssueListPage } from "@/pages/issue-list.tsx";
import { IssueRouteError, SpecRouteError } from "@/pages/issue-route-error.tsx";
import { LoginPage } from "@/pages/login.tsx";
import { NewIssuePage } from "@/pages/new-issue.tsx";
import { ProfileSettingsPage } from "@/pages/profile-settings.tsx";
import { ProjectLayout, ProjectRouteError } from "@/pages/project-layout.tsx";
import { ProjectSettingsPage } from "@/pages/project-settings.tsx";
import { ProjectsPage } from "@/pages/projects.tsx";
import { SearchPage } from "@/pages/search.tsx";
import { TokensSettingsPage } from "@/pages/tokens-settings.tsx";

const rootRoute = createRootRoute({
  component: () => (
    <>
      <TitleController />
      <Outlet />
      <Toaster position="bottom-right" />
    </>
  ),
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
  validateSearch: (search): { redirect?: string; error?: string } => ({
    ...(typeof search.redirect === "string"
      ? { redirect: search.redirect }
      : {}),
    // The oidc callback reports its failures as /login?error=<code>.
    ...(typeof search.error === "string" ? { error: search.error } : {}),
  }),
});

/** Everything below requires a session; 401 bounces to /login. */
const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "authed",
  component: AuthedLayout,
});

function AuthedLayout() {
  const me = useQuery(meQuery);
  if (me.isError) {
    const status = (me.error as { status?: number }).status;
    if (status === 401) {
      // Carry the interrupted location (e.g. /cli-auth?...) through login.
      // Read window.location (the last COMMITTED url), never live router
      // state: that updates mid-transition, so Navigate would re-fire with
      // an ever-nesting redirect param and wedge the main thread.
      const here = window.location.pathname + window.location.search;
      return (
        <Navigate to="/login" search={here === "/" ? {} : { redirect: here }} />
      );
    }
    return (
      <div className="mx-auto max-w-lg px-4 py-20 text-center text-destructive">
        Failed to reach the todou server: {me.error.message}
      </div>
    );
  }
  return (
    <AppShell me={me.data}>
      {/* Deliberately not `<Outlet/>` while the account is in flight (T-265).
          Mounting the page here would fire its queries alongside /api/me, and
          a visitor without a session can take the page's 401 first — long
          enough to flash that route's errorComponent before <Navigate> sends
          them to /login. The cost is that first-paint fetching stays serial. */}
      {me.isPending ? <PagePending /> : <Outlet />}
    </AppShell>
  );
}

const indexRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/",
  component: () => <Navigate to="/projects" />,
});

const projectsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/projects",
  component: ProjectsPage,
  // ?new=1 (from the switcher footer) opens the create-project dialog.
  validateSearch: (search): { new?: boolean } =>
    search.new === true || search.new === 1 || search.new === "1"
      ? { new: true }
      : {},
  staticData: { pageSkeleton: "sections" },
});

const projectRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/projects/$slug",
  component: ProjectLayout,
  errorComponent: ProjectRouteError,
});

const projectIndexRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/",
  component: IssueListPage,
  validateSearch: (search) => issueSearchSchema.parse(search),
  staticData: { pageSkeleton: "list" },
});

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** The page owns the full viewport height; the shell must not append
     * flow content (the version footer) below it. */
    fillsViewport?: boolean;
    /** This route's own boundary answers when the project lookup misses: a
     * card's old address outlives the reader's access to the project that
     * once held it, and only this route knows where the card went. */
    resolvesProjectMiss?: boolean;
    /**
     * Which shape `AppShell` draws inside `<main>` while this route's data is
     * in flight. A declaration rather than a `pendingComponent` on purpose —
     * see the note over `createRouter` (T-265).
     */
    pageSkeleton?: PageSkeletonKind;
  }
}

const projectBoardRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "board",
  component: BoardPage,
  staticData: { fillsViewport: true, pageSkeleton: "board" },
});

const projectSearchRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "search",
  component: SearchPage,
  validateSearch: (search) => searchPageSchema.parse(search),
});

// Registered before issues/$number so the static segment wins the match.
const newIssueRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "issues/new",
  component: NewIssuePage,
  staticData: { pageSkeleton: "sections" },
});

const issueRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "issues/$number",
  component: IssueDetailPage,
  errorComponent: IssueRouteError,
  staticData: { resolvesProjectMiss: true, pageSkeleton: "detail" },
});

// Lazy: the spec view drags @pierre/diffs and the annotation layer along —
// none of which the rest of the app needs on first paint (T-24 direction).
// The search parser lives in its own module so the page stays unreachable
// from the route table.
const specViewRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "issues/$number/spec",
  component: lazyRouteComponent(
    () => import("@/pages/spec-view.tsx"),
    "SpecViewPage",
  ),
  validateSearch: parseSpecSearch,
  // Not lazy, unlike the component above: an error boundary that arrived in
  // the spec page's own chunk could not answer for a spec that is not here.
  errorComponent: SpecRouteError,
  staticData: { pageSkeleton: "detail" },
});

const projectSettingsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "settings",
  component: ProjectSettingsPage,
  staticData: { pageSkeleton: "sections" },
});

const inboxRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/inbox",
  component: InboxPage,
});

const profileSettingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/settings/profile",
  component: ProfileSettingsPage,
  staticData: { pageSkeleton: "sections" },
});

const agentsSettingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/settings/agents",
  component: AgentsSettingsPage,
  // ?state=deactivated selects the Deactivated segment; Active is the default
  // and stays out of the URL.
  validateSearch: (search): { state?: "deactivated" } =>
    search.state === "deactivated" ? { state: "deactivated" } : {},
  staticData: { pageSkeleton: "sections" },
});

const tokensSettingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/settings/tokens",
  component: TokensSettingsPage,
  staticData: { pageSkeleton: "sections" },
});

const cliAuthRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/cli-auth",
  component: CliAuthPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  authedRoute.addChildren([
    indexRoute,
    inboxRoute,
    projectsRoute,
    projectRoute.addChildren([
      projectIndexRoute,
      projectBoardRoute,
      projectSearchRoute,
      newIssueRoute,
      issueRoute,
      specViewRoute,
      projectSettingsRoute,
    ]),
    profileSettingsRoute,
    agentsSettingsRoute,
    tokensSettingsRoute,
    cliAuthRoute,
  ]),
]);

/**
 * Do not add `pendingComponent` to a route here, and do not add
 * `defaultPendingComponent` to this call. Either one makes the router build a
 * Suspense boundary of its own per route (`Match.js:39`, v1.170.25), nested
 * deeper than the one `AppShell` draws inside `<main>` and therefore the one
 * that actually catches — with the route's fallback, not the shell's. Which
 * of the two wins then takes reading the router's source to work out. One
 * boundary plus `staticData.pageSkeleton` leaves exactly one possible
 * behaviour (T-265).
 */
export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
