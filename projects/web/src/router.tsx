import { useQuery } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
} from "@tanstack/react-router";
import { issueSearchSchema } from "@/api/issues.ts";
import { meQuery } from "@/api/queries.ts";
import { AppShell } from "@/components/shell.tsx";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { AgentsSettingsPage } from "@/pages/agents-settings.tsx";
import { BoardPage } from "@/pages/board.tsx";
import { CliAuthPage } from "@/pages/cli-auth.tsx";
import { IssueDetailPage } from "@/pages/issue-detail.tsx";
import { IssueListPage } from "@/pages/issue-list.tsx";
import { LoginPage } from "@/pages/login.tsx";
import { ProjectLayout } from "@/pages/project-layout.tsx";
import { ProjectSettingsPage } from "@/pages/project-settings.tsx";
import { ProjectsPage } from "@/pages/projects.tsx";
import { TokensSettingsPage } from "@/pages/tokens-settings.tsx";

const rootRoute = createRootRoute({
  component: () => (
    <>
      <Outlet />
      <Toaster position="bottom-right" />
    </>
  ),
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
  validateSearch: (search): { redirect?: string } =>
    typeof search.redirect === "string" ? { redirect: search.redirect } : {},
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
});

const projectRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/projects/$slug",
  component: ProjectLayout,
});

const projectIndexRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/",
  component: IssueListPage,
  validateSearch: (search) => issueSearchSchema.parse(search),
});

const projectBoardRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "board",
  component: BoardPage,
});

const issueRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "issues/$number",
  component: IssueDetailPage,
});

const projectSettingsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "settings",
  component: ProjectSettingsPage,
});

const agentsSettingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/settings/agents",
  component: AgentsSettingsPage,
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
    projectsRoute,
    projectRoute.addChildren([
      projectIndexRoute,
      projectBoardRoute,
      issueRoute,
      projectSettingsRoute,
    ]),
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
