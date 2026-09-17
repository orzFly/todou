import { useQuery } from "@tanstack/react-query";
import { PencilIcon } from "lucide-react";
import { useRef, useState } from "react";
import { groupMetadata, issueMetadataQuery } from "@/api/metadata.ts";
import { useCan } from "@/api/queries.ts";
import { MetadataDialog } from "@/components/issue/metadata-dialog.tsx";
import { SidebarSection } from "@/components/issue/sidebar-section.tsx";
import { LoadFailure } from "@/components/shared/load-failure.tsx";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * A compact age, because the sidebar column is 240px wide and a locale
 * timestamp does not fit beside a name and a count. The exact moment is on
 * the `title`, which is where the rest of the app puts it too.
 *
 * Local to this surface on purpose: nothing else in the web app renders a
 * relative time, and one component needing one is not a reason to declare a
 * house style for it.
 */
export function compactAge(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/**
 * The "Metadata" sidebar section (T-282): one line per namespace, and the
 * whole block opens the same full dialog.
 *
 * Every line leads to the one dialog rather than to a filtered view of its
 * own namespace — these lines are a summary, not navigation.
 *
 * An empty card keeps the section, heading and all, rather than hiding it, so
 * "this card has none" and "this feature does not exist" stay tellable apart.
 */
export function MetadataSection({
  slug,
  issueNumber,
}: {
  slug: string;
  issueNumber: number;
}) {
  const [open, setOpen] = useState(false);
  // Two controls open the same dialog, so the one to hand focus back to is
  // whichever was clicked, not a ref bound to either of them.
  const opener = useRef<HTMLButtonElement>(null);
  const metadata = useQuery(issueMetadataQuery(slug, issueNumber));
  const canWrite = useCan(slug, "metadata.write");
  const groups = groupMetadata(metadata.data?.entries ?? []);
  const loading = !metadata.isSuccess && !metadata.isError;
  const failed = metadata.isError && groups.length === 0;
  // A bare section on this surface means "this card has none", so it renders
  // only once the query has said so — while in flight the section waits, and
  // a failure says itself instead (T-365).
  const empty = metadata.isSuccess && groups.length === 0;
  // The same gate the summary block below carries, because this button is a
  // second door into the same dialog: an unsettled or failed read offers no
  // way in, since a write made past one would be blind (T-365, T-376).
  const canOpen = !loading && !failed && (canWrite || groups.length > 0);

  return (
    <SidebarSection
      name="metadata"
      title="Metadata"
      testId="metadata-sidebar"
      action={
        canOpen && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Edit metadata"
            onClick={(event) => {
              opener.current = event.currentTarget;
              setOpen(true);
            }}
          >
            <PencilIcon className="size-3.5" />
          </Button>
        )
      }
    >
      {loading ? (
        <Skeleton className="h-4 w-16" data-testid="metadata-loading" />
      ) : failed ? (
        // The exit for a state that will not heal itself: refetch this one
        // query, and both ways into the dialog come back on their own.
        <LoadFailure
          message="Failed to load metadata."
          detail={metadata.error.message}
          onRetry={() => metadata.refetch()}
          retrying={metadata.isFetching}
        />
      ) : empty ? null : (
        <button
          type="button"
          data-testid="metadata-open"
          onClick={(event) => {
            opener.current = event.currentTarget;
            setOpen(true);
          }}
          className="w-full space-y-1 rounded-md px-1.5 py-1 text-left hover:bg-muted"
          title="Show every key"
        >
          {groups.map((group) => (
            <span key={group.namespace} className="flex items-baseline gap-1.5">
              <span className="truncate font-mono text-xs">
                {group.namespace}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {group.entries.length}
              </span>
              <span
                className="ml-auto shrink-0 text-[10.5px] text-muted-foreground"
                title={group.updatedAt}
              >
                {compactAge(group.updatedAt)}
              </span>
            </span>
          ))}
        </button>
      )}
      <MetadataDialog
        slug={slug}
        issueNumber={issueNumber}
        open={open}
        onOpenChange={setOpen}
        restoreFocusTo={opener}
      />
    </SidebarSection>
  );
}
