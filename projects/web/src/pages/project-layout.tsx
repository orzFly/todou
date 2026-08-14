import { Outlet, useParams } from "@tanstack/react-router";
import { useRecordProjectVisit } from "@/api/useProjectOrder.ts";

// No project-name heading here: the shell's breadcrumb already carries it
// (T-88; the description stays on the projects overview). Live updates ride
// the shell's user-level stream (T-122), not a per-project subscription.
export function ProjectLayout() {
  const { slug } = useParams({ from: "/authed/projects/$slug" });
  // Feed the frecency ordering (T-76).
  useRecordProjectVisit(slug);

  return <Outlet />;
}
