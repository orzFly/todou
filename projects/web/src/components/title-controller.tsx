import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { formatRef } from "@todou/shared";
import { useEffect } from "react";
import { issueQuery } from "@/api/issues.ts";
import { prefsQuery, useRefPlacement } from "@/api/prefs.ts";
import { projectQuery } from "@/api/queries.ts";
import { referenceConfigQuery, useRefPrefix } from "@/api/references.ts";
import { issueTitleText } from "@/components/shared/issue-title.tsx";

export const FALLBACK = "todou 🥔";

/** `undefined` marks a part whose query has not settled yet. */
export type TitleParts = {
  /** The slug when the project itself could not be loaded. */
  projectName: string | undefined;
  issueNumber?: number;
  /** Null when the issue could not be loaded: the tab names it by its ref. */
  issueTitle: string | null | undefined;
  refPrefix: string | null | undefined;
  refLeads: boolean | undefined;
  login?: string;
};

/**
 * A title only once every part in it has arrived. Filling a missing part in
 * with a stand-in (the slug for the project's name, `#` for its prefix) puts
 * one title in the tab and then replaces it with another.
 */
function whole(
  text: TemplateStringsArray,
  ...parts: (string | undefined)[]
): string | undefined {
  if (parts.includes(undefined)) return undefined;
  return text.reduce((title, piece, i) => `${title}${parts[i - 1]}${piece}`);
}

/** The tab's title for a route, or `undefined` while a part of it is loading. */
export function titleFor(
  routeId: string | undefined,
  ctx: TitleParts,
): string | undefined {
  const ref =
    ctx.refPrefix === undefined
      ? undefined
      : formatRef(ctx.refPrefix, ctx.issueNumber ?? 0);
  const issueLabel =
    ctx.issueTitle === null
      ? ref
      : ctx.refLeads === undefined
        ? undefined
        : ctx.refLeads
          ? whole`${ref} ${ctx.issueTitle}`
          : whole`${ctx.issueTitle} ${ref}`;
  switch (routeId) {
    case "/authed/projects":
      return "Projects · todou";
    case "/authed/projects/$slug/":
      return whole`${ctx.projectName} · issues`;
    case "/authed/projects/$slug/board":
      return whole`${ctx.projectName} · board`;
    case "/authed/projects/$slug/insights":
      return whole`${ctx.projectName} · insights`;
    case "/authed/projects/$slug/search":
      return whole`${ctx.projectName} · search`;
    case "/authed/projects/$slug/settings/":
      return whole`${ctx.projectName} · settings`;
    case "/authed/projects/$slug/settings/members":
      return whole`${ctx.projectName} · members`;
    case "/authed/projects/$slug/settings/statuses":
      return whole`${ctx.projectName} · statuses`;
    case "/authed/projects/$slug/settings/labels":
      return whole`${ctx.projectName} · labels`;
    case "/authed/projects/$slug/settings/references":
      return whole`${ctx.projectName} · references`;
    case "/authed/projects/$slug/issues/new":
      return whole`New issue · ${ctx.projectName}`;
    case "/authed/projects/$slug/issues/$number":
      return whole`${issueLabel} · ${ctx.projectName}`;
    case "/authed/projects/$slug/issues/$number/spec":
      return whole`${ref} spec · ${ctx.projectName}`;
    case "/authed/inbox":
      return "Inbox · todou";
    case "/authed/inbox/muted":
      return "Muted · todou";
    case "/authed/settings/profile":
      return "Profile · todou";
    case "/authed/settings/appearance":
      return "Appearance · todou";
    case "/authed/settings/inbox":
      return "Inbox settings · todou";
    case "/authed/settings/agents":
      return "Agents · todou";
    case "/authed/settings/agents/$login":
      return `${ctx.login ?? ""} · Agents · todou`;
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

/** A query's value once its first fetch has settled, either way. */
function settled<T>(query: { isLoading: boolean }, value: T): T | undefined {
  return query.isLoading ? undefined : value;
}

/**
 * Keeps document.title in step with the route (T-62). Centralized here (not
 * per-page) so every route is covered from one table, and reads through the
 * same query cache the pages render from — SSE-driven renames of issues or
 * projects reach the browser tab with no extra fetches.
 *
 * While a title's parts are loading the tab keeps the title it has, so it
 * changes once per page.
 */
export function TitleController() {
  const match = useRouterState({
    select: (s) => s.matches[s.matches.length - 1],
  });
  const {
    slug,
    number: numberParam,
    login,
  } = (match?.params ?? {}) as {
    slug?: string;
    number?: string;
    login?: string;
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

  // Second observers on the queries these hooks read: the hooks hand back a
  // default while loading, indistinguishable from the settled value.
  const refConfig = useQuery({
    ...referenceConfigQuery(slug ?? ""),
    enabled: slug != null,
  });
  const prefs = useQuery(prefsQuery);
  const refPrefix = useRefPrefix(slug ?? undefined);
  const refLeads = useRefPlacement("detail") === "before";
  const title = titleFor(match?.routeId, {
    projectName: settled(project, project.data?.name ?? slug ?? ""),
    issueNumber,
    issueTitle: settled(issue, issue.data ? issueTitleText(issue.data) : null),
    refPrefix: settled(refConfig, refPrefix),
    refLeads: settled(prefs, refLeads),
    login,
  });

  useEffect(() => {
    if (title !== undefined) document.title = title;
  }, [title]);

  return null;
}
