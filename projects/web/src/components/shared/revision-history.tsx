import { hashKey, useQuery } from "@tanstack/react-query";
import type { Revision, RevisionPage } from "@todou/shared";
import { Suspense, useMemo, useState } from "react";
import { AgentContextBadge } from "@/components/shared/agent-badge.tsx";
import {
  LoadFailure,
  RefreshFailure,
} from "@/components/shared/load-failure.tsx";
import {
  LazyMultiFileDiff,
  PIERRE_HIGHLIGHTER,
  PIERRE_THEME_TYPE,
  useSyntaxTheme,
} from "@/components/shared/pierre.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useReadFailure } from "@/lib/use-read-failure.ts";

/** Both sides of one edit as diff inputs; .md names give markdown highlighting. */
export function toDiffFiles(revision: Revision, filename: string) {
  return {
    oldFile: { name: filename, contents: revision.body_before },
    newFile: { name: filename, contents: revision.body_after },
  };
}

type RevisionHistoryProps = {
  label: string;
  editedAt: string;
  filename: string;
  queryKey: Array<string | number>;
  fetchRevisions: () => Promise<RevisionPage>;
};

/**
 * GitHub-style edit history: a clickable "(edited)" marker opening the
 * revision list, each entry opening a diff dialog. History is fetched only
 * when the popover opens, so it is always fresh without invalidation
 * wiring. An edited item with no revisions predates history tracking.
 */
export function RevisionHistory(props: RevisionHistoryProps) {
  return <KeyedRevisionHistory key={hashKey(props.queryKey)} {...props} />;
}

function KeyedRevisionHistory({
  label,
  editedAt,
  filename,
  queryKey,
  fetchRevisions,
}: RevisionHistoryProps) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Revision | null>(null);
  const history = useQuery({
    queryKey,
    queryFn: fetchRevisions,
    enabled: open,
    staleTime: 0,
  });
  const data = history.data;
  const hasContent = data !== undefined;
  const { replace, notice } = useReadFailure(
    [history.isError ? history.error : null],
    hasContent,
    queryKey,
  );

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className="shrink-0 cursor-pointer text-xs whitespace-nowrap text-muted-foreground/70 hover:underline"
          title={editedAt}
        >
          (edited)
        </PopoverTrigger>
        <PopoverContent className="max-h-80 w-96 overflow-y-auto">
          {replace ? (
            <div className="px-2 py-1.5">
              <LoadFailure
                message={`Failed to load history: ${replace}`}
                detail={replace}
                onRetry={() => history.refetch()}
                retrying={history.isFetching}
                size="xs"
              />
            </div>
          ) : data === undefined ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              Loading history…
            </p>
          ) : (
            <>
              {notice && (
                <div className="px-2 py-1.5">
                  <RefreshFailure
                    what="this edit history"
                    detail={notice}
                    onRetry={() => history.refetch()}
                    retrying={history.isFetching}
                    size="xs"
                  />
                </div>
              )}
              {data.items.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground italic">
                  This edit history predates tracking.
                </p>
              ) : (
                data.items.map((revision) => (
                  <button
                    key={revision.id}
                    type="button"
                    className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                    onClick={() => setSelected(revision)}
                  >
                    <UserChip
                      user={revision.actor}
                      nameClassName="font-medium text-foreground/80"
                      link={false}
                    />
                    <AgentContextBadge
                      context={revision.agent_context}
                      className="shrink"
                    />
                    <span
                      className="ml-auto shrink-0 text-xs text-muted-foreground/70"
                      title={revision.created_at}
                    >
                      {new Date(revision.created_at).toLocaleString()}
                    </span>
                  </button>
                ))
              )}
            </>
          )}
        </PopoverContent>
      </Popover>
      <Dialog
        open={selected !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setSelected(null);
        }}
      >
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Edit history — {label}</DialogTitle>
          </DialogHeader>
          {selected && <RevisionDiff revision={selected} filename={filename} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function RevisionDiff({
  revision,
  filename,
}: {
  revision: Revision;
  filename: string;
}) {
  const { oldFile, newFile } = useMemo(
    () => toDiffFiles(revision, filename),
    [revision, filename],
  );
  const syntaxTheme = useSyntaxTheme();
  const options = useMemo(
    () => ({
      theme: syntaxTheme,
      themeType: PIERRE_THEME_TYPE,
      diffStyle: "unified" as const,
      preferredHighlighter: PIERRE_HIGHLIGHTER,
    }),
    [syntaxTheme],
  );
  return (
    <div className="max-h-[70vh] overflow-auto rounded-md">
      <Suspense
        fallback={
          <p className="py-8 text-center text-sm text-muted-foreground">
            Loading diff…
          </p>
        }
      >
        <LazyMultiFileDiff
          oldFile={oldFile}
          newFile={newFile}
          options={options}
        />
      </Suspense>
    </div>
  );
}
