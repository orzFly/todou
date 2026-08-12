import type { SelectedLineRange } from "@pierre/diffs";
import { MultiFileDiff } from "@pierre/diffs/react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import type { SpecCommentItem, SpecFile, SpecInfo } from "@todou/shared";
import { diffLines } from "diff";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  FileTextIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/queries.ts";
import { specCommentsQuery, specFilesQuery, specQuery } from "@/api/spec.ts";
import { SpecStatusBadge } from "@/components/issue/spec-block.tsx";
import {
  PIERRE_THEME,
  PIERRE_THEME_TYPE,
} from "@/components/shared/pierre.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import {
  AnnotatedMarkdown,
  type DisplayedAnnotation,
} from "@/components/spec/annotated-markdown.tsx";
import { ReviewSubmitDialog } from "@/components/spec/review-submit.tsx";
import {
  type ComposerStaging,
  SpecComposer,
} from "@/components/spec/spec-composer.tsx";
import {
  DiffstatBar,
  StatNumbers,
} from "@/components/timeline/spec-version-card.tsx";
import { Button } from "@/components/ui/button";
import { changedLineRanges } from "@/lib/spec-changes.ts";
import { useSpecReviewDrafts } from "@/lib/spec-drafts.ts";
import {
  computeVersionStats,
  type SpecFileStat,
} from "@/lib/spec-version-stats.ts";
import { cn } from "@/lib/utils.ts";

export function SpecViewPage() {
  const { slug, number: numberParam } = useParams({
    from: "/authed/projects/$slug/issues/$number/spec",
  });
  const issueNumber = Number(numberParam);
  const spec = useSuspenseQuery(specQuery(slug, issueNumber));

  if (spec.data === null) {
    return (
      <div className="mx-auto max-w-lg py-20 text-center text-muted-foreground">
        <p>This issue has no spec yet.</p>
        <Button asChild variant="link">
          <Link
            to="/projects/$slug/issues/$number"
            params={{ slug, number: numberParam }}
          >
            Back to #{numberParam}
          </Link>
        </Button>
      </div>
    );
  }
  return (
    <SpecViewBody slug={slug} issueNumber={issueNumber} spec={spec.data} />
  );
}

/** A draft in the making: where it anchors and what it quotes. */
type Staging = ComposerStaging;

function quoteOf(body: string, start: number, end: number): string {
  return body
    .split("\n")
    .slice(start - 1, end)
    .join("\n");
}

