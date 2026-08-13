import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { formatRef } from "@todou/shared";
import { useEffect } from "react";
import { issueQuery } from "@/api/issues.ts";
import { projectQuery } from "@/api/queries.ts";
import { useRefPrefix } from "@/api/references.ts";

const FALLBACK = "todou 🥔";

function titleFor(
  routeId: string | undefined,
  ctx: {
    projectName: string;
    issueNumber?: number;
    issueTitle?: string;
    refPrefix: string | null;
  },
): string {
  switch (routeId) {
    case "/authed/projects":
      return "Projects · todou";
    case "/authed/projects/$slug/":
      return `${ctx.projectName} · issues`;
    case "/authed/projects/$slug/board":
      return `${ctx.projectName} · board`;
    case "/authed/projects/$slug/settings":
      return `${ctx.projectName} · settings`;
    case "/authed/projects/$slug/issues/new":
      return `New issue · ${ctx.projectName}`;
    case "/authed/projects/$slug/issues/$number":
      return `${formatRef(ctx.refPrefix, ctx.issueNumber ?? 0)}${ctx.issueTitle ? ` ${ctx.issueTitle}` : ""} · ${ctx.projectName}`;
    case "/authed/projects/$slug/issues/$number/spec":
      return `${formatRef(ctx.refPrefix, ctx.issueNumber ?? 0)} spec · ${ctx.projectName}`;
    case "/authed/settings/profile":
      return "Profile · todou";
    case "/authed/settings/agents":
      return "Agents · todou";
    case "/authed/settings/tokens":
      return "Personal tokens · todou";
    case "/authed/cli-auth":
      return "CLI auth · todou";
    case "/login":
      return "Log in · todou";
    default:
      return FALLBACK;
  }
}

/**
 * Keeps document.title in step with the route (T-62). Centralized here (not
 * per-page) so every route is covered from one table, and reads through the
 * same query cache the pages render from — SSE-driven renames of issues or
 * projects reach the browser tab with no extra fetches.
 */
export function TitleController() {
  const match = useRouterState({
    select: (s) => s.matches[s.matches.length - 1],
  });
  const { slug, number: numberParam } = (match?.params ?? {}) as {
    slug?: string;
    number?: string;
  };
  const issueNumber = numberParam ? Number(numberParam) : undefined;

  const project = useQuery({
    ...projectQuery(slug ?? ""),
    enabled: slug != null,
  });
  const issue = useQuery({
    ...issueQuery(slug ?? "", issueNumber ?? 0),
    enabled:
      slug != null && issueNumber != null && Number.isFinite(issueNumber),
  });

  const refPrefix = useRefPrefix(slug ?? undefined);
  const title = titleFor(match?.routeId, {
    projectName: project.data?.name ?? slug ?? "",
    issueNumber,
    issueTitle: issue.data?.title,
    refPrefix,
  });

  useEffect(() => {
    document.title = title;
  }, [title]);

  return null;
}
