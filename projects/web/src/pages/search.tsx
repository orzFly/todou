import { EmptyState } from "@orz/ui/components/empty-state";
import { FieldDescription, FieldError } from "@orz/ui/components/field";
import { LinkCard } from "@orz/ui/components/link-card";
import { List, ListItem } from "@orz/ui/components/list";
import { LoadFailure, RefreshFailure } from "@orz/ui/components/load-failure";
import { Skeleton } from "@orz/ui/components/skeleton";
import { Toggle } from "@orz/ui/components/toggle";
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
  SEARCH_SCHEMA,
  type SearchDiagnostic,
  type SearchDomain,
  type SearchField,
  type SearchItem,
  type SearchQualifier,
} from "@todou/shared";
import { ArrowRightIcon, ExternalLinkIcon, SearchXIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useRefPlacement } from "@/api/prefs.ts";
import { type JumpRow, useJumpRows } from "@/api/ref-jump.ts";
import { useRefPrefix } from "@/api/references.ts";
import {
  correctedQuery,
  domainsOf,
  hasQualifier,
  type SearchPageSearch,
  searchQuery,
  withDomains,
} from "@/api/search.ts";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import { JumpRowBody } from "@/components/search/jump-row.tsx";
import { SearchBox } from "@/components/search-box.tsx";
import { SearchHighlight } from "@/components/search-highlight.tsx";
import { IssueTitle } from "@/components/shared/issue-title.tsx";
import { ProjectIcon } from "@/components/shared/project-icon.tsx";
import {
  useRegisterReturnArea,
  useRegisterReturnLane,
  useReturnLinkState,
} from "@/components/shared/return-context.tsx";
import { SM_UP } from "@/lib/breakpoints.ts";
import { WINDOW_REGION } from "@/lib/return-view.ts";
import { useShellHeader } from "@/lib/shell-header.ts";
import { commentAnchor } from "@/lib/timeline-anchors.ts";
import { headerBottom, useHeaderHeight } from "@/lib/use-header-height.ts";
import { useReadFailure } from "@/lib/use-read-failure.ts";
import { useReturnView } from "@/lib/use-return-view.ts";

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
  const data = results.data;
  const hasContent = data !== undefined;
  const { replace, notice } = useReadFailure(
    [results.isError ? results.error : null],
    hasContent,
    query.queryKey,
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const boxRowRef = useRef<HTMLDivElement>(null);
  const headerHeight = useHeaderHeight();
  const diagnosticsId = useId();
  // Not for a query carrying a qualifier: following a jump that quietly drops
  // `label:bug` would go somewhere the reader did not ask for (T-262).
  const jumpRows = useJumpRows(slug, hasQualifier(q) ? "" : q);
  // Only what is drawn: a lookup still in flight draws nothing.
  const jumps = jumpRows.filter(
    (row) => row.kind !== "issue" || row.state === "ready",
  );

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
  const header = useShellHeader();
  // The shell header, plus the query box's row once it pins (T-454).
  // Measured when it is asked for rather than carried in state: an anchor
  // captured against an inset of 0 restores a whole strip out (T-407).
  useRegisterReturnArea({
    region: WINDOW_REGION,
    element: () => null,
    rows: () => returnRows(rootRef.current),
    inset: () =>
      resultsStickyTop(
        headerBottom(header.current),
        boxRowRef.current?.getBoundingClientRect().height ?? 0,
        // `SM_UP` is the same breakpoint the row's `sm:sticky` names.
        window.matchMedia(SM_UP).matches,
      ),
    axis: "y",
  });

  const diagnostics = hasContent && !replace ? data.diagnostics : [];
  const failed = diagnostics.some((d) => d.severity === "error");
  const hits = hasContent && !replace ? data.items.length : 0;

  return (
    <div ref={rootRef} className="space-y-4">
      <h1 className="font-heading text-title font-semibold">Search</h1>

      {/* The query stays on screen while the hits scroll past it (T-454). It
          pins from `sm` for the reason the list page's toolbar does: below
          that the header is two rows already, and a third pinned strip costs
          more of a short viewport than the reminder is worth. `-mx-4 px-4`
          lets the backdrop bleed into the shell's own horizontal padding. */}
      <div
        ref={boxRowRef}
        style={{ top: headerHeight }}
        className="-mx-4 px-4 py-1.5 sm:sticky sm:z-30 sm:bg-background/95 sm:backdrop-blur"
      >
        <SearchBox
          slug={slug}
          query={search.q ?? ""}
          listAlign="start"
          className="w-full"
          invalid={failed}
          describedBy={diagnostics.length > 0 ? diagnosticsId : undefined}
        />
      </div>

      {diagnostics.length > 0 && (
        <Diagnostics
          id={diagnosticsId}
          items={diagnostics}
          slug={slug}
          search={search}
        />
      )}

      {q !== "" && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <DomainFilter slug={slug} search={search} />
          {hits > 0 && (
            <p className="ml-auto text-sm text-muted-foreground">
              {hits}
              {data?.has_more ? "+" : ""} hit
              {hits === 1 && !data?.has_more ? "" : "s"}
            </p>
          )}
        </div>
      )}

      {jumps.length > 0 && <JumpBanner rows={jumps} />}

      {q === "" ? (
        <SyntaxHelp />
      ) : replace ? (
        <LoadFailure
          message={`Search failed: ${replace}`}
          detail={replace}
          onRetry={() => results.refetch()}
          retrying={results.isFetching}
        />
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
            // A query that names a card or a project already has its answer
            // on screen, in the jump above.
            jumps.length === 0 && (
              <EmptyState
                icon={SearchXIcon}
                title="Nothing matched"
                className="py-10"
              >
                {/* With an error in the query, that is the reason, and it is
                    already said above. */}
                {failed
                  ? null
                  : "Trashed cards, and every spec version but the newest, are not searchable."}
              </EmptyState>
            )
          ) : (
            <ul className="space-y-4">
              {groupByIssue(data.items).map((group) => (
                <li key={group.issue.number}>
                  <IssueHits slug={slug} group={group} />
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
 * Whether a title hit is the whole title. The server folds whitespace before
 * it cuts a snippet and only opens a window past 121 code points, so a
 * snippet equal to the folded title is all of it. Exported for tests.
 */
export function wholeTitle(hit: SearchItem): boolean {
  return (
    hit.kind === "issue" &&
    hit.field === "title" &&
    hit.snippet.text === hit.issue.title.replace(/\s+/g, " ").trim()
  );
}

/** The List page's ref face (T-757). */
const REF =
  "shrink-0 whitespace-nowrap text-[13px] text-muted-foreground tabular-nums";

/**
 * One card and its hits. The first row is the card; a title hit that is the
 * whole title is drawn there, marked, rather than repeating the title on a
 * row of its own.
 */
function IssueHits({
  slug,
  group,
}: {
  slug: string;
  group: ReturnType<typeof groupByIssue>[number];
}) {
  const linkState = useReturnLinkState();
  const prefix = useRefPrefix(slug);
  const refLeads = useRefPlacement("list") === "before";
  const titled = group.hits.find(wholeTitle);
  const rest = group.hits.filter((hit) => hit !== titled);
  const ref = (
    <span className={REF}>{formatRef(prefix, group.issue.number)}</span>
  );
  return (
    <List purpose="collection" framed>
      <ul>
        <ListItem
          asChild
          // The id the title hit's own row had, so a position remembered
          // against it still restores (T-407).
          {...(titled === undefined
            ? {}
            : {
                "data-return-id": `${group.issue.number}:${hitKey(titled)}`,
              })}
        >
          <li>
            <Link
              to="/projects/$slug/issues/$number"
              params={{ slug, number: String(group.issue.number) }}
              state={linkState}
              className="flex items-baseline gap-x-2 bg-muted/40 px-4 py-2 hover:bg-accent"
            >
              {refLeads && ref}
              <span className="min-w-0 text-base font-medium wrap-break-word">
                {titled === undefined ? (
                  <IssueTitle item={group.issue} />
                ) : (
                  <SearchHighlight snippet={titled.snippet} />
                )}
              </span>
              {!refLeads && ref}
              <span className="ml-auto flex shrink-0">
                <StatusPill status={group.issue.status} />
              </span>
            </Link>
          </li>
        </ListItem>
        {rest.map((hit) => {
          const key = hitKey(hit);
          return (
            // `hitKey` is unique only inside one card's group — a title hit
            // spells the same key on every card — so the identity a snapshot
            // remembers has to name the card too (T-407).
            <ListItem
              asChild
              key={key}
              data-return-id={`${group.issue.number}:${key}`}
            >
              <li>
                <HitRow slug={slug} hit={hit} />
              </li>
            </ListItem>
          );
        })}
      </ul>
    </List>
  );
}

/**
 * Where a restored reading position has to stop: under the app header, plus
 * the query box's row wherever that row pins. Both are measured rather than
 * named in CSS — the header gains a row on narrow viewports. Exported for
 * tests.
 */
export function resultsStickyTop(
  headerHeight: number,
  boxRowHeight: number,
  boxRowPins: boolean,
): number {
  return headerHeight + (boxRowPins ? boxRowHeight : 0);
}

/**
 * What the server made of the query, under the box rather than instead of the
 * results. A label that has since been renamed turns a shared link into zero
 * hits; the reader needs to be told which word to change, and an error page
 * would tell them nothing.
 */
function Diagnostics({
  id,
  items,
  slug,
  search,
}: {
  id: string;
  items: SearchDiagnostic[];
  slug: string;
  search: SearchPageSearch;
}) {
  return (
    <div id={id} className="space-y-1">
      {items.map((item) => {
        const Line = item.severity === "error" ? FieldError : FieldDescription;
        const corrected = correctedQuery(search.q ?? "", item);
        const suggestion = <code className="font-mono">{item.suggestion}</code>;
        return (
          <Line key={`${item.key}:${item.value ?? ""}:${item.message}`}>
            {item.message}
            {item.suggestion !== null && (
              <>
                {" — did you mean "}
                {corrected === null ? (
                  suggestion
                ) : (
                  <Link
                    to="/projects/$slug/search"
                    params={{ slug }}
                    search={{ ...search, q: corrected }}
                    className="underline underline-offset-2"
                  >
                    {suggestion}
                  </Link>
                )}
                ?
              </>
            )}
          </Line>
        );
      })}
    </div>
  );
}

/**
 * Every key with one example and what it means. A record over the schema's
 * keys, so a key added there and not here does not compile. Exported for
 * tests, which parse every example.
 */
export const SYNTAX: Record<SearchQualifier, [string, string]> = {
  is: ["is:body,comment,spec", "which unit a hit is"],
  state: ["state:open", "the card's status category"],
  status: ['status:"In Progress"', "the card's status, by name"],
  label: ["label:kind:bug", "a label on the card"],
  assignee: ["assignee:@me", "who the card is assigned to"],
  harness: ["harness:codex", "which agent wrote the matched text"],
  session: ["session:<id>", "which agent session wrote it"],
  metadata: [
    "metadata:orch/phase=spec",
    "the card's metadata, by namespace, key or value",
  ],
};

/** With nothing asked yet, the only place the syntax is written out. */
function SyntaxHelp() {
  return (
    <div className="max-w-prose space-y-4 text-sm text-muted-foreground">
      <p>
        Terms are ANDed and each one matches anywhere inside the text, so{" "}
        <code>WordDiff</code> finds <code>coalescedWordDiff</code>. Quote a
        phrase to keep it together.
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {SEARCH_SCHEMA.keys.map((key) => {
          const [syntax, means] = SYNTAX[key];
          return (
            <div key={key} className="contents">
              <dt className="font-mono text-xs text-foreground">{syntax}</dt>
              <dd>{means}</dd>
            </div>
          );
        })}
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

/** A card's own column layout, turned into the row the box's panel draws. */
const JUMP_CARD = "flex-row items-center gap-2";

/**
 * What the query names outright, if it names anything. A reader who pastes
 * a ref means that card, and search would only find it if some *text*
 * happened to spell the ref — so it is offered as a jump rather than left
 * to an accidental match. This is also where a shared `?q=T-141` link
 * lands, which is why the offer lives on the page and not only in the box.
 *
 * Nothing is drawn while the lookup is in flight: a box that appears
 * without a title, one line above the results, would push them down just
 * as they arrive.
 */
function JumpBanner({ rows }: { rows: JumpRow[] }) {
  const linkState = useReturnLinkState();
  return (
    <div className="space-y-2">
      {rows.map((row) => {
        if (row.kind === "external") {
          return (
            // A new tab: this one leaves todou, unlike an autolink clicked
            // mid-sentence, which the reader is following as they read.
            <LinkCard
              key={row.href}
              href={row.href}
              target="_blank"
              rel="noreferrer"
              className={JUMP_CARD}
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
            </LinkCard>
          );
        }
        if (row.kind === "project") {
          return (
            <LinkCard key={row.slug} asChild className={JUMP_CARD}>
              <Link to="/projects/$slug" params={{ slug: row.slug }}>
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
                        slug: row.slug,
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
            </LinkCard>
          );
        }
        if (row.state !== "ready") return null;
        return (
          <LinkCard key={row.spelled} asChild className={JUMP_CARD}>
            <Link
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
                text={<IssueTitle item={row.item} />}
                textClassName="font-medium"
                author={row.commentBy}
                trailing={<StatusPill status={row.item.status} />}
              />
            </Link>
          </LinkCard>
        );
      })}
    </div>
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
      <span className="shrink-0 font-mono text-xs text-muted-foreground">
        {whereLabel(hit)}
      </span>
      <span className="min-w-0 flex-1 text-sm break-words">
        <SearchHighlight snippet={hit.snippet} />
      </span>
      {/* Search sees across hidden comments while the timeline collapses
          them, so the row says which kind of place the reader is about to
          land in (T-281). */}
      {hit.hidden && (
        <span
          className="shrink-0 text-xs text-muted-foreground"
          data-testid="hit-hidden-badge"
        >
          hidden
        </span>
      )}
    </>
  );
  const className = "flex items-baseline gap-3 px-4 py-2 hover:bg-accent";

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
 * Which kinds of hit to show. They rewrite this page's own search params,
 * which is the case `navigate()` is for — there is no destination until the
 * click.
 *
 * They write `is:` into the query rather than `?in=`, so the box above shows
 * what they did and the same string can be pasted into `todou search`. An
 * older link's `?in=` still presses them on arrival, and the first click
 * folds it into the query and drops it — one fact in one place from then on.
 * None pressed is all three.
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
    <fieldset aria-label="Search in" className="flex flex-wrap gap-2">
      {DOMAIN_LABELS.map((domain) => (
        <Toggle
          key={domain.value}
          pressed={selected.includes(domain.value)}
          onPressedChange={() => toggle(domain.value)}
        >
          {domain.label}
        </Toggle>
      ))}
    </fieldset>
  );
}