function SpecViewBody({
  slug,
  issueNumber,
  spec,
}: {
  slug: string;
  issueNumber: number;
  spec: SpecInfo;
}) {
  const search = useSearch({
    from: "/authed/projects/$slug/issues/$number/spec",
  });
  const version = search.v ?? spec.current_version;
  const compare = search.compare;
  const files = useSuspenseQuery(specFilesQuery(slug, issueNumber, version));
  const comments = useSuspenseQuery(specCommentsQuery(slug, issueNumber));
  const drafts = useSpecReviewDrafts(slug, issueNumber);
  const [staging, setStaging] = useState<Staging | null>(null);
  const [finishOpen, setFinishOpen] = useState(false);
  const [showChanges, setShowChanges] = useState(true);
  const mainRef = useRef<HTMLDivElement>(null);

  const selectedPath = search.file ?? files.data.files[0]?.path;
  const selected = files.data.files.find((f) => f.path === selectedPath);
  const params = { slug, number: String(issueNumber) };

  // Re-review aid: highlight what changed since the previous version. The
  // baseline snapshot also feeds the sidebar diff stats and the new-file
  // detection (#61), so it loads whenever a previous version exists.
  const highlightEnabled = version > 1 && showChanges && compare === undefined;
  const baseline = useQuery({
    ...specFilesQuery(slug, issueNumber, version - 1),
    enabled: version > 1,
  });
  // A file with no baseline counterpart is brand new: highlighting every
  // block tells the reviewer nothing (#61) — render it normally and say
  // "new file" instead.
  const isNewFile =
    version > 1 &&
    baseline.data !== undefined &&
    selected !== undefined &&
    !baseline.data.files.some((f) => f.path === selected.path);
  const changedRanges = useMemo(() => {
    if (!highlightEnabled || selected === undefined || !baseline.data) {
      return [];
    }
    const old = baseline.data.files.find((f) => f.path === selected.path);
    if (old === undefined) return [];
    return changedLineRanges(old.body, selected.body);
  }, [highlightEnabled, selected, baseline.data]);

  // Files of the viewed version that differ from the baseline (new or
  // modified), in sidebar order — the rail the change navigation rides
  // across file boundaries (#61).
  const changedFiles = useMemo(() => {
    if (version <= 1 || !baseline.data) return [];
    const before = new Map(baseline.data.files.map((f) => [f.path, f.body]));
    return files.data.files
      .filter((f) => before.get(f.path) !== f.body)
      .map((f) => f.path);
  }, [version, baseline.data, files.data.files]);

  // Sidebar diff stats vs the baseline, same visuals as the #59 version
  // card. Removed files have no sidebar row to annotate — the version
  // card in the timeline still accounts for them.
  const sidebarStats = useMemo(() => {
    if (version <= 1 || !baseline.data) {
      return new Map<string, SpecFileStat>();
    }
    const before = new Map(baseline.data.files.map((f) => [f.path, f.body]));
    const after = new Map(files.data.files.map((f) => [f.path, f.body]));
    const stats = computeVersionStats(
      {
        added: files.data.files
          .filter((f) => !before.has(f.path))
          .map((f) => f.path),
        changed: files.data.files
          .filter((f) => {
            const old = before.get(f.path);
            return old !== undefined && old !== f.body;
          })
          .map((f) => f.path),
        removed: [],
      },
      before,
      after,
      diffLines,
    );
    return new Map(stats.map((s) => [s.path, s]));
  }, [version, baseline.data, files.data.files]);

  const flashTo = (target: HTMLElement) => {
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    // Same flash as timeline anchors (#38): remove → reflow → re-add.
    target.classList.remove("anchor-flash");
    void target.offsetWidth;
    target.classList.add("anchor-flash");
  };

  /**
   * Element centers against the viewport center, not tops against an
   * arbitrary pivot: scrollIntoView({block:"center"}) leaves the current
   * target's center ≈ the viewport's, so it excludes itself from both
   * directions — the old top-vs-⅓-height comparison kept re-finding the
   * element it had just centered and the navigation jammed (#61).
   */
  const jumpWithin = (direction: 1 | -1): boolean => {
    const root = mainRef.current;
    if (!root) return false;
    const els = [...root.querySelectorAll<HTMLElement>(".spec-changed")];
    if (els.length === 0) return false;
    const viewportCenter = window.scrollY + window.innerHeight / 2;
    const centers = els.map((el) => {
      const rect = el.getBoundingClientRect();
      return rect.top + window.scrollY + rect.height / 2;
    });
    const index =
      direction === 1
        ? centers.findIndex((c) => c > viewportCenter + 8)
        : centers.findLastIndex((c) => c < viewportCenter - 8);
    const target = index >= 0 ? els[index] : undefined;
    if (!target) return false;
    flashTo(target);
    return true;
  };

  // Set before a cross-file hop; consumed once the new file's changed
  // blocks are stamped, landing on its first (next) or last (prev) change.
  const pendingJumpRef = useRef<1 | -1 | null>(null);
  const navigate = useNavigate();
  const jumpChange = (direction: 1 | -1) => {
    if (jumpWithin(direction)) return;
    if (selectedPath === undefined || changedFiles.length === 0) return;
    const position = changedFiles.indexOf(selectedPath);
    const nextPath =
      position === -1
        ? direction === 1
          ? changedFiles[0]
          : changedFiles.at(-1)
        : changedFiles[position + direction];
    if (nextPath === undefined || nextPath === selectedPath) return;
    pendingJumpRef.current = direction;
    void navigate({
      to: "/projects/$slug/issues/$number/spec",
      params,
      search: { file: nextPath, v: search.v },
    });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: changedRanges signals that the new file's highlights are stamped
  useEffect(() => {
    const direction = pendingJumpRef.current;
    if (direction === null) return;
    pendingJumpRef.current = null;
    const root = mainRef.current;
    if (!root) return;
    const els = [...root.querySelectorAll<HTMLElement>(".spec-changed")];
    const target = direction === 1 ? els[0] : els[els.length - 1];
    if (target) flashTo(target);
    // A file with no highlighted blocks (e.g. brand new) starts at the top.
    else root.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [selectedPath, changedRanges]);

  const queryClient = useQueryClient();
  const resolve = useMutation({
    mutationFn: (commentId: number) =>
      api.resolveSpecComments(slug, issueNumber, [commentId]),
    onSuccess: () => {
      for (const key of [
        ["spec", slug, issueNumber],
        ["timeline", slug, issueNumber],
        ["issue", slug, issueNumber],
        ["issues", slug],
      ]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    },
    onError: (error) => toast.error(error.message),
  });

  // Comments that can hang inline on the viewed version of the selected
  // file; everything else (outdated, anchored to another version while an
  // old one is viewed) lands in the flat list below the document.
  const { displayed, unplaced, fileLevel } = useMemo(() => {
    const displayed: DisplayedAnnotation[] = [];
    const unplaced: SpecCommentItem[] = [];
    const fileLevel: SpecCommentItem[] = [];
    for (const item of comments.data.items) {
      if (item.anchor.path !== selectedPath) continue;
      if (item.anchor.line_start === null || item.anchor.line_end === null) {
        // File-level comments (#61) sit above the document, not on a block.
        fileLevel.push(item);
      } else if (item.anchor.version === version) {
        displayed.push({
          key: `c${item.comment_id}`,
          kind: "comment",
          item,
          start: item.anchor.line_start,
          end: item.anchor.line_end,
        });
      } else if (
        version === comments.data.current_version &&
        !item.outdated &&
        item.current_line_start !== null &&
        item.current_line_end !== null
      ) {
        displayed.push({
          key: `c${item.comment_id}`,
          kind: "comment",
          item,
          start: item.current_line_start,
          end: item.current_line_end,
        });
      } else {
        unplaced.push(item);
      }
    }
    for (const draft of drafts.drafts) {
      if (draft.anchor.path !== selectedPath) continue;
      if (draft.anchor.version !== version) continue;
      if (draft.anchor.line_start === null || draft.anchor.line_end === null) {
        continue; // file-level drafts render in the file-level strip below
      }
      displayed.push({
        key: draft.id,
        kind: "draft",
        draft,
        start: draft.anchor.line_start,
        end: draft.anchor.line_end,
      });
    }
    return { displayed, unplaced, fileLevel };
  }, [comments.data, drafts.drafts, selectedPath, version]);

  const fileLevelDrafts = drafts.drafts.filter(
    (d) =>
      d.anchor.path === selectedPath &&
      d.anchor.version === version &&
      d.anchor.line_start === null,
  );

  const unresolvedByPath = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of comments.data.items) {
      if (item.resolved !== null) continue;
      counts.set(item.anchor.path, (counts.get(item.anchor.path) ?? 0) + 1);
    }
    return counts;
  }, [comments.data]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild size="sm" variant="ghost">
          <Link to="/projects/$slug/issues/$number" params={params}>
            <ArrowLeftIcon className="size-4" />#{issueNumber}
          </Link>
        </Button>
        <span className="font-semibold">Spec</span>
        <SpecStatusBadge status={spec.review_status} />
        <span className="mx-2 h-4 w-px bg-border" aria-hidden />
        {spec.versions.map((v) => (
          <Link
            key={v.number}
            to="/projects/$slug/issues/$number/spec"
            params={params}
            search={{ file: search.file, v: v.number }}
            title={v.message ?? undefined}
            className={cn(
              "rounded-full border px-2.5 py-0.5 font-mono text-xs",
              v.number === version && compare === undefined
                ? "border-foreground bg-foreground text-background"
                : "text-muted-foreground hover:border-foreground/50",
            )}
          >
            v{v.number}
          </Link>
        ))}
        {version > 1 && (
          <Link
            to="/projects/$slug/issues/$number/spec"
            params={params}
            search={{ file: search.file, v: version, compare: version - 1 }}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-xs",
              compare !== undefined
                ? "border-foreground bg-foreground text-background"
                : "text-muted-foreground hover:border-foreground/50",
            )}
          >
            diff v{version - 1}…v{version}
          </Link>
        )}
        {isNewFile && compare === undefined && (
          <span className="rounded-full border border-emerald-600/60 bg-emerald-600/10 px-2.5 py-0.5 text-xs text-emerald-700 dark:text-emerald-400">
            new in v{version}
          </span>
        )}
        {version > 1 && compare === undefined && !isNewFile && (
          <>
            <button
              type="button"
              onClick={() => setShowChanges(!showChanges)}
              className={cn(
                "cursor-pointer rounded-full border px-2.5 py-0.5 text-xs",
                showChanges
                  ? "border-emerald-600/60 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400"
                  : "text-muted-foreground hover:border-foreground/50",
              )}
              title={`Highlight blocks changed since v${version - 1}`}
            >
              changes since v{version - 1}
            </button>
            {highlightEnabled && (
              <>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="previous change"
                  onClick={() => jumpChange(-1)}
                >
                  <ArrowUpIcon className="size-4" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="next change"
                  onClick={() => jumpChange(1)}
                >
                  <ArrowDownIcon className="size-4" />
                </Button>
              </>
            )}
          </>
        )}
        <span className="ml-auto" />
        {compare === undefined && selected !== undefined && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setStaging({
                path: selected.path,
                version,
                lineStart: null,
                lineEnd: null,
                quote: "",
              })
            }
          >
            Comment file
          </Button>
        )}
        <Button size="sm" onClick={() => setFinishOpen(true)}>
          Finish review
          {drafts.drafts.length > 0 && ` (${drafts.drafts.length} staged)`}
        </Button>
      </div>

      {compare !== undefined ? (
        <SpecDiff
          slug={slug}
          issueNumber={issueNumber}
          fromVersion={compare}
          toFiles={files.data.files}
          toVersion={version}
          comments={comments.data.items}
          onStage={setStaging}
          focusPath={search.file}
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
          <aside className="space-y-1">
            {files.data.files.map((file) => {
              const unresolved = unresolvedByPath.get(file.path) ?? 0;
              return (
                <Link
                  key={file.path}
                  to="/projects/$slug/issues/$number/spec"
                  params={params}
                  search={{ file: file.path, v: search.v }}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                    file.path === selectedPath
                      ? "bg-muted font-medium"
                      : "text-muted-foreground hover:bg-muted/50",
                  )}
                >
                  <FileTextIcon className="size-4 shrink-0" />
                  <span className="truncate font-mono text-xs">
                    {file.path}
                  </span>
                  <span className="ml-auto inline-flex shrink-0 items-center gap-1.5">
                    {unresolved > 0 && (
                      <span className="rounded-full border border-amber-500/60 bg-amber-500/10 px-1.5 text-xs text-amber-700 dark:text-amber-400">
                        {unresolved}
                      </span>
                    )}
                    {(() => {
                      const stat = sidebarStats.get(file.path);
                      if (!stat) return null;
                      return (
                        <span className="inline-flex items-center gap-1.5 text-[11px]">
                          <StatNumbers stat={stat} />
                          <DiffstatBar stat={stat} />
                        </span>
                      );
                    })()}
                  </span>
                </Link>
              );
            })}
          </aside>
          <main className="min-w-0 space-y-4" ref={mainRef}>
            {(fileLevel.length > 0 || fileLevelDrafts.length > 0) && (
              <div className="space-y-2 rounded-lg border px-4 py-3">
                <h3 className="text-xs font-medium text-muted-foreground uppercase">
                  File comments
                </h3>
                {fileLevel.map((item) => (
                  <UnplacedComment
                    key={item.comment_id}
                    item={item}
                    onResolve={(id) => resolve.mutate(id)}
                    resolving={resolve.isPending}
                  />
                ))}
                {fileLevelDrafts.map((draft) => (
                  <div
                    key={draft.id}
                    className="rounded-md border border-indigo-500/40 p-2 text-sm"
                  >
                    <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium text-indigo-700 dark:text-indigo-400">
                        draft
                      </span>
                      file comment
                      <span className="ml-auto" />
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs"
                        onClick={() => drafts.remove(draft.id)}
                      >
                        Discard
                      </Button>
                    </div>
                    <p className="whitespace-pre-wrap">{draft.body}</p>
                  </div>
                ))}
              </div>
            )}
            <div className="rounded-lg border px-5 py-4">
              {selected === undefined ? (
                <p className="text-sm text-muted-foreground italic">
                  File not found in v{version}.
                </p>
              ) : (
                <AnnotatedMarkdown
                  slug={slug}
                  issueNumber={issueNumber}
                  body={selected.body}
                  annotations={displayed}
                  changedRanges={changedRanges}
                  onStage={(range) =>
                    setStaging({
                      path: selected.path,
                      version,
                      lineStart: range.lineStart,
                      lineEnd: range.lineEnd,
                      quote: quoteOf(
                        selected.body,
                        range.lineStart,
                        range.lineEnd,
                      ),
                    })
                  }
                  onRemoveDraft={drafts.remove}
                  onResolve={(id) => resolve.mutate(id)}
                  resolving={resolve.isPending}
                />
              )}
            </div>
            {unplaced.length > 0 && (
              <div className="space-y-2 rounded-lg border px-4 py-3">
                <h3 className="text-xs font-medium text-muted-foreground uppercase">
                  Comments without a place in v{version}
                </h3>
                {unplaced.map((item) => (
                  <UnplacedComment
                    key={item.comment_id}
                    item={item}
                    onResolve={(id) => resolve.mutate(id)}
                    resolving={resolve.isPending}
                  />
                ))}
              </div>
            )}
          </main>
        </div>
      )}

      {staging !== null && (
        <SpecComposer
          // A fresh anchor gets a fresh body.
          key={`${staging.path}:${staging.lineStart}-${staging.lineEnd}:${staging.version}`}
          staging={staging}
          onCancel={() => setStaging(null)}
          onStage={(body) => {
            drafts.add({
              anchor: {
                path: staging.path,
                version: staging.version,
                line_start: staging.lineStart,
                line_end: staging.lineEnd,
              },
              quote: staging.quote,
              body,
            });
            setStaging(null);
          }}
        />
      )}

      <ReviewSubmitDialog
        slug={slug}
        issueNumber={issueNumber}
        currentVersion={spec.current_version}
        drafts={drafts.drafts}
        open={finishOpen}
        onClose={() => setFinishOpen(false)}
        onSubmitted={() => {
          drafts.clear();
          setFinishOpen(false);
        }}
      />
    </div>
  );
}

