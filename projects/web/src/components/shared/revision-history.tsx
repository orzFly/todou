import { hashKey, useQuery } from "@tanstack/react-query";
import type { Revision, RevisionPage } from "@todou/shared";
import { WrapTextIcon } from "lucide-react";
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
import { cn } from "@/lib/utils.ts";

/**
 * Its own key, not the spec diff's `todou-spec-diff-wrap`: the two surfaces
 * were asked to remember separately, so turning wrapping off here leaves a
 * spec comparison alone and the other way round (T-425).
 */
const HISTORY_WRAP_STORAGE_KEY = "todou-edit-history-wrap";

// An edit history holds prose — a comment or a description — so wrapping,
// not horizontal scrolling, is the posture it opens in until the reader says
// otherwise, as the spec diff decided for the same reason (T-143).
function readHistoryWrap(): boolean {
  try {
    return localStorage.getItem(HISTORY_WRAP_STORAGE_KEY) !== "off";
  } catch {
    // storage may be unavailable (private mode); fall through
    return true;
  }
}

function writeHistoryWrap(wrap: boolean) {
  try {
    localStorage.setItem(HISTORY_WRAP_STORAGE_KEY, wrap ? "on" : "off");
  } catch {
    // preference just won't persist
  }
}

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
                    className="flex w-full cursor-pointer items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                    onClick={() => setSelected(revision)}
                  >
                    <UserChip
                      user={revision.actor}
                      nameClassName="font-medium text-foreground/80"
                      link={false}
                    />
                    <AgentContextBadge
                      context={revision.agent_context}
                      className="shrink self-center"
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
          {/* Mounted only while a revision is selected, which is what makes
              the saved wrapping choice a per-opening read: the `(edited)`
              marker outside this dialog stays mounted for the life of the
              comment, so reading there would pin the choice to whatever it
              was when the page loaded. The key covers one case the list
              cannot currently produce — one revision replacing another with
              no close in between; `U4b` in the tests says so and will fail
              if that stops being true. */}
          {selected && (
            <RevisionDialog
              key={selected.id}
              revision={selected}
              filename={filename}
              label={label}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function RevisionDialog({
  revision,
  filename,
  label,
}: {
  revision: Revision;
  filename: string;
  label: string;
}) {
  const [wrap, setWrap] = useState(readHistoryWrap);
  return (
    <>
      {/* `pr-8` clears the dialog's own Close, which is absolutely positioned
          over this row's right end rather than laid out in it. */}
      <DialogHeader className="flex-row items-center gap-3 pr-8 text-left">
        <DialogTitle className="min-w-0 flex-1">
          Edit history — {label}
        </DialogTitle>
        <button
          type="button"
          aria-pressed={wrap}
          aria-label="wrap long lines"
          title="Wrap long lines instead of scrolling horizontally"
          onClick={() => {
            // State first: a storage write that throws must not cost the
            // reader the toggle they just asked for.
            setWrap(!wrap);
            writeHistoryWrap(!wrap);
          }}
          // The spec diff toolbar's `wrap` pill, spelled out again rather than
          // imported: its home is a module the whole heavyweight spec page
          // hangs off, and this dialog is reachable from every issue.
          className={cn(
            "inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-full border px-2.5 text-xs",
            wrap
              ? "border-emerald-600/60 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400"
              : "text-muted-foreground hover:border-foreground/50",
          )}
        >
          <WrapTextIcon className="size-3.5" />
          wrap
        </button>
      </DialogHeader>
      <RevisionDiff revision={revision} filename={filename} wrap={wrap} />
    </>
  );
}

function RevisionDiff({
  revision,
  filename,
  wrap,
}: {
  revision: Revision;
  filename: string;
  wrap: boolean;
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
      // pierre's own wrapping, which keeps gutter and content on one subgrid
      // so a soft-wrapped line still carries exactly one line number. Host
      // CSS could not do this: the lines live in pierre's shadow root.
      // "scroll" is pierre's default, so turning wrapping off is the diff
      // this dialog rendered before T-425, option for option.
      overflow: wrap ? ("wrap" as const) : ("scroll" as const),
      preferredHighlighter: PIERRE_HIGHLIGHTER,
    }),
    [syntaxTheme, wrap],
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
