import type { BlockRef } from "@todou/shared";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { useAddBlockMutation, useRemoveBlockMutation } from "@/api/issues.ts";
import { useCan } from "@/api/queries.ts";
import { SidebarSection } from "@/components/issue/sidebar-section.tsx";
import { IssueLink } from "@/components/shared/issue-link.tsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Direction = "blocked_by" | "blocks";

/**
 * The two block sections of the sidebar (T-377).
 *
 * The refs themselves say what these sections are, so there is no sentence
 * explaining them. The one line that earns its place is the trash note on a
 * blocker — the reader cannot see from the ref that this edge will never
 * clear itself.
 */
export function BlocksSection({
  slug,
  issue,
  trashed,
}: {
  slug: string;
  issue: { number: number; blocked_by?: BlockRef[]; blocks?: BlockRef[] };
  trashed: boolean;
}) {
  const canBlock = useCan(slug, "issue.block");
  const blockedBy = issue.blocked_by ?? [];
  const blocking = issue.blocks ?? [];
  if (!canBlock && blockedBy.length === 0 && blocking.length === 0) return null;
  return (
    <>
      <BlockList
        slug={slug}
        issueNumber={issue.number}
        direction="blocked_by"
        name="blocked-by"
        title="Blocked by"
        refs={blockedBy}
        editable={canBlock && !trashed}
      />
      <BlockList
        slug={slug}
        issueNumber={issue.number}
        direction="blocks"
        name="blocks"
        title="Blocks"
        refs={blocking}
        editable={canBlock && !trashed}
      />
    </>
  );
}

function BlockList({
  slug,
  issueNumber,
  direction,
  name,
  title,
  refs,
  editable,
}: {
  slug: string;
  issueNumber: number;
  direction: Direction;
  name: string;
  title: string;
  refs: BlockRef[];
  editable: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");
  const add = useAddBlockMutation();
  const remove = useRemoveBlockMutation();
  if (refs.length === 0 && !editable) return null;

  const submit = () => {
    const ref = value.trim();
    if (ref === "") return;
    add.mutate(
      { slug, issueNumber, direction, ref },
      {
        onSuccess: () => {
          setValue("");
          setAdding(false);
        },
      },
    );
  };

  return (
    <SidebarSection
      name={name}
      title={title}
      testId={`blocks-${direction}`}
      action={
        editable && (
          <Button
            variant="ghost"
            size="icon-xs"
            // Not plain "Add": both sections carry this button, and up in the
            // header it no longer sits against the list that would say which.
            aria-label={`Add a ${title.toLowerCase()} entry`}
            onClick={() => setAdding((on) => !on)}
          >
            <PlusIcon className="size-3.5" />
          </Button>
        )
      }
    >
      {refs.length > 0 && (
        <ul className="space-y-1">
          {refs.map((ref) => (
            <li key={ref.edge_id} className="flex items-baseline gap-1">
              <span
                className={
                  ref.cleared_at === null
                    ? "min-w-0"
                    : "min-w-0 text-muted-foreground line-through"
                }
              >
                {ref.hidden || ref.project === null || ref.number === null ? (
                  <span className="text-muted-foreground italic">
                    a card you cannot see
                  </span>
                ) : (
                  <IssueLink
                    slug={ref.project}
                    number={ref.number}
                    pageSlug={slug}
                  />
                )}
              </span>
              {direction === "blocked_by" &&
                ref.blocker_deleted &&
                ref.cleared_at === null && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    (in the trash)
                  </span>
                )}
              {editable && (
                <button
                  type="button"
                  aria-label={`Remove this ${title.toLowerCase()} entry`}
                  className="ml-auto shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
                  disabled={remove.isPending}
                  onClick={() =>
                    remove.mutate({
                      slug,
                      issueNumber,
                      direction,
                      edgeId: ref.edge_id,
                    })
                  }
                >
                  <XIcon className="size-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && adding && (
        <div className="flex gap-1">
          <Input
            autoFocus
            value={value}
            // The server takes every spelling, so the placeholder shows the
            // one that is not obvious: another project's card.
            placeholder="#12 or other-project#12"
            disabled={add.isPending}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") setAdding(false);
            }}
          />
          <Button size="sm" onClick={submit} disabled={add.isPending}>
            Add
          </Button>
        </div>
      )}
    </SidebarSection>
  );
}