function UnplacedComment({
  item,
  onResolve,
  resolving,
}: {
  item: SpecCommentItem;
  onResolve: (id: number) => void;
  resolving: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-md border p-2 text-sm",
        item.resolved !== null && "opacity-70",
      )}
    >
      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        <UserChip user={item.author} />
        <span>
          {item.anchor.line_start === null
            ? "file"
            : `L${item.anchor.line_start}${
                item.anchor.line_end !== item.anchor.line_start
                  ? `–${item.anchor.line_end}`
                  : ""
              }`}{" "}
          · v{item.anchor.version}
        </span>
        {item.outdated && (
          <span className="rounded-full border px-1.5 text-muted-foreground">
            outdated
          </span>
        )}
        <span className="ml-auto" />
        {item.resolved === null ? (
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            disabled={resolving}
            onClick={() => onResolve(item.comment_id)}
          >
            Resolve
          </Button>
        ) : (
          <span className="text-green-700 dark:text-green-400">resolved</span>
        )}
      </div>
      {item.anchor.quote !== "" && (
        <div className="mb-1 rounded border-l-2 bg-muted/40 px-2 py-1 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
          {item.anchor.quote}
        </div>
      )}
      <p className="whitespace-pre-wrap">{item.body}</p>
    </div>
  );
}

