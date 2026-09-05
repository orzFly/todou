import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  type Project,
  parseSearchQuery,
  type ReferenceDirectory,
} from "@todou/shared";
import {
  ArrowRightIcon,
  ExternalLinkIcon,
  FilterIcon,
  FolderIcon,
  SearchIcon,
  TagIcon,
} from "lucide-react";
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  labelsQuery,
  membersQuery,
  projectQuery,
  projectsQuery,
  statusesQuery,
} from "@/api/queries.ts";
import {
  type JumpRow,
  type JumpTarget,
  jumpDestinationPromise,
  type ProjectPeekRow,
  useJumpRows,
  useProjectPeek,
} from "@/api/ref-jump.ts";
import { referenceDirectoryQuery } from "@/api/references.ts";
import { searchFacetsQuery } from "@/api/search.ts";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import {
  highlightParts,
  type KnownValues,
} from "@/components/search/highlight.tsx";
import {
  type CaretPosition,
  QualifierInput,
} from "@/components/search/qualifier-input.tsx";
import {
  type CompletionRow,
  hasQualifier,
  orderRows,
  type ProjectRefOption,
  projectRefSource,
  qualifierKeySource,
  qualifierValueSource,
  type ValuePools,
} from "@/components/search/suggestions.ts";
import { Skeleton } from "@/components/ui/skeleton";
import { commentAnchor } from "@/lib/timeline-anchors.ts";
import { useSlashShortcut } from "@/lib/use-slash-shortcut.ts";
import { cn } from "@/lib/utils";

/** The last row, always present: what the box did before it understood refs. */
type SearchRow = { kind: "search" };
type CompletionBoxRow = { kind: "completion"; row: CompletionRow };
type BoxRow = JumpRow | ProjectPeekRow | SearchRow | CompletionBoxRow;

type Destination =
  | { to: "card"; target: JumpTarget }
  | { to: "project"; slug: string }
  | { to: "external"; href: string }
  | { to: "search" };

/** Would this row leave the project? The search row then says where it searches. */
function pointsElsewhere(row: JumpRow, slug: string): boolean {
  if (row.kind === "external") return true;
  if (row.kind === "project") return row.slug !== slug;
  return row.state === "ready" ? row.crossProject : row.candidate.slug !== slug;
}

/**
 * How each project can be named, best spelling first (T-263). The prefix
 * form comes first because it is the shorter of two synonyms and the one a
 * card number attaches to directly.
 *
 * Retired claims are left out on purpose. They still *resolve* — someone
 * typing a project's old name from memory is exactly who `resolveSlugAt`
 * exists for — but a completion teaches a spelling, and there is no reason
 * to teach one that is on its way out. A contested prefix is left out for a
 * stronger reason: it resolves to nothing at all.
 */
function projectPool(
  projects: readonly Project[] | undefined,
  directory: ReferenceDirectory | null | undefined,
): ProjectRefOption[] {
  if (projects === undefined) return [];
  const now = Date.now();
  const covers = (from: string, to: string | null) =>
    Date.parse(from) <= now && (to === null || now < Date.parse(to));
  return projects.map((project) => {
    const claim = directory?.entries.find(
      (entry) => entry.slug === project.slug && covers(entry.from, entry.to),
    );
    const usable =
      claim !== undefined &&
      !(directory?.contested ?? []).some(
        (fight) =>
          fight.prefix === claim.prefix && covers(fight.from, fight.to),
      );
    return {
      slug: project.slug,
      name: project.name,
      spellings: usable
        ? [`${(claim as { prefix: string }).prefix}-`, `${project.slug}/`]
        : [`${project.slug}/`],
    };
  });
}

/**
 * `w-full` because a `<button>` row resolves `width: auto` to fit-content and
 * would otherwise shrink to a pill beside its full-width neighbours; on the
 * `<a>` and `<div>` rows, which are block already, it changes nothing.
 */
const OPTION = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm";

/** Nothing highlighted. Enter then submits what was typed, not an offer. */
const NONE = -1;

/**
 * One glyph per kind of offer. A row is a short run of monospace and a few
 * grey words, so the icon carries the whole distinction between a key, a
 * value and a project.
 */
const COMPLETION_ICON = {
  qualifier: FilterIcon,
  value: TagIcon,
  project: FolderIcon,
} satisfies Record<CompletionRow["icon"], typeof FilterIcon>;

