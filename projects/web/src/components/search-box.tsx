import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { ArrowRightIcon, ExternalLinkIcon, SearchIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { projectQuery } from "@/api/queries.ts";
import {
  type JumpRow,
  type JumpTarget,
  jumpDestinationPromise,
  useJumpRows,
} from "@/api/ref-jump.ts";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { commentAnchor } from "@/lib/timeline-anchors.ts";
import { cn } from "@/lib/utils";

/** Where `/` must not steal the keystroke: the user is already typing. */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

/** The last row, always present: what the box did before it understood refs. */
type SearchRow = { kind: "search" };
type BoxRow = JumpRow | SearchRow;

type Destination =
  | { to: "card"; target: JumpTarget }
  | { to: "external"; href: string }
  | { to: "search" };

/** Would this row leave the project? The search row then says where it searches. */
function pointsElsewhere(row: JumpRow, slug: string): boolean {
  if (row.kind === "external") return true;
  return row.state === "ready" ? row.crossProject : row.candidate.slug !== slug;
}

const OPTION = "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm";

/**
 * The project's search box, in the header on every project page (T-141).
 *
 * A form, not a button with a handler: Enter submits it the way every search
 * box on the web does, and the browser's own autofill and history come with
 * that for free. The destination is a page, so submitting navigates there
 * rather than searching in place — which is also what makes a result URL
 * shareable.
 *
 * A query that is entirely one reference gets a listbox under the box
 * offering that card, and Enter follows the highlight (T-215). A hand-rolled
 * combobox rather than a radix popover: focus has to stay in the input, and
 * `Content` wants to take it. Nothing is offered for a query that is not a
 * reference, and then the box behaves exactly as it did.
 */
export function SearchBox({
  slug,
  className,
  listAlign = "end",
}: {
  slug: string;
  className?: string;
  /** `stretch` matches the box's own width — for the narrow header row, where it is `flex-1`. */
  listAlign?: "end" | "stretch";
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
  const [highlight, setHighlight] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const lastSeen = useRef(urlQuery);
  if (lastSeen.current !== urlQuery) {
    lastSeen.current = urlQuery;
    setValue(urlQuery);
    setDismissed(false);
    setHighlight(0);
  }

  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // The header mounts two of these (wide and narrow); a written id would
  // put the same one on both listboxes.
  const listId = useId();
  const project = useQuery(projectQuery(slug));
  const jumpRows = useJumpRows(slug, value);

  const rows: BoxRow[] = [...jumpRows, { kind: "search" }];
  const open = focused && !dismissed && rows.length > 1;
  // Clamped rather than reset as rows arrive: a reader who arrowed down to
  // the search row keeps it when the card above them finishes loading.
  const hl = Math.min(highlight, rows.length - 1);
  const elsewhere = jumpRows.some((row) => pointsElsewhere(row, slug));
  const query = value.trim();
  const optionId = (idx: number) => `${listId}-${idx}`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /**
   * Where Enter goes. Anything the reader can see decides it outright; a
   * row that is still loading, or a list that has not appeared yet, is
   * waited for instead — pasting a ref and hitting Enter in the same beat
   * has to reach the same place as waiting for the row first.
   */
  const decide = async (): Promise<Destination> => {
    // Esc hid the offer, and hiding it has to mean something: Enter then
    // does the plain thing rather than following an invisible highlight.
    if (dismissed) return { to: "search" };
    const chosen = open ? rows[hl] : undefined;
    if (chosen?.kind === "search") return { to: "search" };
    if (chosen?.kind === "external")
      return { to: "external", href: chosen.href };
    if (chosen?.kind === "issue" && chosen.state === "ready") {
      return { to: "card", target: chosen };
    }
    setWaiting(true);
    try {
      const found = await jumpDestinationPromise(queryClient, slug, value);
      if (found?.kind === "issue") return { to: "card", target: found.target };
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
      if (!open) return;
      setDismissed(true);
    } else if (!open) {
      return;
    } else if (e.key === "ArrowDown") {
      setHighlight(Math.min(hl + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      setHighlight(Math.max(hl - 1, 0));
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
          className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          ref={input}
          type="search"
          name="q"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open ? optionId(hl) : undefined}
          aria-autocomplete="list"
          aria-busy={waiting || undefined}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setDismissed(false);
            setHighlight(0);
          }}
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
          className="pl-7"
        />
      </form>
      {open && (
        <div
          ref={list}
          id={listId}
          role="listbox"
          aria-label="Jump to"
          // Without this, pressing on a row blurs the input first and the
          // listbox is gone before the click arrives.
          onMouseDown={(e) => e.preventDefault()}
          className={cn(
            // Anchored right and grown leftward, never `left-0`: a min-width
            // wider than the box would resolve the over-constraint by
            // ignoring `right` and running off the edge of the screen.
            "absolute top-full right-0 z-50 mt-1 min-w-80 max-w-[calc(100vw-2rem)] rounded-lg border bg-popover p-1 shadow-lg ring-1 ring-foreground/5",
            // On the narrow row the box is what there is room for; the panel
            // takes its width and stops. `min-w-80` still floors it, because
            // that row can squeeze the box down to ~150px and a title has to
            // survive (T-215).
            listAlign === "stretch" ? "w-full" : "max-w-[28rem]",
          )}
        >
          {rows.map((row, idx) => {
            if (row.kind === "search") {
              return (
                <Link
                  key="search"
                  to="/projects/$slug/search"
                  params={{ slug }}
                  search={{ q: query }}
                  {...optionProps(idx)}
                  onMouseMove={() => setHighlight(idx)}
                  onClick={closeUnlessNewTab}
                >
                  <SearchIcon
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="truncate">
                    Search for “{query}”
                    {elsewhere && ` in ${project.data?.name ?? slug}`}
                  </span>
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