// Module-scope per the library's props-stability guidance; interaction
// callbacks are merged per file pair below. Theme constants follow the
// shared pierre setup (#31); the direct MultiFileDiff import is fine here
// because this whole page is route-lazy — pierre never reaches the main
// bundle through it.
const DIFF_THEME = {
  theme: PIERRE_THEME,
  themeType: PIERRE_THEME_TYPE,
  diffStyle: "unified",
} as const;

/** All file pairs that differ between two versions, one diff per file. */
function SpecDiff({
  slug,
  issueNumber,
  fromVersion,
  toFiles,
  toVersion,
  comments,
  onStage,
  focusPath,
}: {
  slug: string;
  issueNumber: number;
  fromVersion: number;
  toFiles: SpecFile[];
  toVersion: number;
  comments: SpecCommentItem[];
  onStage: (staging: Staging) => void;
  /** Scroll this file's diff into view — the version card's per-file link (#59). */
  focusPath?: string;
}) {
  const from = useSuspenseQuery(specFilesQuery(slug, issueNumber, fromVersion));
  const focusRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusPath === undefined) return;
    const el = focusRef.current;
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    el.classList.remove("anchor-flash");
    void el.offsetWidth;
    el.classList.add("anchor-flash");
  }, [focusPath]);
  const pairs = useMemo(() => {
    const before = new Map(from.data.files.map((f) => [f.path, f.body]));
    const after = new Map(toFiles.map((f) => [f.path, f.body]));
    const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
    return paths
      .map((path) => ({
        path,
        oldBody: before.get(path) ?? "",
        newBody: after.get(path) ?? "",
      }))
      .filter((p) => p.oldBody !== p.newBody);
  }, [from.data.files, toFiles]);

  if (pairs.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        v{fromVersion} and v{toVersion} are identical.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Drag across line numbers to comment on a range (old side anchors to v
        {fromVersion}, new side to v{toVersion}).
      </p>
      {pairs.map((pair) => (
        <div
          key={pair.path}
          ref={pair.path === focusPath ? focusRef : undefined}
          className="scroll-mt-4"
        >
          <AnnotatedFileDiff
            path={pair.path}
            oldBody={pair.oldBody}
            newBody={pair.newBody}
            fromVersion={fromVersion}
            toVersion={toVersion}
            comments={comments.filter((c) => c.anchor.path === pair.path)}
            onStage={onStage}
          />
        </div>
      ))}
    </div>
  );
}