/**
 * The project's search box, in the header on every project page (T-141),
 * with the qualifier syntax and its completions (T-262).
 *
 * A form, not a button with a handler: Enter submits it the way every search
 * box on the web does. The destination is a page, so submitting navigates
 * there rather than searching in place — which is also what makes a result
 * URL shareable.
 *
 * The listbox is hand-rolled rather than a radix popover because focus has to
 * stay in the input and `Content` wants to take it. Nothing is ever
 * preselected: the reader is typing a query, so Enter belongs to the query
 * unless they arrowed onto something else. Tab is the key that takes an offer.
 */
export function SearchBox({
  slug,
  className,
  listAlign = "centered",
  autoFocus = false,
  onEscape,
}: {
  slug: string;
  className?: string;
  /**
   * Where the offer grows from: `centered` about the box, for a box that
   * sits in the middle of its row; `start` from the box's left edge, for one
   * that starts at the edge of the screen.
   */
  listAlign?: "centered" | "start";
  /** Takes focus on mount, for a host that opened this box to be typed in. */
  autoFocus?: boolean;
  /**
   * Escape arriving with no offer left to close. The first press is the
   * box's own; where the second one goes is the host's to decide.
   */
  onEscape?: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Seeded from the URL so landing on /search with ?q= shows the query back,
  // and reseeded whenever it changes underneath (a shared link, the back
  // button) — but left alone while the user types.
  const urlQuery = useRouterState({
    select: (s) =>
      s.location.pathname.endsWith("/search")
        ? ((s.location.search as { q?: string }).q ?? "")
        : "",
  });
  const [value, setValue] = useState(urlQuery);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [highlight, setHighlight] = useState(NONE);
  const [waiting, setWaiting] = useState(false);
  const [position, setPosition] = useState<CaretPosition>({ caret: 0 });
  const lastSeen = useRef(urlQuery);
  if (lastSeen.current !== urlQuery) {
    lastSeen.current = urlQuery;
    setValue(urlQuery);
    setDismissed(false);
    setHighlight(NONE);
  }

  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const project = useQuery(projectQuery(slug));
  const parts = useMemo(() => parseSearchQuery(value), [value]);

  // Only once the box is in use: it is mounted on every project page, and
  // four lists nobody has asked for is four requests nobody wanted.
  const asked = focused && value !== "";
  const labels = useQuery({ ...labelsQuery(slug), enabled: asked });
  const statuses = useQuery({ ...statusesQuery(slug), enabled: asked });
  const members = useQuery({ ...membersQuery(slug), enabled: asked });
  const facets = useQuery(searchFacetsQuery(slug, asked));
  // The same two the jump offer reads, so completing a project name costs
  // nothing beyond what resolving one already did.
  const projects = useQuery({ ...projectsQuery, enabled: asked });
  const directory = useQuery({ ...referenceDirectoryQuery, enabled: asked });

  const pools: ValuePools = useMemo(
    () => ({
      label: labels.data?.map((l) => ({ value: l.name })),
      status: statuses.data?.map((s) => ({ value: s.name })),
      assignee: members.data?.map((m) => ({ value: m.user.login })),
      harness: facets.data?.harnesses
        .filter((h) => h.agent !== null)
        .map((h) => ({ value: h.agent as string, hint: String(h.count) })),
      session: facets.data?.sessions.map((s) => ({
        value: s.session_id,
        ...(s.agent === null ? {} : { hint: s.agent }),
      })),
    }),
    [labels.data, statuses.data, members.data, facets.data],
  );
  const known: KnownValues = useMemo(
    () => ({
      label: labels.data?.map((l) => l.name),
      status: statuses.data?.map((s) => s.name),
      assignee: members.data?.map((m) => m.user.login),
    }),
    [labels.data, statuses.data, members.data],
  );

  // A jump that silently drops `label:bug` is a lie about where it goes, so
  // the offer only stands for a query that is nothing but a reference.
  const jumpRows = useJumpRows(slug, hasQualifier(parts) ? "" : value);
  const named = jumpRows.find((row) => row.kind === "project");
  // A project named without a card is a weaker aim than a card: the reader
  // may well be on their way to one whose number they do not remember.
  const peek = useProjectPeek(
    slug,
    named?.kind === "project" ? named.slug : null,
  );
  const projectRefs = useMemo(
    () => projectPool(projects.data, directory.data),
    [projects.data, directory.data],
  );
  const completions = useMemo(() => {
    const ctx = { slug, query: value, caret: position.caret, parts };
    return [
      qualifierKeySource(ctx),
      qualifierValueSource(pools)(ctx),
      projectRefSource(projectRefs)(ctx),
    ];
  }, [slug, value, position.caret, parts, pools, projectRefs]);

  const rows: BoxRow[] = orderRows<BoxRow>(
    [
      // One source, so the ten-row budget covers the peek too: the home row
      // is what the reader named and the cards below it come out of the same
      // allowance as everything else (T-268).
      { matched: true, rows: [...jumpRows, ...peek] },
      ...completions.map((result) => ({
        matched: result.matched,
        rows: result.rows.map(
          (row): BoxRow => ({ kind: "completion" as const, row }),
        ),
      })),
    ],
    { kind: "search" },
  );
  const open = focused && !dismissed && rows.length > 1;
  const hl = highlight >= rows.length ? NONE : highlight;
  const elsewhere = jumpRows.some((row) => pointsElsewhere(row, slug));
  const query = value.trim();
  const optionId = (idx: number) => `${listId}-${idx}`;

  useSlashShortcut(() => {
    input.current?.focus();
    input.current?.select();
  });

  // Ten rows already keep the panel short in an ordinary window; this is the
  // floor under a short one, where even a few rows reach past the bottom.
  // Measured rather than a `calc(100vh - …)`, because the same box also grows
  // out of the narrow-screen overlay and the height above it is not a
  // constant. Before paint, or there is a frame of the too-tall panel.
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the panel opens or changes length
  useLayoutEffect(() => {
    const panel = list.current;
    if (panel === null) {
      setMaxHeight(undefined);
      return;
    }
    const measure = () => {
      setMaxHeight(window.innerHeight - panel.getBoundingClientRect().top - 8);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, rows.length]);

  // A scroll container can hold the highlight out of sight, and then the
  // arrow keys are moving something the reader cannot see. The rows are the
  // panel's only children, so the index is the child.
  useLayoutEffect(() => {
    if (hl === NONE) return;
    list.current?.children[hl]?.scrollIntoView({ block: "nearest" });
  }, [hl]);

  /** Accepting an offer rewrites the query; the caret goes where it says. */
  const pendingCaret = useRef<number | null>(null);
  const accept = (row: CompletionRow) => {
    setValue(row.apply.value);
    setHighlight(NONE);
    setDismissed(false);
    pendingCaret.current = row.apply.caret;
  };
  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    if (caret === null) return;
    pendingCaret.current = null;
    const el = input.current;
    if (el === null) return;
    el.focus();
    el.setSelectionRange(caret, caret);
  });

  /** The first row Tab may take — the search row and a jump are not offers. */
  const acceptable = (from: number): CompletionRow | null => {
    const at = rows[from];
    if (at?.kind === "completion") return at.row;
    for (const row of rows) if (row.kind === "completion") return row.row;
    return null;
  };

  /**
   * Where Enter goes. Anything the reader arrowed onto decides it outright; a
   * row that is still loading, or a list that has not appeared yet, is
   * waited for instead — pasting a ref and hitting Enter in the same beat
   * has to reach the same place as waiting for the row first.
   */
  const decide = async (): Promise<Destination> => {
    // Esc hid the offer, and hiding it has to mean something: Enter then
    // does the plain thing rather than following an invisible highlight.
    if (dismissed) return { to: "search" };
    const chosen = open && hl !== NONE ? rows[hl] : undefined;
    if (chosen?.kind === "search") return { to: "search" };
    if (chosen?.kind === "external")
      return { to: "external", href: chosen.href };
    if (chosen?.kind === "issue" && chosen.state === "ready") {
      return { to: "card", target: chosen };
    }
    if (chosen?.kind === "project") return { to: "project", slug: chosen.slug };
    if (chosen?.kind === "project-issue") {
      return {
        to: "card",
        target: { slug: chosen.slug, number: chosen.number },
      };
    }
    if (chosen?.kind === "completion") return { to: "search" };
    if (hasQualifier(parts)) return { to: "search" };
    setWaiting(true);
    try {
      const found = await jumpDestinationPromise(queryClient, slug, value);
      if (found?.kind === "issue") return { to: "card", target: found.target };
      if (found?.kind === "project") return { to: "project", slug: found.slug };
      if (found?.kind === "external")
        return { to: "external", href: found.href };
    } finally {
      setWaiting(false);
    }
    return { to: "search" };
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (query === "") return;
    const chosen = open && hl !== NONE ? rows[hl] : undefined;
    // Enter on a completion takes it and stays put; the reader is still
    // building the query, not asking for it.
    if (chosen?.kind === "completion") {
      accept(chosen.row);
      return;
    }
    const destination = await decide();
    setDismissed(true);
    if (destination.to === "card") {
      const { target } = destination;
      navigate({
        to: "/projects/$slug/issues/$number",
        params: { slug: target.slug, number: String(target.number) },
        ...(target.commentId === undefined
          ? {}
          : {
              hash: commentAnchor(target.commentId),
              // The timeline owns anchor positioning; the router's own
              // scroll races it.
              hashScrollIntoView: false,
            }),
      });
    } else if (destination.to === "project") {
      navigate({
        to: "/projects/$slug",
        params: { slug: destination.slug },
      });
    } else if (destination.to === "external") {
      // A tab opened after an await can meet a popup blocker — the click
      // that authorised it is no longer the task at hand. The row is a real
      // link so there is always a way that cannot be blocked.
      window.open(destination.href, "_blank", "noreferrer");
    } else {
      navigate({
        to: "/projects/$slug/search",
        params: { slug },
        search: { q: query },
      });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      if (!open) {
        onEscape?.();
        return;
      }
      setDismissed(true);
    } else if (e.key === "Tab" && open && !e.shiftKey) {
      const row = acceptable(hl);
      if (row === null) return;
      accept(row);
    } else if (!open) {
      return;
    } else if (e.key === "ArrowDown") {
      setHighlight(Math.min(hl + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      // Back past the first row is back to nothing selected, which is where
      // the box started and what Enter means by default.
      setHighlight(Math.max(hl - 1, NONE));
    } else if (e.key === "Home") {
      setHighlight(0);
    } else if (e.key === "End") {
      setHighlight(rows.length - 1);
    } else {
      return;
    }
    e.preventDefault();
  };

  // A modified click hands the link to the browser (new tab, new window), so
  // the box stays as it is — the reader is stacking tabs, not leaving.
  const closeUnlessNewTab = (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    setDismissed(true);
  };

  const optionProps = (idx: number) => ({
    id: optionId(idx),
    role: "option",
    // Focus never leaves the input; aria-activedescendant does the walking.
    tabIndex: -1,
    "aria-selected": idx === hl,
    className: cn(OPTION, idx === hl && "bg-accent"),
  });

  return (
    <search className={cn("relative", className)}>
      <form onSubmit={onSubmit}>
        <SearchIcon
          className="pointer-events-none absolute top-1/2 left-2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <QualifierInput
          inputRef={input}
          autoFocus={autoFocus}
          type="text"
          name="q"
          // T-262 kept the browser's own history for free; T-268 gives it
          // back. This box now has a panel of its own, the two drop-downs
          // cover each other, and the browser's knows neither the `label:`
          // syntax nor which labels this project has.
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && hl !== NONE ? optionId(hl) : undefined}
          aria-autocomplete="list"
          aria-busy={waiting || undefined}
          value={value}
          onValueChange={(next) => {
            setValue(next);
            setDismissed(false);
            setHighlight(NONE);
          }}
          onCaretChange={setPosition}
          render={(text) => highlightParts(text, parseSearchQuery(text), known)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={(e) => {
            // Clicking a row blurs the input before the click lands; the
            // listbox's own mousedown guard covers the pointer, this covers
            // a focus that really did move into it.
            if (list.current?.contains(e.relatedTarget)) return;
            setFocused(false);
          }}
          aria-label="Search this project"
          placeholder="Search…"
          padding="pl-7"
        />
      </form>
      {open && (
        <div
          ref={list}
          id={listId}
          role="listbox"
          aria-label="Search suggestions"
          // Without this, pressing on a row blurs the input first and the
          // listbox is gone before the click arrives.
          onMouseDown={(e) => e.preventDefault()}
          style={{ maxHeight }}
          className={cn(
            "absolute top-full z-50 mt-1 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg ring-1 ring-foreground/5",
            listAlign === "start"
              ? // The box starts at the edge of the screen, so the panel
                // takes its width and stops. A floor still applies, because
                // the narrowest phone squeezes the box down to ~250px and a
                // title has to survive (T-215) — but the floor stops at the
                // viewport, since a `min-width` beats a `max-width` and a
                // flat 20rem would push the page 16px wider at 320.
                "left-0 w-full min-w-[min(20rem,calc(100vw-2rem))]"
              : // Centred on the box, not on the caret: the panel following
                // the caret across the line made the reader chase it (T-268).
                "left-1/2 w-[28rem] -translate-x-1/2",
          )}
        >
          {rows.map((row, idx) => {
            if (row.kind === "search") {
              // With nothing typed there is no search to offer, so the row
              // stops pretending to be one: `Search for “”` searched for
              // nothing, while the page it leads to is a real destination —
              // the syntax help and the domain chips live there.
              const blank = query === "";
              return (
                <Link
                  key="search"
                  to="/projects/$slug/search"
                  params={{ slug }}
                  search={blank ? {} : { q: query }}
                  {...optionProps(idx)}
                  onMouseMove={() => setHighlight(idx)}
                  onClick={closeUnlessNewTab}
                >
                  {blank ? (
                    <ArrowRightIcon
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                  ) : (
                    <SearchIcon
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                  )}
                  <span className="truncate">
                    {blank ? (
                      "search page"
                    ) : (
                      <>
                        Search for “{query}”
                        {elsewhere && ` in ${project.data?.name ?? slug}`}
                      </>
                    )}
                  </span>
                </Link>
              );
            }
            if (row.kind === "completion") {
              const Icon = COMPLETION_ICON[row.row.icon];
              return (
                // A button, not a link: it goes nowhere, it rewrites the
                // query in place. Focus stays in the input regardless — the
                // listbox cancels the mousedown that would move it.
                <button
                  type="button"
                  key={row.row.key}
                  {...optionProps(idx)}
                  onMouseMove={() => setHighlight(idx)}
                  onClick={() => accept(row.row)}
                >
                  <Icon
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="truncate font-mono text-xs">
                    {row.row.text}
                  </span>
                  {row.row.hint !== undefined && (
                    <span className="truncate text-muted-foreground text-xs">
                      {row.row.hint}
                    </span>
                  )}
                </button>
              );
            }
            if (row.kind === "project") {
              return (
                <Link
                  key="project"
                  to="/projects/$slug"
                  params={{ slug: row.slug }}
                  {...optionProps(idx)}
                  onMouseMove={() => setHighlight(idx)}
                  onClick={closeUnlessNewTab}
                >
                  <ArrowRightIcon
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {row.spelled}
                  </span>
                  <span className="truncate">{row.name}</span>
                </Link>
              );
            }
            if (row.kind === "project-issue") {
              return (
                <Link
                  key={`peek-${row.number}`}
                  to="/projects/$slug/issues/$number"
                  params={{ slug: row.slug, number: String(row.number) }}
                  {...optionProps(idx)}
                  onMouseMove={() => setHighlight(idx)}
                  onClick={closeUnlessNewTab}
                >
                  {/* Where the arrow goes on every other row. These cards
                      are offered rather than asked for, and the empty
                      column is what says so — one indent, no new glyph. */}
                  <span className="size-3.5 shrink-0" aria-hidden />
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {row.spelled}
                  </span>
                  <span className="truncate">{row.item.title}</span>
                  <StatusPill
                    status={row.item.status}
                    className="ml-auto shrink-0"
                  />
                </Link>
              );
            }
            if (row.kind === "external") {
              return (
                // A new tab: this one leaves todou, unlike an autolink
                // clicked mid-sentence, which the reader is reading through.
                <a
                  key="external"
                  href={row.href}
                  target="_blank"
                  rel="noreferrer"
                  {...optionProps(idx)}
                  onMouseMove={() => setHighlight(idx)}
                  onClick={closeUnlessNewTab}
                >
                  <ExternalLinkIcon
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="shrink-0 font-mono text-xs">{row.text}</span>
                  <span className="truncate text-muted-foreground">
                    {row.host}
                  </span>
                </a>
              );
            }
            if (row.state === "pending") {
              return (
                // Not a link: there is nothing to point at yet. Enter still
                // reaches the card, by waiting for the lookup it is on.
                <div
                  key="card"
                  id={optionId(idx)}
                  role="option"
                  tabIndex={-1}
                  aria-selected={idx === hl}
                  aria-label="Looking up the card…"
                  className={cn(OPTION, idx === hl && "bg-accent")}
                >
                  <ArrowRightIcon
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <Skeleton className="h-4 w-40" />
                </div>
              );
            }
            return (
              <Link
                key="card"
                to="/projects/$slug/issues/$number"
                params={{ slug: row.slug, number: String(row.number) }}
                hash={
                  row.commentId === undefined
                    ? undefined
                    : commentAnchor(row.commentId)
                }
                hashScrollIntoView={false}
                {...optionProps(idx)}
                onMouseMove={() => setHighlight(idx)}
                onClick={closeUnlessNewTab}
              >
                <ArrowRightIcon
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {row.spelled}
                </span>
                <span className="truncate">{row.item.title}</span>
                {row.commentBy !== null && (
                  <span className="shrink-0 text-muted-foreground">
                    · comment by {row.commentBy}
                  </span>
                )}
                <StatusPill
                  status={row.item.status}
                  className="ml-auto shrink-0"
                />
              </Link>
            );
          })}
        </div>
      )}
    </search>
  );
}
