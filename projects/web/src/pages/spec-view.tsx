import type { SelectedLineRange } from "@pierre/diffs";
// Imported directly rather than through the lazy wrapper in pierre.tsx: this
// whole page is route-lazy, so pierre never reaches the main bundle through
// it anyway (T-31).
// `File` is aliased: unqualified it would shadow the DOM global for the whole
// module.
import { MultiFileDiff, File as PierreFile } from "@pierre/diffs/react";
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
import {
  formatAnchorRange,
  formatRef,
  type SpecCommentItem,
  type SpecFile,
  type SpecInfo,
} from "@todou/shared";
import { diffLines } from "diff";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  FileTextIcon,
  WrapTextIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { issueQuery } from "@/api/issues.ts";
import { api } from "@/api/queries.ts";
import { useRefPrefix } from "@/api/references.ts";
import { specCommentsQuery, specFilesQuery, specQuery } from "@/api/spec.ts";
import { SpecStatusBadge } from "@/components/issue/spec-entry.tsx";
import {
  PIERRE_HIGHLIGHTER,
  PIERRE_THEME_TYPE,
  useSyntaxTheme,
} from "@/components/shared/pierre.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import {
  AnnotatedMarkdown,
  type DisplayedAnnotation,
} from "@/components/spec/annotated-markdown.tsx";
import { ReviewSubmitDialog } from "@/components/spec/review-submit.tsx";
import { SpecBaselinePicker } from "@/components/spec/spec-baseline-picker.tsx";
import { SpecCompareToggle } from "@/components/spec/spec-compare-toggle.tsx";
import {
  type ComposerStaging,
  SpecComposer,
} from "@/components/spec/spec-composer.tsx";
import { SpecVersionPicker } from "@/components/spec/spec-version-picker.tsx";
import { SpecViewToggle } from "@/components/spec/spec-view-toggle.tsx";
import { useLinkedTriggerWidths } from "@/components/spec/use-linked-trigger-widths.ts";
import {
  DiffstatBar,
  StatNumbers,
} from "@/components/timeline/spec-version-card.tsx";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { changedLineRanges } from "@/lib/spec-changes.ts";
import {
  type SpecReviewDraft,
  useSpecReviewDrafts,
} from "@/lib/spec-drafts.ts";
import {
  type SpecSearch,
  type SpecView,
  specMode,
  specSearchFor,
} from "@/lib/spec-search.ts";
import { beginEdit, retarget, type Staging } from "@/lib/spec-staging.ts";
import {
  computeVersionStats,
  type SpecFileStat,
} from "@/lib/spec-version-stats.ts";
import { useElementHeight, useHeaderHeight } from "@/lib/use-header-height.ts";
import { cn } from "@/lib/utils.ts";

/** What ↑↓ stops on: both kinds of "changed since the baseline" mark (T-158). */
const CHANGED_SELECTOR = ".spec-changed, .spec-ins-block";

/** What ↑↓ stops on in source-diff mode: one per file pair (T-190). */
const FILE_DIFF_SELECTOR = "[data-file-diff]";

/** Two toolbar rows, until the measurement lands. */
const TOOLBAR_FALLBACK_HEIGHT = 78;

/**
 * The one content slot in the toolbar's second row: `wrap` and the new-file
 * note render as this same box, sized to whichever is showing. That leaves the
 * slot ~8px narrower on `wrap` than on the note, and since the slot is anchored
 * right, swapping them shifts it by that much — accepted on T-194 in exchange
 * for the 61px of hollow the old fixed width cost on every other state.
 */
const DISPLAY_SLOT =
  "inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-full border px-2.5 text-xs";
const DISPLAY_SLOT_ON =
  "border-emerald-600/60 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400";
const DISPLAY_SLOT_OFF = "text-muted-foreground hover:border-foreground/50";
const DISPLAY_SLOT_DISABLED = "border-dashed text-muted-foreground/60";

/**
 * A fixed position in the toolbar. Every slot renders in every state (T-190),
 * so a control that does not apply is disabled rather than unmounted — and a
 * disabled element fires no pointer events, which is why the explanation
 * hangs on this wrapper instead of on the control itself.
 *
 * The baseline slot is the one exception: with comparing off there is no
 * baseline to disable a picker against, and an empty box in the middle of a
 * range is worse than a shorter range (T-200).
 */
function ToolbarSlot({
  name,
  title,
  className,
  children,
}: {
  name: string;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      data-toolbar-slot={name}
      title={title}
      className={cn("inline-flex shrink-0 items-center", className)}
    >
      {children}
    </span>
  );
}

/** Paths whose body differs between two versions — one file diff each. */
function diffPaths(before: SpecFile[], after: SpecFile[]): string[] {
  const from = new Map(before.map((f) => [f.path, f.body]));
  const to = new Map(after.map((f) => [f.path, f.body]));
  return [...new Set([...from.keys(), ...to.keys()])]
    .sort()
    .filter((path) => (from.get(path) ?? "") !== (to.get(path) ?? ""));
}

export function SpecViewPage() {
  const { slug, number: numberParam } = useParams({
    from: "/authed/projects/$slug/issues/$number/spec",
  });
  const issueNumber = Number(numberParam);
  const spec = useSuspenseQuery(specQuery(slug, issueNumber));
  const refPrefix = useRefPrefix(slug);

  if (spec.data === null) {
    return (
      <div className="mx-auto max-w-lg py-20 text-center text-muted-foreground">
        <p>This issue has no spec yet.</p>
        <Button asChild variant="link">
          <Link
            to="/projects/$slug/issues/$number"
            params={{ slug, number: numberParam }}
          >
            Back to {formatRef(refPrefix, issueNumber)}
          </Link>
        </Button>
      </div>
    );
  }
  return (
    <SpecViewBody slug={slug} issueNumber={issueNumber} spec={spec.data} />
  );
}

