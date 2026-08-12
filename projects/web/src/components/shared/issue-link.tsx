import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleDotIcon, CircleSlashIcon } from "lucide-react";
import { issueRefQuery } from "@/api/issue-refs.ts";

/**
 * GitHub-style rich issue reference: status icon + title + muted #N once
 * the batched lookup lands, a plain #N link while it loads, and plain text
 * when the number matches no issue in the project.
 */
export function IssueLink({ slug, number }: { slug: string; number: number }) {
  const ref = useQuery(issueRefQuery(slug, number));

  if (ref.data === null) return <>#{number}</>;

  const item = ref.data;
  return (
    <Link
      to="/projects/$slug/issues/$number"
      params={{ slug, number: String(number) }}
      data-issue-link={number}
      className="font-medium hover:underline"
      title={
        item ? `#${number} ${item.title} (${item.status.name})` : undefined
      }
    >
      {item && (
        <>
          {item.status.category === "closed" ? (
            <CircleSlashIcon
              aria-hidden
              className="mr-0.5 inline size-3.5 align-[-0.185em]"
              style={{ color: item.status.color }}
            />
          ) : (
            <CircleDotIcon
              aria-hidden
              className="mr-0.5 inline size-3.5 align-[-0.185em]"
              style={{ color: item.status.color }}
            />
          )}
          {item.title}{" "}
        </>
      )}
      <span className="font-normal text-muted-foreground">#{number}</span>
    </Link>
  );
}
