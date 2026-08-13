import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import type { Project } from "@todou/shared";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { meQuery } from "@/api/queries.ts";
import {
  hasNewBadge,
  isNeverVisited,
  orderProjects,
  parseVisits,
  recordVisit,
  visitsKey,
} from "@/lib/project-visits.ts";

export type OrderedProject = {
  project: Project;
  neverVisited: boolean;
  isNew: boolean;
};

function subscribeToStorage(callback: () => void) {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

/**
 * Frecency ordering shared by the project switcher and the projects home
 * (#76) — one comparator, so both always show the same sequence. The
 * snapshot stays the raw string: parsing in the snapshot would mint a new
 * object identity per call and spin useSyncExternalStore forever.
 */
export function useProjectOrder(projects: Project[]): OrderedProject[] {
  const me = useQuery(meQuery);
  const userId = me.data?.id ?? "anon";
  const raw = useSyncExternalStore(subscribeToStorage, () => {
    try {
      return localStorage.getItem(visitsKey(userId));
    } catch {
      return null;
    }
  });
  return useMemo(() => {
    const data = parseVisits(raw);
    const now = Date.now();
    return orderProjects(projects, data, now).map((project) => ({
      project,
      neverVisited: isNeverVisited(data, project.slug),
      isNew: hasNewBadge(project, data, now),
    }));
  }, [projects, raw]);
}

/**
 * Count a visit on entering the project and on in-project navigation;
 * recordVisit's 30-minute window collapses the stream into real visits.
 */
export function useRecordProjectVisit(slug: string) {
  const me = useQuery(meQuery);
  const userId = me.data?.id;
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // biome-ignore lint/correctness/useExhaustiveDependencies(pathname): in-project navigation must re-attempt the visit; the 30-minute window dedupes
  useEffect(() => {
    if (userId === undefined) return;
    recordVisit(userId, slug, Date.now());
  }, [userId, slug, pathname]);
}
