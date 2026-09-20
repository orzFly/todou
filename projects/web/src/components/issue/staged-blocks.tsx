import { useQueryClient } from "@tanstack/react-query";
import { PlusIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";
import { invalidateAfterBlock } from "@/api/issues.ts";
import { api } from "@/api/queries.ts";
import { RefPicker } from "@/components/issue/ref-picker.tsx";
import { SidebarSection } from "@/components/issue/sidebar-section.tsx";
import { IssueLink } from "@/components/shared/issue-link.tsx";
import { Button } from "@/components/ui/button";

type Direction = "blocked_by" | "blocks";

export type StagedBlock = {
  key: number;
  direction: Direction;
  /** What the picker handed over, and what the server is sent verbatim. */
  ref: string;
  /**
   * Where that ref points, so the row can be drawn as the card it names
   * rather than as the string that was typed. Null for a hand-typed ref the
   * picker matched to no candidate — those rows show the ref as written, and
   * whether it resolves to anything is the server's answer at submit time.
   */
  target: { slug: string; number: number } | null;
};

let stagedKey = 0;

export type StagedBlocks = {
  staged: StagedBlock[];
  stage: (
    direction: Direction,
    ref: string,
    target: { slug: string; number: number } | null,
  ) => void;
  remove: (key: number) => void;
  clear: () => void;
  createAll: (slug: string, issueNumber: number) => Promise<void>;
};

/**
 * Block edges picked before the card that carries them exists (T-458), held
 * locally until `createAll` hangs them on the number the server hands back.
 *
 * Same shape as `useStagedFiles`, and for the same reason: a draft that is
 * abandoned must leave nothing behind, and a submit that fails halfway must
 * be resumable by pressing the button again. Edges drop out of the list as
 * they land, so the retry after a failure further down only sends what is
 * still here.
 */
export function useStagedBlocks(): StagedBlocks {
  const [staged, setStaged] = useState<StagedBlock[]>([]);
  const queryClient = useQueryClient();
  const stagedRef = useRef(staged);
  stagedRef.current = staged;

  function stage(
    direction: Direction,
    ref: string,
    target: { slug: string; number: number } | null,
  ) {
    setStaged((prev) => [
      ...prev,
      { key: stagedKey++, direction, ref, target },
    ]);
  }

  function remove(key: number) {
    setStaged((prev) => prev.filter((p) => p.key !== key));
  }

  function clear() {
    setStaged([]);
  }

  /**
   * Declare every staged edge on the created card. Throws on the first
   * failure, naming the ref that failed: the card itself is already written
   * by then, so the message has to say which edge is missing from it rather
   * than only that something went wrong.
   */
  async function createAll(slug: string, issueNumber: number): Promise<void> {
    let touchedServer = false;
    try {
      for (const item of stagedRef.current) {
        try {
          if (item.direction === "blocked_by") {
            await api.addIssueBlockedBy(slug, issueNumber, item.ref);
          } else {
            await api.addIssueBlocks(slug, issueNumber, item.ref);
          }
        } catch (error) {
          throw new Error(`${item.ref}: ${(error as Error).message}`);
        }
        touchedServer = true;
        setStaged((prev) => prev.filter((p) => p.key !== item.key));
      }
    } finally {
      if (touchedServer) invalidateAfterBlock(queryClient, slug, issueNumber);
    }
  }

  return { staged, stage, remove, clear, createAll };
}

/**
 * The two block sections of the new-issue sidebar, in the card page's own
 * order and shape. Not `BlocksSection`: that one renders `BlockRef`s, whose
 * `edge_id`, `cleared_at`, `blocker_deleted` and `hidden` all describe an
 * edge the server has already stored, and none of the four can exist here.
 */
export function StagedBlockSections({
  slug,
  blocks,
  disabled,
}: {
  slug: string;
  blocks: StagedBlocks;
  disabled: boolean;
}) {
  return (
    <>
      <StagedBlockList
        slug={slug}
        blocks={blocks}
        direction="blocked_by"
        name="blocked-by"
        title="Blocked by"
        disabled={disabled}
      />
      <StagedBlockList
        slug={slug}
        blocks={blocks}
        direction="blocks"
        name="blocks"
        title="Blocks"
        disabled={disabled}
      />
    </>
  );
}

function StagedBlockList({
  slug,
  blocks,
  direction,
  name,
  title,
  disabled,
}: {
  slug: string;
  blocks: StagedBlocks;
  direction: Direction;
  name: string;
  title: string;
  disabled: boolean;
}) {
  const rows = blocks.staged.filter((row) => row.direction === direction);
  return (
    <SidebarSection
      name={name}
      title={title}
      testId={`staged-blocks-${direction}`}
      action={
        <RefPicker
          slug={slug}
          // Both directions at once, unlike the card page's per-section
          // exclusion: one card named in both lists is a two-card cycle, and
          // the server refuses it at submit time — by which point this card
          // exists and the reader is looking at a failure instead of a form.
          exclude={blocks.staged.flatMap((row) =>
            row.target === null ? [] : [row.target],
          )}
          pending={disabled}
          onPick={async (ref, target) => {
            blocks.stage(direction, ref, target);
          }}
          trigger={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Add a ${title.toLowerCase()} entry`}
            >
              <PlusIcon className="size-3.5" />
            </Button>
          }
        />
      }
    >
      {rows.length > 0 && (
        <ul className="space-y-1">
          {rows.map((row) => (
            <li key={row.key} className="flex items-baseline gap-1">
              <span className="min-w-0">
                {row.target === null ? (
                  <span className="font-mono text-xs">{row.ref}</span>
                ) : (
                  <IssueLink
                    slug={row.target.slug}
                    number={row.target.number}
                    pageSlug={slug}
                  />
                )}
              </span>
              <button
                type="button"
                aria-label={`Remove this ${title.toLowerCase()} entry`}
                className="ml-auto shrink-0 cursor-pointer text-muted-foreground hover:text-foreground disabled:opacity-50"
                disabled={disabled}
                onClick={() => blocks.remove(row.key)}
              >
                <XIcon className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </SidebarSection>
  );
}
