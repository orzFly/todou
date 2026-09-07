import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { groupMetadata, issueMetadataQuery } from "@/api/metadata.ts";
import { useCan } from "@/api/queries.ts";
import { MetadataDialog } from "@/components/issue/metadata-dialog.tsx";

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
 * An empty card shows `—` rather than hiding the section, so "this card has
 * none" and "this feature does not exist" stay tellable apart.
 */
export function MetadataSection({
  slug,
  issueNumber,
}: {
  slug: string;
  issueNumber: number;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const metadata = useQuery(issueMetadataQuery(slug, issueNumber));
  const canWrite = useCan(slug, "metadata.write");
  const groups = groupMetadata(metadata.data?.entries ?? []);
  // A reader looking at an empty card has nothing to open the dialog for; a
  // writer does, and the dialog is where every write lives.
  const empty = groups.length === 0;

  return (
    <section className="space-y-2" data-testid="metadata-sidebar">
      <h3 className="text-xs font-medium text-muted-foreground uppercase">
        Metadata
      </h3>
      {empty && !canWrite ? (
        <p className="text-sm text-muted-foreground">—</p>
      ) : (
        <button
          type="button"
          ref={trigger}
          data-testid="metadata-open"
          onClick={() => setOpen(true)}
          className="w-full space-y-1 rounded-md px-1.5 py-1 text-left hover:bg-muted"
          title="Show every key"
        >
          {empty ? (
            <span className="text-sm text-muted-foreground">—</span>
          ) : (
            groups.map((group) => (
              <span
                key={group.namespace}
                className="flex items-baseline gap-1.5"
              >
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
            ))
          )}
        </button>
      )}
      <MetadataDialog
        slug={slug}
        issueNumber={issueNumber}
        open={open}
        onOpenChange={setOpen}
        restoreFocusTo={trigger}
      />
    </section>
  );
}
