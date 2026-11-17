import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { issueQuery } from "@/api/issues.ts";
import { useRefPlacement } from "@/api/prefs.ts";
import { IssueStatusIcon } from "@/components/shared/issue-link.tsx";
import { useReturnLinkState } from "@/components/shared/return-context.tsx";

/**
 * A blocker in the trash, laid out like the IssueLink beside it. The normal
 * reference batch excludes trash, so the title comes from the detail
 * endpoint, which applies trash read permissions and shares its cache with
 * the issue page.
 */
export function TrashedBlocker({
  slug,
  number,
  spelling,
  pageSlug,
}: {
  slug: string;
  number: number;
  /** The edge's own spelling, already in the blocker project's format. */
  spelling: string | null;
  pageSlug: string;
}) {
  const issue = useQuery({ ...issueQuery(slug, number), staleTime: 60_000 });
  const refLeads = useRefPlacement("reference") === "before";
  const returnState = useReturnLinkState();
  const spelled = `${slug === pageSlug ? "" : `${slug}/`}${spelling ?? `#${number}`}`;
  if (!issue.data) return <span>{spelled}</span>;
  const { title, status } = issue.data;
  return (
    <Link
      to="/projects/$slug/issues/$number"
      params={{ slug, number: String(number) }}
      state={returnState}
      data-issue-link={number}
      data-issue-project={slug === pageSlug ? undefined : slug}
      className="font-medium hover:underline"
      title={
        refLeads
          ? `${spelled} ${title} (${status.name})`
          : `${title} ${spelled} (${status.name})`
      }
    >
      <IssueStatusIcon
        status={status}
        className="mr-0.5 inline size-3.5 align-middle"
      />
      {refLeads && (
        <span className="font-normal text-muted-foreground">{spelled} </span>
      )}
      {title}
      {!refLeads && (
        <span className="font-normal text-muted-foreground"> {spelled}</span>
      )}
    </Link>
  );
}
