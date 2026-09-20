import { useQuery } from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import {
  enumLookup,
  formatRef,
  parseSearchQuery,
  type SearchDiagnostic,
  type SearchDomain,
  type SearchField,
  type SearchItem,
} from "@todou/shared";
import { ArrowRightIcon, ExternalLinkIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useJumpRows } from "@/api/ref-jump.ts";
import { useRefPrefix } from "@/api/references.ts";
import {
  domainsOf,
  type SearchPageSearch,
  searchQuery,
  withDomains,
} from "@/api/search.ts";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import { JumpRowBody } from "@/components/search/jump-row.tsx";
import { hasQualifier } from "@/components/search/suggestions.ts";
import { SearchHighlight } from "@/components/search-highlight.tsx";
import {
  LoadFailure,
  RefreshFailure,
} from "@/components/shared/load-failure.tsx";
import { ProjectIcon } from "@/components/shared/project-icon.tsx";
import {
  useRegisterReturnArea,
  useRegisterReturnLane,
  useReturnLinkState,
} from "@/components/shared/return-context.tsx";
import { Skeleton } from "@/components/ui/skeleton";
import { WINDOW_REGION } from "@/lib/return-view.ts";
import { commentAnchor } from "@/lib/timeline-anchors.ts";
import { useHeaderHeight } from "@/lib/use-header-height.ts";
import { SM_UP } from "@/lib/use-media-query.ts";
import { useReadFailure } from "@/lib/use-read-failure.ts";
import { useReturnView } from "@/lib/use-return-view.ts";
import { cn } from "@/lib/utils";

const DOMAIN_LABELS: Array<{ value: SearchDomain; label: string }> = [
  { value: "issues", label: "Issues" },
  { value: "comments", label: "Comments" },
  { value: "specs", label: "Specs" },
];

/** What a hit is called in its row, and where reading it continues. */
function whereLabel(item: SearchItem): string {
  const field = enumLookup(
    { title: "title", body: "body", path: "path" } satisfies Record<
      SearchField,
      string
    >,
    item.field,
    () => "unknown",
    "SearchItem.field",
  );
  return enumLookup(
    {
      issue: field,
      comment:
        item.comment_id === null ? "comment" : `#comment-${item.comment_id}`,
      spec: item.spec_path ?? "spec",
    } satisfies Record<SearchItem["kind"], string>,
    item.kind,
    () => "unknown",
    "SearchItem.kind",
  );
}

/**
 * Hits regrouped under their card, each group keeping its best hit's rank.
 * Exported for tests.
 */
export function groupByIssue(items: SearchItem[]): Array<{
  issue: SearchItem["issue"];
  hits: SearchItem[];
}> {
  const groups = new Map<
    number,
    { issue: SearchItem["issue"]; hits: SearchItem[] }
  >();
  for (const item of items) {
    const group = groups.get(item.issue.number);
    if (group) group.hits.push(item);
    else groups.set(item.issue.number, { issue: item.issue, hits: [item] });
  }
  return [...groups.values()];
}

/**
 * The rows a reading position is remembered against (T-407), read out of the
 * DOM: it is the laid-out element the sampler measures, not the hit. The rows
 * come back in document order, which is the order they are read in.
 */
function returnRows(
  root: HTMLElement | null,
): { id: string; element: HTMLElement }[] {
  if (root === null) return [];
  const found = root.querySelectorAll<HTMLElement>("[data-return-id]");
  return [...found].flatMap((element) => {
    const id = element.dataset.returnId;
    return id === undefined || id === "" ? [] : [{ id, element }];
  });
}

export function SearchPage() {
  const { slug } = useParams({ from: "/authed/projects/$slug" });
  const search = useSearch({ from: "/authed/projects/$slug/search" });
  // The snapshot is taken here rather than in the body, because
  // `useReturnView` needs the router and the body is mounted without one by
  // its tests. The body reports when its own rows are up (T-407).
  const [ready, setReady] = useState(false);
  // The route's search verbatim, `in` included. It has no control on this
  // page any more — the domain chips write `is:` into `q` — but an older
  // shared link still carries it, and a back link that dropped it would
  // return the reader to a wider set of results than they left.
  useReturnView({ target: { kind: "search", slug, search }, ready });
  return <SearchResults slug={slug} search={search} onReady={setReady} />;
}

