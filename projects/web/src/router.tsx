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
import { AppShell } from "@/components/shell.tsx";
import { TitleController } from "@/components/title-controller.tsx";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { parseSpecSearch } from "@/lib/spec-search.ts";
import { AgentsSettingsPage } from "@/pages/agents-settings.tsx";
import { BoardPage } from "@/pages/board.tsx";
import { CliAuthPage } from "@/pages/cli-auth.tsx";
import { InboxPage } from "@/pages/inbox.tsx";
import { IssueDetailPage } from "@/pages/issue-detail.tsx";
import { IssueListPage } from "@/pages/issue-list.tsx";
import { IssueRouteError } from "@/pages/issue-route-error.tsx";
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
  if (me.isPending) {
    return (
      <div className="mx-auto max-w-6xl space-y-4 px-4 py-10">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
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
      <Outlet />
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
});

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** The page owns the full viewport height; the shell must not append
     * flow content (the version footer) below it. */
    fillsViewport?: boolean;
  }
}

const projectBoardRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "board",
  component: BoardPage,
  staticData: { fillsViewport: true },
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
});

const issueRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "issues/$number",
  component: IssueDetailPage,
  errorComponent: IssueRouteError,
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
});

const projectSettingsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "settings",
  component: ProjectSettingsPage,
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
});

const agentsSettingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/settings/agents",
  component: AgentsSettingsPage,
  // ?state=deactivated selects the Deactivated segment; Active is the default
  // and stays out of the URL.
  validateSearch: (search): { state?: "deactivated" } =>
    search.state === "deactivated" ? { state: "deactivated" } : {},
});

const tokensSettingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/settings/tokens",
  component: TokensSettingsPage,
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

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
