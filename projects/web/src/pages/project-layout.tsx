import { useQuery } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  useNavigate,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { projectQuery } from "@/api/queries.ts";
import { useRecordProjectVisit } from "@/api/useProjectOrder.ts";
import { Button } from "@/components/ui/button";

// No project-name heading here: the shell's breadcrumb already carries it
// (T-88; the description stays on the projects overview). Live updates ride
// the shell's user-level stream (T-122), not a per-project subscription.
export function ProjectLayout() {
  const { slug } = useParams({ from: "/authed/projects/$slug" });
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Non-blocking: the page renders against the requested slug, which the
  // server resolves either way, and swaps the URL once the answer lands.
  // Errors are thrown rather than left in query state so the route's
  // errorComponent can answer for them — an unresolvable slug used to
  // render nothing at all.
  const project = useQuery({ ...projectQuery(slug), throwOnError: true });
  const canonical = project.data?.slug;

  useEffect(() => {
    if (canonical === undefined || canonical === slug) return;
    // Only the project segment moves; deep links keep their tail. replace,
    // because the retired spelling is not a place to go back to.
    navigate({
      to: pathname.replace(
        `/projects/${encodeURIComponent(slug)}`,
        `/projects/${encodeURIComponent(canonical)}`,
      ),
      replace: true,
    });
  }, [canonical, slug, pathname, navigate]);

  // Feed the frecency ordering (T-76) — under the canonical name, so a
  // retired slug never earns its own entry in the switcher's history.
  useRecordProjectVisit(canonical);

  return <Outlet />;
}

/**
 * A slug that resolves to nothing — never used, or retired and since taken
 * by a project this viewer cannot read. Anything else is not ours to
 * explain, so it goes back up to the router's own error boundary.
 */
export function ProjectRouteError({ error }: { error: Error }) {
  if ((error as { status?: number }).status !== 404) throw error;
  return (
    <div className="rounded-lg border border-dashed p-10 text-center">
      <p className="text-muted-foreground">
        This project does not exist, or you do not have access to it.
      </p>
      <Button asChild size="sm" className="mt-4">
        <Link to="/projects">All projects</Link>
      </Button>
    </div>
  );
}