/** The page proper, addressable without the router context. Exported for tests. */
export function SearchResults({
  slug,
  search,
  onReady,
}: {
  slug: string;
  search: SearchPageSearch;
  /** Whether the results are up; see `useReturnView`'s `ready`. */
  onReady?: (ready: boolean) => void;
}) {
  const q = (search.q ?? "").trim();
  const query = searchQuery(slug, search);
  const results = useQuery(query);
  const prefix = useRefPrefix(slug);
  const data = results.data;
  const hasContent = data !== undefined;
  const { replace, notice } = useReadFailure(
    [results.isError ? results.error : null],
    hasContent,
    query.queryKey,
  );
  const linkState = useReturnLinkState();
  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const headerHeight = useHeaderHeight();

  // An empty box is ready with no rows at all: `searchQuery` is disabled for
  // an empty `q`, so waiting for it would wait forever. A failed read stays
  // not ready on purpose — the restore keeps waiting, so a reader who hits
  // Retry still lands where they left off (T-407).
  const rowsReady = q === "" || hasContent;
  useEffect(() => {
    onReady?.(rowsReady);
  }, [onReady, rowsReady]);

  // Declared rather than left out, so that this page having no Load more is a
  // decision and not an omission somebody restores by hand: every hit it will
  // ever show arrives in one read, and `has_more` only renders a `+`.
  useRegisterReturnLane(null);
  // The shell header, plus the results heading once it pins (T-454). The
  // domain chips scroll away with everything else, so they are not in it.
  // Measured when it is asked for rather than carried in state: the heading is
  // not rendered at all while the page is still its own skeleton, and an
  // anchor captured against an inset of 0 restores a whole strip out (T-407).
  useRegisterReturnArea({
    region: WINDOW_REGION,
    element: () => null,
    rows: () => returnRows(rootRef.current),
    inset: () =>
      resultsStickyTop(
        headerHeight,
        headingRef.current?.getBoundingClientRect().height ?? 0,
        // `SM_UP` is the same breakpoint the heading's `sm:sticky` names.
        window.matchMedia(SM_UP).matches,
      ),
    axis: "y",
  });

  return (
    <div ref={rootRef} className="space-y-5">
      {/* What was searched for, kept on screen while the hits scroll past it
          (T-454) — the box in the header is a control, not a record, and on a
          phone it is folded away to an icon. It pins from `sm` for the reason
          the list page's toolbar does: below that the header is two rows
          already, and a third pinned strip costs more of a short viewport
          than the reminder is worth. `-mx-4 px-4` lets the backdrop bleed
          into the shell's own horizontal padding. */}
      <div
        ref={headingRef}
        style={{ top: headerHeight }}
        className="-mx-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-1.5 sm:sticky sm:z-30 sm:bg-background/95 sm:backdrop-blur"
      >
        <h2 className="font-heading text-lg font-medium">
          {q === "" ? "Search" : `Results for “${q}”`}
        </h2>
        {hasContent && !replace && (
          <p className="text-sm text-muted-foreground">
            {data?.items.length}
            {data?.has_more ? "+" : ""} hit
            {data?.items.length === 1 && !data.has_more ? "" : "s"}
          </p>
        )}
      </div>

      <DomainFilter slug={slug} search={search} />

      <JumpBanner slug={slug} q={q} />

      {hasContent && !replace && (
        <Diagnostics items={data?.diagnostics ?? []} />
      )}

      {q === "" ? (
        <SyntaxHelp />
      ) : replace ? (
        <Empty>
          <LoadFailure
            message={`Search failed: ${replace}`}
            detail={replace}
            onRetry={() => results.refetch()}
            retrying={results.isFetching}
          />
        </Empty>
      ) : !hasContent ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : (
        <>
          {notice && (
            <RefreshFailure
              what="these results"
              detail={notice}
              onRetry={() => results.refetch()}
              retrying={results.isFetching}
            />
          )}
          {data.items.length === 0 ? (
            <Empty>
              Nothing matched. Trashed cards, and every spec version but the
              newest, are deliberately not searchable.
            </Empty>
          ) : (
            <ul className="space-y-4">
              {groupByIssue(data.items).map((group) => (
                <li
                  key={group.issue.number}
                  className="overflow-hidden rounded-lg border"
                >
                  <Link
                    to="/projects/$slug/issues/$number"
                    params={{ slug, number: String(group.issue.number) }}
                    state={linkState}
                    className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2 hover:bg-accent"
                  >
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {formatRef(prefix, group.issue.number)}
                    </span>
                    <span className="truncate font-medium">
                      {group.issue.title}
                    </span>
                    <StatusPill
                      status={group.issue.status}
                      className="ml-auto shrink-0"
                    />
                  </Link>
                  <ul>
                    {group.hits.map((hit) => {
                      const key = hitKey(hit);
                      return (
                        // `hitKey` is unique only inside one card's group — a
                        // title hit spells the same key on every card — so the
                        // identity a snapshot remembers has to name the card
                        // too (T-407).
                        <li
                          key={key}
                          data-return-id={`${group.issue.number}:${key}`}
                        >
                          <HitRow slug={slug} hit={hit} />
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function hitKey(hit: SearchItem): string {
  return `${hit.kind}:${hit.comment_id ?? hit.spec_path ?? hit.field}`;
}

/**
 * Where a restored reading position has to stop: under the app header, plus
 * the results heading wherever that heading pins. Both are measured rather
 * than named in CSS — the header gains a row on narrow viewports, and the
 * heading wraps at widths no breakpoint knows. Exported for tests.
 */
export function resultsStickyTop(
  headerHeight: number,
  headingHeight: number,
  headingPins: boolean,
): number {
  return headerHeight + (headingPins ? headingHeight : 0);
}

/**
 * What the server made of the query, above the results rather than instead of
 * them. A label that has since been renamed turns a shared link into zero
 * hits; the reader needs to be told which word to change, and an error page
 * would tell them nothing.
 */
function Diagnostics({ items }: { items: SearchDiagnostic[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="space-y-1 rounded-lg border border-amber-500/60 bg-amber-500/10 px-4 py-3 text-sm">
      {items.map((item) => (
        <li
          key={`${item.key}:${item.value ?? ""}:${item.message}`}
          className={
            item.severity === "error"
              ? "text-amber-700 dark:text-amber-400"
              : "text-muted-foreground"
          }
        >
          {item.message}
          {item.suggestion !== null && (
            <>
              {" — did you mean "}
              <code className="font-mono">{item.suggestion}</code>?
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

const SYNTAX: Array<[string, string]> = [
  ["is:body,comment,spec", "which unit a hit is"],
  ["state:open", "the card's status category"],
  ["status:“In Progress”", "the card's status, by name"],
  ["label:kind:bug", "a label on the card"],
  ["assignee:@me", "who the card is assigned to"],
  ["harness:codex", "which agent wrote the matched text"],
  ["session:<id>", "which agent session wrote it"],
];

/** The empty state, doubling as the only place the syntax is written out. */
function SyntaxHelp() {
  return (
    <div className="space-y-4 rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
      <p>
        Terms are ANDed and each one matches anywhere inside the text, so{" "}
        <code>WordDiff</code> finds <code>coalescedWordDiff</code> — and the
        same rule is what makes Chinese, Japanese and Korean searchable, since
        those scripts leave no spaces to split a query on. Quote a phrase to
        keep it together.
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {SYNTAX.map(([syntax, means]) => (
          <div key={syntax} className="contents">
            <dt className="font-mono text-xs text-foreground">{syntax}</dt>
            <dd>{means}</dd>
          </div>
        ))}
      </dl>
      <p>
        A comma is any-of and repeating a key is all-of, so{" "}
        <code>label:a,b</code> is either and <code>label:a label:b</code> is
        both; a leading <code>-</code> inverts one of them.{" "}
        <code>harness:</code> and <code>session:</code> follow the text that
        matched, not the card. A key todou does not know stays plain text —{" "}
        <code>area:web</code> is a label name here — so a known one is searched
        literally by quoting it: <code>"harness:"</code>. The same query means
        the same thing in <code>todou search</code>.
      </p>
    </div>
  );
}

const JUMP_BOX =
  "flex items-center gap-2 rounded-lg border border-dashed px-4 py-3 text-sm hover:bg-accent";

/**
 * What the query names outright, if it names anything. A reader who pastes
 * a ref means that card, and search would only find it if some *text*
 * happened to spell the ref — so it is offered as a jump rather than left
 * to an accidental match. This is also where a shared `?q=T-141` link
 * lands, which is why the offer lives on the page and not only in the box.
 *
 * Nothing is drawn while the lookup is in flight: a box that appears
 * without a title, one line above the results, would push them down just
 * as they arrive. Nor for a query carrying a qualifier — following an offer
 * that quietly drops `label:bug` would go somewhere the reader did not ask
 * for (T-262).
 */
function JumpBanner({ slug, q }: { slug: string; q: string }) {
  const rows = useJumpRows(slug, hasQualifier(parseSearchQuery(q)) ? "" : q);
  const linkState = useReturnLinkState();
  return (
    <>
      {rows.map((row) => {
        if (row.kind === "external") {
          return (
            // A new tab: this one leaves todou, unlike an autolink clicked
            // mid-sentence, which the reader is following as they read.
            <a
              key={row.href}
              href={row.href}
              target="_blank"
              rel="noreferrer"
              className={JUMP_BOX}
            >
              <JumpRowBody
                icon={
                  <ExternalLinkIcon
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                }
                spelled={row.text}
                identity={null}
                text={row.host}
                textClassName="text-muted-foreground"
              />
            </a>
          );
        }
        if (row.kind === "project") {
          return (
            <Link
              key={row.slug}
              to="/projects/$slug"
              params={{ slug: row.slug }}
              className={JUMP_BOX}
            >
              <JumpRowBody
                icon={
                  <ArrowRightIcon
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                }
                spelled={row.spelled}
                identity={null}
                refClassName="text-muted-foreground"
                lead={
                  <ProjectIcon
                    project={{
                      name: row.name,
                      prefix: row.prefix,
                      icon_url: row.icon_url,
                    }}
                    className="size-5 shrink-0"
                    aria-hidden
                  />
                }
                text={row.name}
                textClassName="font-medium"
              />
            </Link>
          );
        }
        if (row.state !== "ready") return null;
        return (
          <Link
            key={row.spelled}
            to="/projects/$slug/issues/$number"
            params={{ slug: row.slug, number: String(row.number) }}
            hash={
              row.commentId === undefined
                ? undefined
                : commentAnchor(row.commentId)
            }
            // The timeline owns anchor positioning; the router's own scroll
            // races it.
            hashScrollIntoView={false}
            state={linkState}
            className={JUMP_BOX}
          >
            <JumpRowBody
              icon={
                <ArrowRightIcon
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
              }
              spelled={row.spelled}
              identity={{
                slug: row.slug,
                prefix: row.prefix,
                number: row.number,
                ...(row.commentId === undefined
                  ? {}
                  : { commentId: row.commentId }),
              }}
              refClassName="text-muted-foreground"
              text={row.item.title}
              textClassName="font-medium"
              author={row.commentBy}
              trailing={
                <StatusPill status={row.item.status} className="shrink-0" />
              }
            />
          </Link>
        );
      })}
    </>
  );
}

/**
 * One hit, as a real link to the thing it found — comments carry their
 * permalink fragment, spec hits open the file they matched in.
 */
function HitRow({ slug, hit }: { slug: string; hit: SearchItem }) {
  const linkState = useReturnLinkState();
  const body = (
    <>
      <span className="shrink-0 pt-px font-mono text-xs text-muted-foreground">
        {whereLabel(hit)}
      </span>
      <span className="min-w-0 text-sm break-words">
        <SearchHighlight snippet={hit.snippet} />
        {/* Search sees across hidden comments while the timeline collapses
            them, so the row says which kind of place the reader is about to
            land in (T-281). */}
        {hit.hidden && (
          <span
            className="ml-2 align-middle text-xs text-muted-foreground"
            data-testid="hit-hidden-badge"
          >
            hidden
          </span>
        )}
      </span>
    </>
  );
  const className =
    "flex items-start gap-3 px-4 py-2 hover:bg-accent border-t first:border-t-0";

  if (hit.kind === "spec") {
    return (
      <Link
        to="/projects/$slug/issues/$number/spec"
        params={{ slug, number: String(hit.issue.number) }}
        search={hit.spec_path === null ? {} : { file: hit.spec_path }}
        state={linkState}
        className={className}
      >
        {body}
      </Link>
    );
  }
  return (
    <Link
      to="/projects/$slug/issues/$number"
      params={{ slug, number: String(hit.issue.number) }}
      hash={hit.comment_id === null ? undefined : commentAnchor(hit.comment_id)}
      // The timeline owns anchor positioning; the router's own scroll races it.
      hashScrollIntoView={false}
      state={linkState}
      className={className}
    >
      {body}
    </Link>
  );
}

/**
 * Domain chips. They rewrite this page's own search params, which is the
 * case `navigate()` is for — there is no destination until the click.
 *
 * They write `is:` into the query rather than `?in=`, so the box above shows
 * what the chips did and the same string can be pasted into `todou search`.
 * An older link's `?in=` still selects the chips on arrival, and the first
 * click folds it into the query and drops it — one fact in one place from
 * then on.
 */
function DomainFilter({
  slug,
  search,
}: {
  slug: string;
  search: SearchPageSearch;
}) {
  const navigate = useNavigate();
  const selected = domainsOf(search);
  const toggle = (value: SearchDomain) => {
    const next = selected.includes(value)
      ? selected.filter((d) => d !== value)
      : [...selected, value];
    navigate({
      to: "/projects/$slug/search",
      params: { slug },
      search: {
        ...search,
        q: withDomains(search.q ?? "", next),
        in: undefined,
      },
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <SearchIcon className="size-4 text-muted-foreground" aria-hidden />
      {DOMAIN_LABELS.map((domain) => {
        // No selection means all three, so nothing is drawn as excluded.
        const on = selected.length === 0 || selected.includes(domain.value);
        return (
          <button
            key={domain.value}
            type="button"
            onClick={() => toggle(domain.value)}
            aria-pressed={selected.includes(domain.value)}
            className={cn(
              "rounded-full border px-3 py-0.5 text-xs transition-colors",
              on
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {domain.label}
          </button>
        );
      })}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