const DIFF_WRAP_STORAGE_KEY = "todou-spec-diff-wrap";

// Specs are markdown prose, so wrapping — not horizontal scrolling — is the
// reading posture the diff opens in until the user says otherwise (T-143).
function readDiffWrap(): boolean {
  try {
    return localStorage.getItem(DIFF_WRAP_STORAGE_KEY) !== "off";
  } catch {
    // storage may be unavailable (private mode); fall through
    return true;
  }
}

function writeDiffWrap(wrap: boolean) {
  try {
    localStorage.setItem(DIFF_WRAP_STORAGE_KEY, wrap ? "on" : "off");
  } catch {
    // preference just won't persist
  }
}

/**
 * Display copy of the anchored source. The server re-cuts it
 * authoritatively on submit; this has to agree with that cut, columns and
 * all, or the composer would preview something else than it stages.
 */
function quoteOf(
  body: string,
  start: number,
  end: number,
  colStart: number | null = null,
  colEnd: number | null = null,
): string {
  const lines = body.split("\n").slice(start - 1, end);
  const last = lines.length - 1;
  if (colStart !== null && colEnd !== null && last >= 0) {
    if (last === 0) {
      lines[0] = (lines[0] ?? "").slice(colStart - 1, colEnd);
    } else {
      lines[0] = (lines[0] ?? "").slice(colStart - 1);
      lines[last] = (lines[last] ?? "").slice(0, colEnd);
    }
  }
  return lines.join("\n");
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
  const refPrefix = useRefPrefix(slug);
  const search = useSearch({
    from: "/authed/projects/$slug/issues/$number/spec",
  });
  const version = search.v ?? spec.current_version;
  const files = useSuspenseQuery(specFilesQuery(slug, issueNumber, version));
  const comments = useSuspenseQuery(specCommentsQuery(slug, issueNumber));
  const drafts = useSpecReviewDrafts(slug, issueNumber);
  const [staging, setStaging] = useState<Staging | null>(null);
  const [finishOpen, setFinishOpen] = useState(false);
  // The compare toggle's "off" position: a reading stance for this session,
  // which is why it stays out of the URL. A link that pins a baseline still
  // wins over it, so shared diff links open as their sender saw them (T-192).
  const [compareOff, setCompareOff] = useState(false);
  // …and the presentation picked while off, for the same reason: the URL
  // spells out comparisons only, so this quadrant needs its own home (T-200).
  const [offView, setOffView] = useState<SpecView>("rendered");
  const [wrap, setWrap] = useState(readDiffWrap);
  const [filesOpen, setFilesOpen] = useState(false);
  const contentRef = useRef<HTMLElement>(null);
  const sessionRef = useRef(0);
  const rowBRef = useRef<HTMLDivElement>(null);

  const { baseline, view: urlView } = specMode(search, version, compareOff);
  const comparing = baseline !== null;
  const view = urlView ?? offView;
  /** Two versions side by side… */
  const sourceDiff = comparing && view === "source";
  /** …against one version's markdown, whole (T-200). */
  const fullSource = !comparing && view === "source";

  // Whatever the baseline came from — the menu, a link, or the automatic
  // previous version — turning comparing back on returns to it.
  const lastBaselineRef = useRef<number | null>(null);
  useEffect(() => {
    if (baseline !== null) lastBaselineRef.current = baseline;
  }, [baseline]);

  const messageOf = (n: number | null) =>
    n === null
      ? null
      : (spec.versions.find((v) => v.number === n)?.message ?? null);
  // The two triggers are sized against each other, which no CSS can express.
  useLinkedTriggerWidths(rowBRef, [
    version,
    baseline,
    messageOf(version),
    messageOf(baseline),
  ]);

  // The sticky stack: shell header, then this page's toolbar. Both heights
  // are runtime values — the header grows a nav row below sm, the toolbar
  // wraps to two lines when its buttons no longer fit (T-178).
  const toolbarRef = useRef<HTMLDivElement>(null);
  const headerHeight = useHeaderHeight();
  const toolbarHeight = useElementHeight(toolbarRef, TOOLBAR_FALLBACK_HEIGHT);
  const stickyTop = headerHeight + toolbarHeight;

  const issue = useQuery(issueQuery(slug, issueNumber));
  const navigate = useNavigate();

  /** Every anchor gesture — selection, line drag, "Comment file". */
  const stage = (next: ComposerStaging) => {
    const session = ++sessionRef.current;
    setStaging((prev) => retarget(prev, next, session));
  };
  const editDraft = (draft: SpecReviewDraft) =>
    setStaging(beginEdit(draft, ++sessionRef.current));
  const editingDraft = drafts.drafts.find((d) => d.id === staging?.draftId);

  // The source diff stacks every differing file at once, so the rail marks a
  // file only once the reader has actually asked for one.
  const selectedPath = sourceDiff
    ? search.file
    : (search.file ?? files.data.files[0]?.path);
  const selected = files.data.files.find((f) => f.path === selectedPath);
  const params = { slug, number: String(issueNumber) };

  const fileSearch = (path: string): SpecSearch =>
    specSearchFor({ file: path, v: search.v, version, baseline, view });
  const baselineSearch = (next: number | null): SpecSearch =>
    specSearchFor({
      file: search.file,
      v: search.v,
      version,
      baseline: next,
      view,
    });
  /** Only ever called while comparing: off has no URL to write. */
  const viewSearch = (next: SpecView): SpecSearch =>
    specSearchFor({
      file: search.file,
      v: search.v,
      version,
      baseline,
      view: next,
    });
  /**
   * The one way in and out of comparing (T-200). Off is session state, so
   * only the way in writes a baseline to the URL; both carry the current
   * presentation across, which is what makes off↔on symmetric on either
   * side of the rendered/source switch.
   */
  const toggleComparing = () => {
    if (comparing) {
      setOffView(view);
      setCompareOff(true);
      void navigate({
        to: "/projects/$slug/issues/$number/spec",
        params,
        search: baselineSearch(null),
      });
      return;
    }
    const last = lastBaselineRef.current;
    const next = last !== null && last < version ? last : version - 1;
    setCompareOff(false);
    void navigate({
      to: "/projects/$slug/issues/$number/spec",
      params,
      search: baselineSearch(next),
    });
  };

  const versionSearch = (target: number): SpecSearch => {
    // A baseline the reader pinned survives the switch as long as it still
    // sits behind the version being opened; otherwise the previous version
    // takes over, which is what the automatic posture would have picked.
    const pinned = search.compare;
    const next =
      !comparing || target <= 1
        ? null
        : pinned !== undefined && pinned < target
          ? pinned
          : target - 1;
    return specSearchFor({
      file: search.file,
      v: target,
      version: target,
      baseline: next,
      view,
    });
  };

  // Re-review aid: highlight what changed since the baseline. The same
  // snapshot answers the file list's diffstat and the new-file detection
  // (T-61), and in source mode it is the diff's left-hand side — one query
  // whichever way the comparison is drawn.
  const renderedCompare = comparing && view === "rendered";
  const baselineQuery = useQuery({
    ...specFilesQuery(slug, issueNumber, baseline ?? 0),
    enabled: comparing,
  });
  const baselineFiles = comparing ? baselineQuery.data : undefined;
  // A file with no baseline counterpart is brand new: highlighting every
  // block tells the reviewer nothing (T-61) — render it normally and say
  // "new file" instead.
  const isNewFile =
    baselineFiles !== undefined &&
    selected !== undefined &&
    !baselineFiles.files.some((f) => f.path === selected.path);
  // The baseline body drives BOTH aids: line ranges for the block-level
  // wash and the ↑↓ nav, and the word-level diff inside those blocks (T-142).
  const baselineBody = useMemo(() => {
    if (!renderedCompare || selected === undefined || !baselineFiles) {
      return undefined;
    }
    return baselineFiles.files.find((f) => f.path === selected.path)?.body;
  }, [renderedCompare, selected, baselineFiles]);
  const changedRanges = useMemo(() => {
    if (baselineBody === undefined || selected === undefined) return [];
    return changedLineRanges(baselineBody, selected.body);
  }, [baselineBody, selected]);

  // Files of the viewed version that differ from the baseline (new or
  // modified), in sidebar order — the rail the change navigation rides
  // across file boundaries (T-61).
  const changedFiles = useMemo(() => {
    if (!baselineFiles) return [];
    const before = new Map(baselineFiles.files.map((f) => [f.path, f.body]));
    return files.data.files
      .filter((f) => before.get(f.path) !== f.body)
      .map((f) => f.path);
  }, [baselineFiles, files.data.files]);

  // Source mode: the file pairs `SpecDiff` will render, computed here too so
  // the file list and its ↑↓ cannot disagree with what is on screen. Unlike
  // changedFiles this keeps removed files, which have a diff but no row in
  // the viewed version.
  const comparePaths = useMemo(() => {
    if (!baselineFiles) return [];
    return diffPaths(baselineFiles.files, files.data.files);
  }, [baselineFiles, files.data.files]);

  // Files the baseline had and this version does not. The rendered view has
  // no way to draw one, so the rail carries them to a notice that hands the
  // reader over to the source diff (T-192).
  const removedFiles = useMemo(() => {
    if (!baselineFiles) return [];
    const present = new Set(files.data.files.map((f) => f.path));
    return baselineFiles.files
      .filter((f) => !present.has(f.path))
      .map((f) => f.path);
  }, [baselineFiles, files.data.files]);

  // The rail is the same element in every state; only its contents change.
  // The source diff narrows it to what the diff stack renders, in that
  // stack's own path order (T-192).
  const railEntries = useMemo(() => {
    const present = new Set(files.data.files.map((f) => f.path));
    if (sourceDiff) {
      return comparePaths.map((path) => ({
        path,
        removed: !present.has(path),
      }));
    }
    return [
      ...files.data.files.map((f) => ({ path: f.path, removed: false })),
      ...removedFiles.map((path) => ({ path, removed: true })),
    ];
  }, [sourceDiff, files.data.files, comparePaths, removedFiles]);

  // Diffstat beside every rail row, same visuals as the T-59 version card.
  const sidebarStats = useMemo(() => {
    if (!baselineFiles) return new Map<string, SpecFileStat>();
    const before = new Map(baselineFiles.files.map((f) => [f.path, f.body]));
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
        removed: [...before.keys()].filter((path) => !after.has(path)),
      },
      before,
      after,
      diffLines,
    );
    return new Map(stats.map((s) => [s.path, s]));
  }, [baselineFiles, files.data.files]);

  const flashTo = (
    target: HTMLElement,
    block: ScrollLogicalPosition = "center",
  ) => {
    target.scrollIntoView({ block, behavior: "smooth" });
    // Same flash as timeline anchors (T-38): remove → reflow → re-add.
    target.classList.remove("anchor-flash");
    void target.offsetWidth;
    target.classList.add("anchor-flash");
  };

  /**
   * Element centers against the viewport center, not tops against an
   * arbitrary pivot: scrollIntoView({block:"center"}) leaves the current
   * target's center ≈ the viewport's, so it excludes itself from both
   * directions — the old top-vs-⅓-height comparison kept re-finding the
   * element it had just centered and the navigation jammed (T-61).
   */
  const jumpWithin = (direction: 1 | -1): boolean => {
    const root = contentRef.current;
    if (!root) return false;
    const els = [...root.querySelectorAll<HTMLElement>(CHANGED_SELECTOR)];
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
      search: fileSearch(nextPath),
    });
  };

  /**
   * The source half of ↑↓ (T-190 §5). Tops against the resting line rather
   * than centers against the viewport's: a file diff is routinely taller
   * than the viewport, and what the reader wants under the toolbar is its
   * path header — which is also where `scrollMarginTop` parks it, so the
   * diff already at rest still excludes itself from both directions.
   */
  const jumpFileDiff = (direction: 1 | -1) => {
    const root = contentRef.current;
    if (!root) return;
    const els = [...root.querySelectorAll<HTMLElement>(FILE_DIFF_SELECTOR)];
    if (els.length === 0) return;
    const resting = window.scrollY + stickyTop + 8;
    const tops = els.map(
      (el) => el.getBoundingClientRect().top + window.scrollY,
    );
    const index =
      direction === 1
        ? tops.findIndex((t) => t > resting + 8)
        : tops.findLastIndex((t) => t < resting - 8);
    const target = index >= 0 ? els[index] : undefined;
    if (!target) return;
    flashTo(target, "start");
  };

  /**
   * ↑↓ never leave the toolbar (T-190) — only what they step over, and
   * whether there is anything to step over, changes with the state.
   */
  const changeNav = ((): { unit: string; reason?: string } => {
    if (sourceDiff) {
      return comparePaths.length > 1
        ? { unit: "file diff" }
        : {
            unit: "file diff",
            reason: "Only one file differs between these versions",
          };
    }
    if (version === 1) {
      return {
        unit: "change",
        reason: "v1 is the first version — nothing has changed yet",
      };
    }
    if (!comparing) {
      return {
        unit: "change",
        reason: "Turn comparing on to step through what changed",
      };
    }
    if (changedFiles.length === 0) {
      return { unit: "change", reason: `Nothing changed since v${baseline}` };
    }
    // A file with no highlighted block of its own — brand new in this
    // version, or untouched by it — steps across file boundaries instead,
    // which is what `jumpChange` falls back to anyway (T-190 §4).
    return { unit: changedRanges.length === 0 ? "changed file" : "change" };
  })();

  /** The display slot holds `wrap`, which only a source view can honour. */
  const wrapReason =
    view === "source" ? undefined : "Only the source view wraps long lines";

  const compareReason =
    version === 1
      ? `v${version} has no earlier version to compare against`
      : undefined;

  const commentFileReason = sourceDiff
    ? "Drag across the diff's line numbers to comment on a range"
    : selected === undefined
      ? `This file is not part of v${version}`
      : undefined;

  // biome-ignore lint/correctness/useExhaustiveDependencies: changedRanges signals that the new file's highlights are stamped
  useEffect(() => {
    const direction = pendingJumpRef.current;
    if (direction === null) return;
    pendingJumpRef.current = null;
    const root = contentRef.current;
    if (!root) return;
    const els = [...root.querySelectorAll<HTMLElement>(CHANGED_SELECTOR)];
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
        // File-level comments (T-61) sit above the document, not on a block.
        fileLevel.push(item);
      } else if (item.anchor.version === version) {
        displayed.push({
          key: `c${item.comment_id}`,
          kind: "comment",
          item,
          start: item.anchor.line_start,
          end: item.anchor.line_end,
          colStart: item.anchor.col_start,
          colEnd: item.anchor.col_end,
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
          // A successful remap means the anchored lines read the same, so
          // the stored columns still cut them correctly (T-142) — there is
          // no separate current_col_* to carry.
          colStart: item.anchor.col_start,
          colEnd: item.anchor.col_end,
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
        colStart: draft.anchor.col_start,
        colEnd: draft.anchor.col_end,
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
      {/* Sticky rather than in-flow: version switching, the change toggles
          and Finish review are all mid-read actions, and a document long
          enough to need them is long enough to have scrolled them away
          (T-178). Same surface as the issue page's floating title bar. */}
      <div
        ref={toolbarRef}
        style={{ top: headerHeight }}
        className="sticky z-30 -mx-2 space-y-1.5 border-b bg-background/95 px-2 py-2 backdrop-blur"
      >
        {/* Row A — who and what, then the actions. The row's one elastic gap
            sits after the review badge, so the title truncates instead of
            pushing the action cluster around: nothing to the right of the
            gap moves, in any state (T-190). */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            asChild
            size="sm"
            variant="ghost"
            className="shrink-0"
            data-toolbar-slot="back"
          >
            <Link to="/projects/$slug/issues/$number" params={params}>
              <ArrowLeftIcon className="size-4" />
              {formatRef(refPrefix, issueNumber)}
            </Link>
          </Button>
          {/* Shrink-only (the flex default), not flex-1: a short title lets
              the badge sit right beside it rather than stranding it. */}
          <span
            data-toolbar-slot="title"
            title={issue.data?.title}
            className="hidden min-w-0 truncate text-sm text-muted-foreground lg:block"
          >
            {issue.data?.title}
          </span>
          <ToolbarSlot name="review-status">
            <SpecStatusBadge status={spec.review_status} />
          </ToolbarSlot>
          <span className="ml-auto" />
          {/* Below lg the file rail is gone from the flow; this is where it
              went. In source mode it lists the files that differ, and its
              links carry the baseline so they land on that file's diff. */}
          <Popover open={filesOpen} onOpenChange={setFilesOpen}>
            <PopoverTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 lg:hidden"
                data-toolbar-slot="files"
              >
                <span className="tabular-nums">
                  Files ({railEntries.length})
                </span>
                <ChevronDownIcon className="size-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="max-h-[55vh] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto"
            >
              <SpecFileList
                entries={railEntries}
                selectedPath={selectedPath}
                params={params}
                searchFor={fileSearch}
                unresolvedByPath={unresolvedByPath}
                sidebarStats={sidebarStats}
                onNavigate={() => setFilesOpen(false)}
              />
            </PopoverContent>
          </Popover>
          <ToolbarSlot name="comment-file" title={commentFileReason}>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              disabled={commentFileReason !== undefined}
              aria-label={
                commentFileReason === undefined
                  ? "Comment file"
                  : `Comment file — ${commentFileReason}`
              }
              onClick={() => {
                if (selected === undefined) return;
                stage({
                  path: selected.path,
                  version,
                  lineStart: null,
                  lineEnd: null,
                  colStart: null,
                  colEnd: null,
                  quote: "",
                });
              }}
            >
              Comment file
            </Button>
          </ToolbarSlot>
          <Button
            size="sm"
            data-toolbar-slot="finish-review"
            className="shrink-0"
            aria-label={
              drafts.drafts.length > 0
                ? `Finish review (${drafts.drafts.length} staged)`
                : "Finish review"
            }
            onClick={() => setFinishOpen(true)}
          >
            Finish review
            {/* T-190 reserved this box so staging the first draft would not
                widen the button — at the cost of 24px of hollow beside
                `Finish review` on every page with no drafts, which is every
                page most of the time. T-200 takes the one-off shift. */}
            {drafts.drafts.length > 0 && (
              <span
                aria-hidden
                className="inline-flex min-w-6 justify-center rounded-full bg-primary-foreground/20 px-1 tabular-nums"
              >
                {drafts.drafts.length}
              </span>
            )}
          </Button>
        </div>

        {/* Row B — how the document is drawn, then what is being read
            against what. The presentation switch, the version range and the
            compare toggle sit left of the row's one elastic gap, each sized
            to its own content; the display slot and ↑↓ are anchored right
            (T-192, reordered by T-200). */}
        <div ref={rowBRef} className="flex flex-wrap items-center gap-2">
          <ToolbarSlot name="view-toggle">
            <SpecViewToggle
              slug={slug}
              issueNumber={issueNumber}
              view={view}
              {...(comparing
                ? { searchFor: viewSearch }
                : { onSelect: setOffView })}
            />
          </ToolbarSlot>
          {/* shrink, not shrink-0: the message span's capped max-width is
              what a long push message truncates against, and this is what
              lets that happen rather than push the right-anchored cluster
              off the row. */}
          <ToolbarSlot name="version" className="min-w-0 shrink">
            <SpecVersionPicker
              slug={slug}
              issueNumber={issueNumber}
              versions={spec.versions}
              version={version}
              searchFor={versionSearch}
            />
          </ToolbarSlot>
          <ToolbarSlot name="compare" title={compareReason}>
            <SpecCompareToggle
              comparing={comparing}
              baseline={baseline}
              disabledReason={compareReason}
              onToggle={toggleComparing}
            />
          </ToolbarSlot>
          {baseline !== null && (
            <ToolbarSlot name="baseline" className="min-w-0 shrink">
              <SpecBaselinePicker
                slug={slug}
                issueNumber={issueNumber}
                versions={spec.versions}
                version={version}
                baseline={baseline}
                searchFor={baselineSearch}
              />
            </ToolbarSlot>
          )}
          <span className="ml-auto" />
          <ToolbarSlot name="display-toggle" title={wrapReason}>
            {renderedCompare && isNewFile ? (
              // Nothing is highlighted on a file the baseline never had, and
              // saying why beats leaving the reader to wonder.
              <span
                className={cn(DISPLAY_SLOT, DISPLAY_SLOT_ON)}
                title={`This file does not exist in v${baseline}`}
              >
                new in v{version}
              </span>
            ) : (
              <button
                type="button"
                aria-pressed={wrap}
                disabled={wrapReason !== undefined}
                aria-label={
                  wrapReason === undefined
                    ? "wrap long lines"
                    : `wrap — ${wrapReason}`
                }
                onClick={() => {
                  setWrap(!wrap);
                  writeDiffWrap(!wrap);
                }}
                className={cn(
                  DISPLAY_SLOT,
                  wrapReason === undefined
                    ? cn(
                        "cursor-pointer",
                        wrap ? DISPLAY_SLOT_ON : DISPLAY_SLOT_OFF,
                      )
                    : DISPLAY_SLOT_DISABLED,
                )}
                title={
                  wrapReason === undefined
                    ? "Wrap long lines instead of scrolling horizontally"
                    : undefined
                }
              >
                <WrapTextIcon className="size-3.5" />
                wrap
              </button>
            )}
          </ToolbarSlot>
          {/* One wrapping unit: two more controls landed in this row, and a
              narrow viewport was breaking the pair apart, stranding ↓ on a
              line of its own. */}
          <span className="inline-flex shrink-0 items-center gap-2">
            <ToolbarSlot name="prev-change" title={changeNav.reason}>
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={changeNav.reason !== undefined}
                aria-label={
                  changeNav.reason === undefined
                    ? `previous ${changeNav.unit}`
                    : `previous ${changeNav.unit} — ${changeNav.reason}`
                }
                onClick={() => (sourceDiff ? jumpFileDiff(-1) : jumpChange(-1))}
              >
                <ArrowUpIcon className="size-4" />
              </Button>
            </ToolbarSlot>
            <ToolbarSlot name="next-change" title={changeNav.reason}>
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={changeNav.reason !== undefined}
                aria-label={
                  changeNav.reason === undefined
                    ? `next ${changeNav.unit}`
                    : `next ${changeNav.unit} — ${changeNav.reason}`
                }
                onClick={() => (sourceDiff ? jumpFileDiff(1) : jumpChange(1))}
              >
                <ArrowDownIcon className="size-4" />
              </Button>
            </ToolbarSlot>
          </span>
        </div>
      </div>

      {/* One skeleton behind both presentations: the rail stays put across a
          rendered↔source switch, only its contents narrow (T-192). That also
          keeps the Files popover's "below lg only" rule true in every state,
          which is what T-190 §5 wanted from the rail. */}
      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        {/* self-start, or the grid would stretch the rail to the row's
            height and leave sticky nothing to travel through. */}
        <aside
          style={{
            top: stickyTop + 16,
            maxHeight: `calc(100vh - ${stickyTop + 32}px)`,
          }}
          className="hidden self-start space-y-1 overflow-y-auto overscroll-contain lg:sticky lg:block"
        >
          <SpecFileList
            entries={railEntries}
            selectedPath={selectedPath}
            params={params}
            searchFor={fileSearch}
            unresolvedByPath={unresolvedByPath}
            sidebarStats={sidebarStats}
          />
        </aside>
        <main
          className="min-w-0 space-y-4"
          style={{ scrollMarginTop: stickyTop + 8 }}
          ref={contentRef}
        >
          {sourceDiff && baseline !== null ? (
            <SpecDiff
              slug={slug}
              issueNumber={issueNumber}
              fromVersion={baseline}
              toFiles={files.data.files}
              toVersion={version}
              comments={comments.data.items}
              onStage={stage}
              focusPath={search.file}
              wrap={wrap}
              stickyTop={stickyTop}
            />
          ) : (
            <>
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
                          onClick={() => editDraft(draft)}
                        >
                          Edit
                        </Button>
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
              {fullSource && selected !== undefined ? (
                // Brings its own frame, so it stands outside the prose box.
                <SpecSourceFile
                  path={selected.path}
                  body={selected.body}
                  version={version}
                  annotations={displayed}
                  onStage={stage}
                  wrap={wrap}
                  stickyTop={stickyTop}
                />
              ) : (
                <div className="rounded-lg border px-5 py-4">
                  {selected === undefined ? (
                    selectedPath !== undefined &&
                    baseline !== null &&
                    removedFiles.includes(selectedPath) ? (
                      <RemovedFileNotice
                        path={selectedPath}
                        version={version}
                        params={params}
                        search={specSearchFor({
                          file: selectedPath,
                          v: search.v,
                          version,
                          baseline,
                          view: "source",
                        })}
                      />
                    ) : (
                      <p className="text-sm text-muted-foreground italic">
                        File not found in v{version}.
                      </p>
                    )
                  ) : (
                    <AnnotatedMarkdown
                      slug={slug}
                      issueNumber={issueNumber}
                      body={selected.body}
                      baselineBody={baselineBody}
                      refDate={
                        spec.versions.find((v) => v.number === version)
                          ?.created_at
                      }
                      annotations={displayed}
                      changedRanges={changedRanges}
                      onStage={(range) =>
                        stage({
                          path: selected.path,
                          version,
                          lineStart: range.lineStart,
                          lineEnd: range.lineEnd,
                          colStart: range.colStart,
                          colEnd: range.colEnd,
                          quote: quoteOf(
                            selected.body,
                            range.lineStart,
                            range.lineEnd,
                            range.colStart,
                            range.colEnd,
                          ),
                        })
                      }
                      onEditDraft={editDraft}
                      onRemoveDraft={drafts.remove}
                      onResolve={(id) => resolve.mutate(id)}
                      resolving={resolve.isPending}
                    />
                  )}
                </div>
              )}
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
            </>
          )}
        </main>
      </div>

      {staging !== null && (
        <SpecComposer
          // A new composer session gets a fresh editor; re-aiming the anchor
          // within one session keeps what has been typed (T-159).
          key={staging.session}
          slug={slug}
          staging={staging}
          initialBody={editingDraft?.body}
          editing={staging.draftId !== undefined}
          onCancel={() => setStaging(null)}
          onStage={(body) => {
            const next = {
              anchor: {
                path: staging.path,
                version: staging.version,
                line_start: staging.lineStart,
                line_end: staging.lineEnd,
                col_start: staging.colStart,
                col_end: staging.colEnd,
              },
              quote: staging.quote,
              body,
            };
            // Discarded from under the edit: keep the text rather than the
            // identity, and stage it as a new draft.
            if (editingDraft === undefined) drafts.add(next);
            else drafts.update(editingDraft.id, next);
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

/** One rail row: a file of the viewed version, or one the baseline had. */
type RailEntry = { path: string; removed: boolean };

/**
 * The file rail, rendered twice: as the sticky aside from lg up, and inside
 * the toolbar's Files popover below it (T-178).
 */
function SpecFileList({
  entries,
  selectedPath,
  params,
  searchFor,
  unresolvedByPath,
  sidebarStats,
  onNavigate,
}: {
  entries: RailEntry[];
  selectedPath?: string;
  params: { slug: string; number: string };
  /** Carries the version, baseline and presentation across a file switch. */
  searchFor: (path: string) => SpecSearch;
  unresolvedByPath: Map<string, number>;
  sidebarStats: Map<string, SpecFileStat>;
  onNavigate?: () => void;
}) {
  return (
    <div className="space-y-1">
      {entries.map((entry) => {
        const unresolved = unresolvedByPath.get(entry.path) ?? 0;
        const stat = sidebarStats.get(entry.path);
        return (
          <Link
            key={entry.path}
            to="/projects/$slug/issues/$number/spec"
            params={params}
            search={searchFor(entry.path)}
            title={entry.removed ? `${entry.path} (removed)` : entry.path}
            onClick={(event) => {
              // A modified click opens a background tab; tearing the
              // popover down under the reader's cursor would be wrong.
              if (
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              ) {
                return;
              }
              onNavigate?.();
            }}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
              entry.path === selectedPath
                ? "bg-muted font-medium"
                : "text-muted-foreground hover:bg-muted/50",
            )}
          >
            <FileTextIcon className="size-4 shrink-0" />
            <span
              className={cn(
                "truncate font-mono text-xs",
                entry.removed && "text-muted-foreground line-through",
              )}
            >
              {entry.path}
            </span>
            <span className="ml-auto inline-flex shrink-0 items-center gap-1.5">
              {unresolved > 0 && (
                <span className="rounded-full border border-amber-500/60 bg-amber-500/10 px-1.5 text-xs text-amber-700 dark:text-amber-400">
                  {unresolved}
                </span>
              )}
              {stat && (
                <span className="inline-flex items-center gap-1.5 text-[11px]">
                  <StatNumbers stat={stat} />
                  <DiffstatBar stat={stat} />
                </span>
              )}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

/**
 * Stand-in for a file the baseline had and this version does not. A rendered
 * document cannot draw a deletion, so the rail's removed rows land here and
 * hand the reader over to the one presentation that can (T-192).
 */
function RemovedFileNotice({
  path,
  version,
  params,
  search,
}: {
  path: string;
  version: number;
  params: { slug: string; number: string };
  search: SpecSearch;
}) {
  return (
    <div className="space-y-3 py-2 text-sm">
      <p>
        <span className="font-mono">{path}</span> was removed in v{version}.
      </p>
      <p className="text-muted-foreground">
        What it held is still readable as a deletion in the source diff.
      </p>
      <Button asChild size="sm" variant="outline">
        <Link
          to="/projects/$slug/issues/$number/spec"
          params={params}
          search={search}
        >
          Open the source diff
        </Link>
      </Button>
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
          {formatAnchorRange(item.anchor)} · v{item.anchor.version}
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
  wrap,
  stickyTop,
}: {
  slug: string;
  issueNumber: number;
  fromVersion: number;
  toFiles: SpecFile[];
  toVersion: number;
  comments: SpecCommentItem[];
  onStage: (staging: ComposerStaging) => void;
  /** Scroll this file's diff into view — the version card's per-file link (T-59). */
  focusPath?: string;
  wrap: boolean;
  /** Height of the shell header plus the page toolbar (T-178). */
  stickyTop: number;
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
    // The scroll just set is about to be pushed around: MultiFileDiff lays
    // out asynchronously, so at this point every diff above the target is
    // still ~0px tall and the viewport ends up back at the page top (T-188).
    // Re-anchor on each container growth, and hand the viewport back at the
    // user's first input — after that, re-anchoring would fight them.
    // (No settle timeout instead: highlight chunks land with unbounded gaps,
    // and a timer that fires inside one re-opens the race.)
    if (typeof ResizeObserver === "undefined") return; // happy-dom
    const container = el.parentElement ?? el;
    const observer = new ResizeObserver(() => {
      el.scrollIntoView({ block: "start" });
    });
    observer.observe(container);
    const controller = new AbortController();
    const release = () => {
      observer.disconnect();
      controller.abort();
    };
    for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) {
      window.addEventListener(type, release, {
        capture: true,
        passive: true,
        signal: controller.signal,
      });
    }
    return release;
  }, [focusPath]);
  const pairs = useMemo(() => {
    const before = new Map(from.data.files.map((f) => [f.path, f.body]));
    const after = new Map(toFiles.map((f) => [f.path, f.body]));
    return diffPaths(from.data.files, toFiles).map((path) => ({
      path,
      oldBody: before.get(path) ?? "",
      newBody: after.get(path) ?? "",
    }));
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
          data-file-diff={pair.path}
          ref={pair.path === focusPath ? focusRef : undefined}
          style={{ scrollMarginTop: stickyTop + 8 }}
        >
          <AnnotatedFileDiff
            path={pair.path}
            oldBody={pair.oldBody}
            newBody={pair.newBody}
            fromVersion={fromVersion}
            toVersion={toVersion}
            comments={comments.filter((c) => c.anchor.path === pair.path)}
            onStage={onStage}
            wrap={wrap}
            stickyTop={stickyTop}
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
  wrap,
  stickyTop,
}: {
  path: string;
  oldBody: string;
  newBody: string;
  fromVersion: number;
  toVersion: number;
  comments: SpecCommentItem[];
  onStage: (staging: ComposerStaging) => void;
  wrap: boolean;
  stickyTop: number;
}) {
  const oldFile = useMemo(
    () => ({ name: path, contents: oldBody }),
    [path, oldBody],
  );
  const newFile = useMemo(
    () => ({ name: path, contents: newBody }),
    [path, newBody],
  );
  const syntaxTheme = useSyntaxTheme();
  const options = useMemo(
    () => ({
      theme: syntaxTheme,
      themeType: PIERRE_THEME_TYPE,
      diffStyle: "unified" as const,
      overflow: wrap ? ("wrap" as const) : ("scroll" as const),
      preferredHighlighter: PIERRE_HIGHLIGHTER,
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
          // pierre selects by line number; an in-line anchor comes from the
          // rendered view (T-142 §9).
          colStart: null,
          colEnd: null,
          quote: quoteOf(body, lineStart, lineEnd),
        });
      },
    }),
    [
      path,
      oldBody,
      newBody,
      fromVersion,
      toVersion,
      onStage,
      syntaxTheme,
      wrap,
    ],
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
    // `clip` rather than `hidden`: both round the corners the same way, but
    // an `overflow: hidden` ancestor becomes the scrollport its sticky
    // descendants are measured against, which pins the path header to the
    // top of the diff instead of the viewport (T-178).
    <div className="overflow-clip rounded-lg border">
      <div
        style={{ top: stickyTop }}
        className="sticky z-20 border-b bg-background/95 px-3 py-1.5 font-mono text-xs backdrop-blur"
      >
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

/**
 * One version's markdown, whole — the source view with nothing to compare
 * against (T-200).
 *
 * pierre's `File` rather than a diff of the file against itself: identical
 * sides produce zero hunks, and a hunkless `MultiFileDiff` renders its header
 * and nothing else (`expandUnchanged` expands the context around hunks, so it
 * has nothing to work with either). `File` costs nothing in return — line
 * selection, annotations and wrapping all behave as they do in the diff.
 */
function SpecSourceFile({
  path,
  body,
  version,
  annotations,
  onStage,
  wrap,
  stickyTop,
}: {
  path: string;
  body: string;
  version: number;
  /** As remapped for the rendered view — the same comments, same lines. */
  annotations: DisplayedAnnotation[];
  onStage: (staging: ComposerStaging) => void;
  wrap: boolean;
  /** Height of the shell header plus the page toolbar (T-178). */
  stickyTop: number;
}) {
  const file = useMemo(() => ({ name: path, contents: body }), [path, body]);
  const syntaxTheme = useSyntaxTheme();
  const options = useMemo(
    () => ({
      theme: syntaxTheme,
      themeType: PIERRE_THEME_TYPE,
      overflow: wrap ? ("wrap" as const) : ("scroll" as const),
      preferredHighlighter: PIERRE_HIGHLIGHTER,
      disableFileHeader: true,
      /**
       * pierre's `File` abandons its first render while the shared
       * highlighter is still loading, and re-arms itself only through the
       * header: a remount finds the empty `<pre>` the abandoned render left
       * behind, and with the header disabled it concludes there is nothing
       * left to draw and takes the already-hydrated path — where the
       * highlighter's completion callback can no longer reach it. The box
       * then stays blank for good. Any remount does it and StrictMode
       * remounts everything, so in development it is the normal case. One
       * `rerender` puts the instance back on the path the diff components,
       * which keep their header, never leave.
       */
      onPostRender: (
        node: HTMLElement,
        instance: { rerender: () => void },
        phase: "mount" | "update" | "unmount",
      ) => {
        if (phase === "unmount" || body.length === 0) return;
        const pre = node.shadowRoot?.querySelector("pre");
        if (pre == null || pre.childElementCount > 0) return;
        instance.rerender();
      },
      enableLineSelection: true,
      onLineSelectionEnd: (range: SelectedLineRange | null) => {
        if (!range) return;
        const lineStart = Math.min(range.start, range.end);
        const lineEnd = Math.max(range.start, range.end);
        onStage({
          path,
          version,
          lineStart,
          lineEnd,
          // pierre selects by line number; an in-line anchor comes from the
          // rendered view (T-142 §9).
          colStart: null,
          colEnd: null,
          quote: quoteOf(body, lineStart, lineEnd),
        });
      },
    }),
    [path, body, version, onStage, syntaxTheme, wrap],
  );
  // Drafts stay out, as they do in the source diff; file-level comments have
  // their own strip above and never reach `annotations`.
  const lineAnnotations = useMemo(
    () =>
      annotations
        .filter((a) => a.kind === "comment")
        .map((a) => ({ lineNumber: a.start, metadata: a.item })),
    [annotations],
  );

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Drag across line numbers to comment on a range (anchors to v{version}).
      </p>
      {/* `clip` rather than `hidden`, for the sticky path header — see
          AnnotatedFileDiff. */}
      <div className="overflow-clip rounded-lg border">
        <div
          style={{ top: stickyTop }}
          className="sticky z-20 border-b bg-background/95 px-3 py-1.5 font-mono text-xs backdrop-blur"
        >
          {path}
        </div>
        <PierreFile<SpecCommentItem>
          file={file}
          options={options}
          lineAnnotations={lineAnnotations}
          renderAnnotation={(annotation) => (
            <DiffAnnotation item={annotation.metadata} />
          )}
        />
      </div>
    </div>
  );
}

function DiffAnnotation({ item }: { item: SpecCommentItem }) {
  return (
    <div className="border-y bg-background px-3 py-2 text-sm">
      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        <UserChip user={item.author} />
        <span>
          {formatAnchorRange(item.anchor)} · v{item.anchor.version}
        </span>
        {item.resolved !== null && (
          <span className="text-green-700 dark:text-green-400">resolved</span>
        )}
      </div>
      <p className="whitespace-pre-wrap">{item.body}</p>
    </div>
  );
}
