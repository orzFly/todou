import { type CompletionValue, parseQuery, type ValueOption } from "@orz/query";
import { cn } from "@orz/ui";
import { Kbd } from "@orz/ui/components/kbd";
import {
  type OptionProps,
  QueryBox,
  type RowSource,
  type ValueRowContent,
} from "@orz/ui/components/query-box";
import { Skeleton } from "@orz/ui/components/skeleton";
import { useQueryHistory } from "@orz/ui/hooks/use-query-history";
import { useSlashShortcut } from "@orz/ui/hooks/use-slash-shortcut";
import { isPlainClick } from "@orz/ui/lib/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { type Label, SEARCH_SCHEMA, type Status } from "@todou/shared";
import {
  ArrowRightIcon,
  ExternalLinkIcon,
  FolderIcon,
  SearchIcon,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import {
  labelsQuery,
  membersQuery,
  meQuery,
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
import { hasQualifier, searchFacetsQuery } from "@/api/search.ts";
import { LabelChip } from "@/components/issue/label-chip.tsx";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import { JumpRowBody } from "@/components/search/jump-row.tsx";
import { IssueTitle } from "@/components/shared/issue-title.tsx";
import { ProjectIcon } from "@/components/shared/project-icon.tsx";
import { useReturnLinkState } from "@/components/shared/return-context.tsx";
import { displayNameOf, UserAvatar } from "@/components/shared/user-chip.tsx";
import type { PickerUser } from "@/components/shared/user-picker.tsx";
import {
  type ProjectRefRow,
  projectRefCompletions,
} from "@/lib/project-ref-completion.ts";
import { projectSpellings } from "@/lib/project-spellings.ts";
import { commentAnchor } from "@/lib/timeline-anchors.ts";

/** What the app adds to the panel: jumps, a project's cards, project names. */
type BoxRow = JumpRow | ProjectPeekRow | ProjectRefRow;

type Destination =
  | { to: "card"; target: JumpTarget }
  | { to: "project"; slug: string }
  | { to: "external"; href: string }
  | { to: "search"; q: string };

/** What the value providers carry beyond the value, for `renderValue`. */
type LabelOption = ValueOption & { label: Label };
type StatusOption = ValueOption & { status: Status };
type MemberOption = ValueOption & { user: PickerUser };

/**
 * Where todou keeps a viewer's past searches (T-270), bucketed by project
 * because a query written against one project's labels matches nothing in
 * another. The key predates `useQueryHistory`, whose format is the one it
 * was written in, so what a reader searched before the move is still there.
 */
export function historyKey(userId: number | string): string {
  return `todou:search-history:v1:${userId}`;
}

/** Would this row leave the project? The search row then says where it searches. */
function pointsElsewhere(row: JumpRow, slug: string): boolean {
  if (row.kind === "external") return true;
  if (row.kind === "project") return row.slug !== slug;
  return row.state === "ready" ? row.crossProject : row.candidate.slug !== slug;
}

const ICON = "size-3.5 shrink-0 text-muted-foreground";

/**
 * The icon column left empty, so a chip or a pill starts where every row's
 * words do without a tag drawn in front of it (T-753).
 */
const NO_ICON = <span />;

/**
 * A value drawn as the rest of the app draws it. A chip or a pill stands in
 * the value's words; a person keeps their login and takes the icon's place
 * with their avatar, login first because it is the value being completed
 * (T-677).
 */
function renderValue({
  option,
  spec,
}: CompletionValue): ValueRowContent | undefined {
  if (spec.kind !== "named") return undefined;
  if (spec.source === "label" && "label" in option) {
    return {
      leading: NO_ICON,
      body: <LabelChip label={(option as LabelOption).label} />,
    };
  }
  if (spec.source === "status" && "status" in option) {
    return {
      leading: NO_ICON,
      body: <StatusPill status={(option as StatusOption).status} />,
    };
  }
  if (spec.source === "member" && "user" in option) {
    return {
      leading: (
        <UserAvatar
          user={(option as MemberOption).user}
          badge
          className="size-4.5"
        />
      ),
      body: <span className="shrink-0">{option.value}</span>,
    };
  }
  return undefined;
}

/**
 * The project's search box: in the header on every project page (T-141),
 * in the narrow header's overlay, and on the search page itself. The syntax,
 * its completions, the colours and the keyboard are `QueryBox`'s; what is
 * todou's is the rows it adds (a jump to what the query names, a project's
 * name) and where a submitted query goes.
 *
 * The destination is a page, so submitting navigates there rather than
 * searching in place — which is also what makes a result URL shareable.
 */
export function SearchBox({
  slug,
  className,
  focusWidth,
  listAlign = "centered",
  autoFocus = false,
  onEscape,
  query: shown = "",
  invalid = false,
  describedBy,
}: {
  slug: string;
  className?: string;
  /**
   * The width a focused box takes, over whatever is to its left rather than
   * by pushing its neighbours along (T-454). The host gives up width to the
   * row it shares; this is what it borrows back for as long as somebody is
   * typing into it. Omitted, the box never leaves its slot.
   */
  focusWidth?: string;
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
  /**
   * The query a page is showing, which the box takes up whenever it changes
   * (a shared link, the back button) and otherwise leaves to the reader.
   * Omitted, the box starts empty.
   */
  query?: string;
  /** The query has errors, which `describedBy` names. */
  invalid?: boolean;
  describedBy?: string;
}) {
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  // Read at render, never after `decide()`'s await: the box is chrome that
  // outlives the page under it, and the origin a card is opened with is the
  // one that was on screen when the reader asked for it (T-407).
  const returnState = useReturnLinkState();
  const [value, setValue] = useState(shown);
  const lastShown = useRef(shown);
  if (lastShown.current !== shown) {
    lastShown.current = shown;
    setValue(shown);
  }
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [caret, setCaret] = useState(shown.length);
  const slot = useRef<HTMLDivElement>(null);
  // `QueryBox` keeps its input to itself; the slot is where to find it.
  const input = () => slot.current?.querySelector("input") ?? null;

  const project = useQuery(projectQuery(slug));
  const parts = useMemo(() => parseQuery(SEARCH_SCHEMA, value), [value]);
  const qualified = parts.some((part) => part.kind === "filter");

  // Only once the box is in use: it is mounted on every project page, and
  // four lists nobody has asked for is four requests nobody wanted.
  const asked = focused && value !== "";
  const labels = useQuery({ ...labelsQuery(slug), enabled: asked });
  const statuses = useQuery({ ...statusesQuery(slug), enabled: asked });
  const members = useQuery({ ...membersQuery(slug), enabled: asked });
  // Cached by the shell before this box can be typed in: no request of its own.
  const me = useQuery(meQuery);
  const facets = useQuery(searchFacetsQuery(slug, asked));
  // The same two the jump offer reads, so completing a project name costs
  // nothing beyond what resolving one already did.
  const projects = useQuery({ ...projectsQuery, enabled: asked });
  const directory = useQuery({ ...referenceDirectoryQuery, enabled: asked });

  // Undefined until asked for and answered, which the box paints as unknown
  // rather than flashing every value as wrong while a list loads.
  const providers = useMemo(() => {
    const options = (list: readonly ValueOption[] | undefined) => ({
      options: list,
    });
    const viewer: MemberOption[] =
      me.data === undefined
        ? []
        : [{ value: "@me", hint: displayNameOf(me.data), user: me.data }];
    return {
      label: options(
        labels.data?.map((l): LabelOption => ({ value: l.name, label: l })),
      ),
      status: options(
        statuses.data?.map((s): StatusOption => ({ value: s.name, status: s })),
      ),
      // `@me` restated as the viewer, so the schema's own `@me` is drawn with
      // their avatar and name in its place rather than offered twice.
      member: options(
        members.data === undefined
          ? undefined
          : [
              ...viewer,
              ...members.data.map(
                (m): MemberOption => ({
                  value: m.user.login,
                  hint: displayNameOf(m.user),
                  user: m.user,
                }),
              ),
            ],
      ),
      harness: options(
        facets.data?.harnesses.flatMap((h) =>
          h.agent === null ? [] : [{ value: h.agent, hint: String(h.count) }],
        ),
      ),
      session: options(
        facets.data?.sessions.map((s) => ({
          value: s.session_id,
          ...(s.agent === null ? {} : { hint: s.agent }),
        })),
      ),
    };
  }, [labels.data, statuses.data, members.data, facets.data, me.data]);

  // Only resolve while the offer is visible. A retained value after blur or
  // Escape must not leave hidden reference observers polling in the header.
  // A qualified query still belongs to ordinary search.
  const jumpRows = useJumpRows(slug, open && !qualified ? value : "");
  const named = jumpRows.find((row) => row.kind === "project");
  // A project named without a card is a weaker aim than a card: the reader
  // may well be on their way to one whose number they do not remember.
  const peek = useProjectPeek(named?.kind === "project" ? named : null);
  const projectRefs = useMemo(
    () => projectSpellings(projects.data, directory.data),
    [projects.data, directory.data],
  );
  const completing = useMemo(
    () => projectRefCompletions(projectRefs, parts, value, caret),
    [projectRefs, parts, value, caret],
  );
  const elsewhere = jumpRows.some((row) => pointsElsewhere(row, slug));

  const history = useQueryHistory({
    // The login gate reads `me` before any project page renders, so this is
    // the real id rather than a guess that would later change keys under it.
    storageKey: historyKey(me.data?.id ?? "anon"),
    scope: slug,
  });
  const searchHref = (q: string) =>
    router.buildLocation({
      to: "/projects/$slug/search",
      params: { slug },
      search: { q },
    }).href;

  useSlashShortcut(() => {
    const el = input();
    el?.focus();
    el?.select();
  });

  /**
   * Whether the submit about to arrive asked for a plain search rather than
   * a lookup: the reader picked the search row, or Escape had hidden the
   * offer — hiding it has to mean something, so Enter then does the plain
   * thing rather than chasing a jump nobody can see. `QueryBox` reports both
   * as "nothing chosen", as it does an Enter with nothing highlighted, so the
   * box notes which it was on the way in (orzui UI-289 asks for it to say).
   */
  const plain = useRef(false);

  const decide = async (
    query: string,
    chosen: BoxRow | undefined,
    fromHistory: boolean,
  ): Promise<Destination> => {
    // Searched before, and searched again as it was.
    if (fromHistory) return { to: "search", q: query };
    if (chosen?.kind === "external") {
      return { to: "external", href: chosen.href };
    }
    if (
      chosen?.kind === "issue" &&
      chosen.state === "ready" &&
      chosen.commentId === undefined
    ) {
      return { to: "card", target: chosen };
    }
    if (chosen?.kind === "project") return { to: "project", slug: chosen.slug };
    if (chosen?.kind === "project-issue") {
      return {
        to: "card",
        target: { slug: chosen.slug, number: chosen.number },
      };
    }
    if (chosen === undefined && plain.current) {
      return { to: "search", q: query };
    }
    if (hasQualifier(query)) return { to: "search", q: query };
    // A selected comment still needs current confirmation: invalidation can
    // arrive before React removes its ready row. A row that is loading, or a
    // list that has not appeared yet, is also waited for — pasting a ref and
    // hitting Enter must reach the same place as waiting for its row.
    setWaiting(true);
    try {
      const found = await jumpDestinationPromise(queryClient, slug, query);
      if (found?.kind === "issue") return { to: "card", target: found.target };
      if (found?.kind === "project") return { to: "project", slug: found.slug };
      if (found?.kind === "external") {
        return { to: "external", href: found.href };
      }
    } finally {
      setWaiting(false);
    }
    return { to: "search", q: query };
  };

  const submit = async (
    query: string,
    chosen: BoxRow | undefined,
    fromHistory: boolean,
  ) => {
    // The search row of an empty box: the search page itself, where the
    // syntax help is. Nothing was searched, so nothing is remembered.
    if (query === "") {
      plain.current = false;
      navigate({ to: "/projects/$slug/search", params: { slug } });
      return;
    }
    const destination = await decide(query, chosen, fromHistory);
    plain.current = false;
    if (destination.to === "search") {
      history.record(destination.q);
      navigate({
        to: "/projects/$slug/search",
        params: { slug },
        search: { q: destination.q },
      });
      return;
    }
    // A jump is not a search: the box empties rather than keep a ref that
    // now names the page the reader is on.
    setValue("");
    if (destination.to === "card") {
      const { target } = destination;
      navigate({
        to: "/projects/$slug/issues/$number",
        params: { slug: target.slug, number: String(target.number) },
        state: returnState,
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
    } else {
      // A tab opened after an await can meet a popup blocker — the click
      // that authorised it is no longer the task at hand. The row is a real
      // link so there is always a way that cannot be blocked.
      window.open(destination.href, "_blank", "noreferrer");
    }
  };

  /**
   * A row that goes somewhere is a real link. A plain click goes the way
   * Enter does, through `onSubmit`; a modified, middle or right click, and
   * any click on a link that opens elsewhere, is the browser's, and the panel
   * stays as it was for the reader stacking tabs.
   */
  const follow =
    (option: OptionProps, before?: () => void) => (e: React.MouseEvent) => {
      if (!isPlainClick(e)) return;
      e.preventDefault();
      before?.();
      option.onClick();
    };

  const jumpSource: RowSource<BoxRow> = {
    id: "jump",
    matched: true,
    // One source, so one budget covers the peek too: the home row is what
    // the reader named and the cards below it come out of the same
    // allowance as everything else (T-268).
    rows: [...jumpRows, ...peek],
    key: (row) =>
      row.kind === "project-issue" ? `peek-${row.number}` : row.kind,
    render: (row, option) => {
      if (row.kind === "project-ref") return null;
      if (row.kind === "project") {
        return (
          <Link
            to="/projects/$slug"
            params={{ slug: row.slug }}
            {...option}
            onClick={follow(option)}
          >
            <JumpRowBody
              icon={<ArrowRightIcon className={ICON} aria-hidden />}
              spelled={row.spelled}
              // What the reader typed, not a card: nothing to take apart, so
              // the whole token is the one elidable run.
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
            />
          </Link>
        );
      }
      if (row.kind === "project-issue") {
        return (
          <Link
            to="/projects/$slug/issues/$number"
            params={{ slug: row.slug, number: String(row.number) }}
            state={returnState}
            {...option}
            onClick={follow(option)}
          >
            <JumpRowBody
              icon={
                /* Where the arrow goes on every other row. These cards are
                   offered rather than asked for, and the empty column is
                   what says so — one indent, no new glyph. */
                <span className="w-3.5 shrink-0" aria-hidden />
              }
              spelled={row.spelled}
              // The reader's own spelling carried on, not a format:
              // `accel/1` and `ACC-1` are both this row's token.
              identity={null}
              refClassName="text-muted-foreground"
              text={<IssueTitle item={row.item} />}
              trailing={<StatusPill status={row.item.status} />}
            />
          </Link>
        );
      }
      if (row.kind === "external") {
        return (
          // A new tab: this one leaves todou, unlike an autolink clicked
          // mid-sentence, which the reader is reading through.
          <a
            href={row.href}
            target="_blank"
            rel="noreferrer"
            {...option}
            onClick={follow(option)}
          >
            <JumpRowBody
              icon={<ExternalLinkIcon className={ICON} aria-hidden />}
              spelled={row.text}
              // An autolink's own text, which todou never spelled.
              identity={null}
              text={row.host}
              textClassName="text-muted-foreground"
            />
          </a>
        );
      }
      if (row.state === "pending") {
        return (
          // Not a link: there is nothing to point at yet. Enter still reaches
          // the card, by waiting for the lookup it is on.
          <div
            {...option}
            // Both already in `option`; the linter cannot see them inside a
            // spread and reads this as an inert div.
            role="option"
            tabIndex={-1}
            aria-label="Looking up the card…"
          >
            <ArrowRightIcon className={ICON} aria-hidden />
            <Skeleton className="h-4 w-40" />
          </div>
        );
      }
      return (
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
          state={returnState}
          {...option}
          onClick={follow(option)}
        >
          <JumpRowBody
            icon={<ArrowRightIcon className={ICON} aria-hidden />}
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
            author={row.commentBy}
            trailing={<StatusPill status={row.item.status} />}
          />
        </Link>
      );
    },
  };

  const projectRefSource: RowSource<BoxRow> = {
    id: "project-ref",
    matched: completing.matched,
    // Finishing a project's name is finishing the word, not a destination:
    // Enter, a click and Tab all rewrite the query and keep the reader in
    // the box, the caret ready for a number (T-268).
    completes: true,
    rows: completing.rows,
    key: (row) => (row.kind === "project-ref" ? row.slug : row.kind),
    apply: (row) => (row.kind === "project-ref" ? row.apply : null),
    render: (row, option) =>
      row.kind !== "project-ref" ? null : (
        <button type="button" {...option}>
          <FolderIcon className={ICON} aria-hidden />
          <span className="truncate font-mono text-ui-sm">{row.spelling}</span>
          <span className="truncate text-muted-foreground text-ui-sm">
            {row.name}
          </span>
        </button>
      ),
  };

  const renderSubmitRow = (query: string, option: OptionProps) => {
    // With nothing typed there is no search to offer, so the row stops
    // pretending to be one: `Search for “”` searched for nothing, while the
    // page it leads to is a real destination — the syntax help lives there.
    const blank = query === "";
    return (
      <Link
        to="/projects/$slug/search"
        params={{ slug }}
        search={blank ? {} : { q: query }}
        {...option}
        data-submit-row=""
        onClick={follow(option, () => {
          plain.current = true;
        })}
      >
        {blank ? (
          <ArrowRightIcon className={ICON} aria-hidden />
        ) : (
          <SearchIcon className={ICON} aria-hidden />
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
  };

  const readCaret = (e: React.SyntheticEvent<HTMLInputElement>) =>
    setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length);

  return (
    <div
      ref={slot}
      className={cn(
        "relative",
        // In the header the slot is the row's height and the box floats in
        // it, so the box stands as tall as it likes on any pointer.
        focusWidth !== undefined && "self-stretch",
        className,
      )}
    >
      <QueryBox<BoxRow>
        schema={SEARCH_SCHEMA}
        providers={providers}
        value={value}
        onValueChange={(next) => {
          setValue(next);
          // Typed: the input already holds `next`, caret and all. Taken from
          // a row: the box puts the caret where the row says once `next` is
          // in, and the select event that follows reports it; until then the
          // end is where every completion leaves it.
          const el = input();
          setCaret(
            el !== null && el.value === next
              ? (el.selectionStart ?? next.length)
              : next.length,
          );
        }}
        onSubmit={(query, chosen, fromHistory) => {
          void submit(query, chosen, fromHistory);
        }}
        onOpenChange={setOpen}
        sources={[jumpSource, projectRefSource]}
        history={history}
        queryHref={searchHref}
        renderSubmitRow={renderSubmitRow}
        renderValue={renderValue}
        busy={waiting}
        listAlign={listAlign}
        leading={<SearchIcon />}
        onEscape={onEscape}
        className={
          focusWidth === undefined
            ? "w-full"
            : // Anchored to the slot's right edge so that growing is growing
              // leftwards — over the project nav, which is the neighbour
              // that gave up the width in the first place. Absolute rather
              // than a width on the slot, so nothing beside it moves; it is
              // also what the offer panel hangs off, which keeps the panel
              // under the box it grew out of.
              cn(
                "absolute top-1/2 right-0 -translate-y-1/2 transition-[width] duration-150",
                focused
                  ? // Opaque and above: it is standing on the nav's text.
                    cn("z-30 rounded-control bg-background", focusWidth)
                  : "w-full",
              )
        }
        inputProps={{
          name: "q",
          "aria-label": "Search this project",
          placeholder: "Search…",
          autoFocus,
          "aria-keyshortcuts": "/",
          "aria-invalid": invalid || undefined,
          "aria-describedby": describedBy,
          onFocus: () => setFocused(true),
          onBlur: () => setFocused(false),
          onSelect: readCaret,
          onKeyUp: readCaret,
          onClick: readCaret,
          onKeyDown: (e) => {
            if (
              e.key !== "Enter" ||
              e.nativeEvent.isComposing ||
              e.keyCode === 229
            ) {
              return;
            }
            plain.current =
              !open ||
              slot.current?.querySelector(
                '[data-submit-row][aria-selected="true"]',
              ) != null;
          },
        }}
      />
      {/* Where `/` would take the reader, on a box nobody is in. A touch
          screen has no `/` to press. */}
      {!focused && value === "" && (
        <Kbd
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 touch:hidden"
        >
          /
        </Kbd>
      )}
    </div>
  );
}
