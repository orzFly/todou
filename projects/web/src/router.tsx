import { useQuery } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
} from "@tanstack/react-router";
import { meQuery } from "@/api/queries.ts";
import { AppShell } from "@/components/shell.tsx";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { LoginPage } from "@/pages/login.tsx";
import { ProjectsPage } from "@/pages/projects.tsx";

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
    if (status === 401) return <Navigate to="/login" />;
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

// Placeholder pages — filled in by the list/kanban/issue/settings phases.
function ComingSoon({ what }: { what: string }) {
  return (
    <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
      {what} — under construction 🚧🥔
    </div>
  );
}

const projectListRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/projects/$slug",
  component: () => <ComingSoon what="Issue list" />,
});

const projectBoardRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/projects/$slug/board",
  component: () => <ComingSoon what="Kanban board" />,
});

const issueRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/projects/$slug/issues/$number",
  component: () => <ComingSoon what="Issue detail" />,
});

const projectSettingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/projects/$slug/settings",
  component: () => <ComingSoon what="Project settings" />,
});

const agentsSettingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/settings/agents",
  component: () => <ComingSoon what="Agent management" />,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  authedRoute.addChildren([
    indexRoute,
    projectsRoute,
    projectListRoute,
    projectBoardRoute,
    issueRoute,
    projectSettingsRoute,
    agentsSettingsRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
