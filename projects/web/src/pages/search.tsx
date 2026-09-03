import { useQuery } from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { formatRef, type SearchDomain, type SearchItem } from "@todou/shared";
import { ArrowRightIcon, ExternalLinkIcon, SearchIcon } from "lucide-react";
import { useJumpRows } from "@/api/ref-jump.ts";
import { useRefPrefix } from "@/api/references.ts";
import { domainsOf, type SearchPageSearch, searchQuery } from "@/api/search.ts";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import { SearchHighlight } from "@/components/search-highlight.tsx";
import { Skeleton } from "@/components/ui/skeleton";
import { commentAnchor } from "@/lib/timeline-anchors.ts";
import { cn } from "@/lib/utils";

const DOMAIN_LABELS: Array<{ value: SearchDomain; label: string }> = [
  { value: "issues", label: "Issues" },
  { value: "comments", label: "Comments" },
  { value: "specs", label: "Specs" },
];

/** What a hit is called in its row, and where reading it continues. */
function whereLabel(item: SearchItem): string {
  if (item.kind === "comment") return "comment";
  if (item.kind === "spec") return item.spec_path ?? "spec";
  return item.field === "title" ? "title" : "body";
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

export function SearchPage() {
  const { slug } = useParams({ from: "/authed/projects/$slug" });
  const search = useSearch({ from: "/authed/projects/$slug/search" });
  return <SearchResults slug={slug} search={search} />;
}

/** The page proper, addressable without the router context. Exported for tests. */
export function SearchResults({
  slug,
  search,
}: {
  slug: string;
  search: SearchPageSearch;
}) {
  const q = (search.q ?? "").trim();
  const results = useQuery(searchQuery(slug, search));
  const prefix = useRefPrefix(slug);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-heading text-lg font-medium">
          {q === "" ? "Search" : `Results for “${q}”`}
        </h2>
        {results.data && (
          <p className="text-sm text-muted-foreground">
            {results.data.items.length}
            {results.data.has_more ? "+" : ""} hit
            {results.data.items.length === 1 && !results.data.has_more
              ? ""
              : "s"}
          </p>
        )}
      </div>

      <DomainFilter slug={slug} search={search} />

      <JumpBanner slug={slug} q={q} />

      {q === "" ? (
        <Empty>
          Type in the box above. Terms are ANDed and each one matches anywhere
          inside the text, so <code>搜索</code> finds it in the middle of a
          sentence and <code>WordDiff</code> finds{" "}
          <code>coalescedWordDiff</code>. Quote a phrase to keep it together.
        </Empty>
      ) : results.isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : results.isError ? (
        <Empty>Search failed: {results.error.message}</Empty>
      ) : results.data.items.length === 0 ? (
        <Empty>
          Nothing matched. Trashed cards, and every spec version but the newest,
          are deliberately not searchable.
        </Empty>
      ) : (
        <ul className="space-y-4">
          {groupByIssue(results.data.items).map((group) => (
            <li
              key={group.issue.number}
              className="overflow-hidden rounded-lg border"
            >
              <Link
                to="/projects/$slug/issues/$number"
                params={{ slug, number: String(group.issue.number) }}
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
                {group.hits.map((hit) => (
                  <li key={hitKey(hit)}>
                    <HitRow slug={slug} hit={hit} />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function hitKey(hit: SearchItem): string {
  return `${hit.kind}:${hit.comment_id ?? hit.spec_path ?? hit.field}`;
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
 * as they arrive.
 */
function JumpBanner({ slug, q }: { slug: string; q: string }) {
  const rows = useJumpRows(slug, q);
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
              <ExternalLinkIcon
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <span className="shrink-0 font-mono text-xs">{row.text}</span>
              <span className="truncate text-muted-foreground">{row.host}</span>
            </a>
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
            className={JUMP_BOX}
          >
            <ArrowRightIcon
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {row.spelled}
            </span>
            <span className="truncate font-medium">{row.item.title}</span>
            {row.commentBy !== null && (
              <span className="shrink-0 text-muted-foreground">
                · comment by {row.commentBy}
              </span>
            )}
            <StatusPill status={row.item.status} className="ml-auto shrink-0" />
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
  const body = (
    <>
      <span className="shrink-0 pt-px font-mono text-xs text-muted-foreground">
        {whereLabel(hit)}
      </span>
      <span className="min-w-0 text-sm break-words">
        <SearchHighlight snippet={hit.snippet} />
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
      className={className}
    >
      {body}
    </Link>
  );
}

/**
 * Domain chips. They rewrite this page's own search params, which is the
 * case `navigate()` is for — there is no destination until the click.
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
      search: { ...search, in: next.length === 0 ? undefined : next.join(",") },
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