function AnnotatedFileDiff({
  path,
  oldBody,
  newBody,
  fromVersion,
  toVersion,
  comments,
  onStage,
}: {
  path: string;
  oldBody: string;
  newBody: string;
  fromVersion: number;
  toVersion: number;
  comments: SpecCommentItem[];
  onStage: (staging: Staging) => void;
}) {
  const oldFile = useMemo(
    () => ({ name: path, contents: oldBody }),
    [path, oldBody],
  );
  const newFile = useMemo(
    () => ({ name: path, contents: newBody }),
    [path, newBody],
  );
  const options = useMemo(
    () => ({
      ...DIFF_THEME,
      enableLineSelection: true,
      onLineSelectionEnd: (range: SelectedLineRange | null) => {
        if (!range) return;
        const version = range.side === "deletions" ? fromVersion : toVersion;
        const body = range.side === "deletions" ? oldBody : newBody;
        const lineStart = Math.min(range.start, range.end);
        const lineEnd = Math.max(range.start, range.end);
        onStage({
          path,
          version,
          lineStart,
          lineEnd,
          quote: quoteOf(body, lineStart, lineEnd),
        });
      },
    }),
    [path, oldBody, newBody, fromVersion, toVersion, onStage],
  );
  const lineAnnotations = useMemo(
    () =>
      comments
        .filter(
          (c) =>
            c.anchor.version === fromVersion || c.anchor.version === toVersion,
        )
        .map((c) => ({
          side:
            c.anchor.version === fromVersion
              ? ("deletions" as const)
              : ("additions" as const),
          // pierre's contract: lineNumber 0 renders a side-level annotation
          // above the first hunk — exactly where file-level comments belong.
          lineNumber: c.anchor.line_start ?? 0,
          metadata: c,
        })),
    [comments, fromVersion, toVersion],
  );

  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="border-b bg-muted/40 px-3 py-1.5 font-mono text-xs">
        {path}
      </div>
      <MultiFileDiff<SpecCommentItem>
        oldFile={oldFile}
        newFile={newFile}
        options={options}
        lineAnnotations={lineAnnotations}
        renderAnnotation={(annotation) => (
          <DiffAnnotation item={annotation.metadata} />
        )}
      />
    </div>
  );
}

function DiffAnnotation({ item }: { item: SpecCommentItem }) {
  return (
    <div className="border-y bg-background px-3 py-2 text-sm">
      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        <UserChip user={item.author} />
        <span>
          {item.anchor.line_start === null
            ? "file"
            : `L${item.anchor.line_start}${
                item.anchor.line_end !== item.anchor.line_start
                  ? `–${item.anchor.line_end}`
                  : ""
              }`}{" "}
          · v{item.anchor.version}
        </span>
        {item.resolved !== null && (
          <span className="text-green-700 dark:text-green-400">resolved</span>
        )}
      </div>
      <p className="whitespace-pre-wrap">{item.body}</p>
    </div>
  );
}
