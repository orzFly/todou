import { Outlet, useParams } from "@tanstack/react-router";
import { useProjectEvents } from "@/api/useProjectEvents.ts";
import { useRecordProjectVisit } from "@/api/useProjectOrder.ts";

// No project-name heading here: the shell's breadcrumb already carries it
// (T-88; the description stays on the projects overview).
export function ProjectLayout() {
  const { slug } = useParams({ from: "/authed/projects/$slug" });
  // Live updates for every page under this project (list/board/issue).
  useProjectEvents(slug);
  // Feed the frecency ordering (T-76).
  useRecordProjectVisit(slug);

  return <Outlet />;
}
