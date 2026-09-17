import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { can, type Project } from "@todou/shared";
import {
  CircleDotIcon,
  CopyIcon,
  EllipsisIcon,
  LinkIcon,
  TextQuoteIcon,
} from "lucide-react";
import {
  type ComponentProps,
  type ReactNode,
  type RefObject,
  useMemo,
  useRef,
  useState,
} from "react";
import type Markdown from "react-markdown";
import { projectQuery, projectsQuery } from "@/api/queries.ts";
import { useProjectOrder } from "@/api/useProjectOrder.ts";
import {
  ProjectListbox,
  type ProjectListboxOption,
} from "@/components/project-listbox.tsx";
import { useQuoteReply } from "@/components/timeline/quote-reply.tsx";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { copyToClipboard } from "@/lib/clipboard.ts";
import { sourceLines } from "@/lib/quote-markdown.ts";
import { selectedSourceRange } from "@/lib/quote-selection.ts";
import { rehypeSourceLines } from "@/lib/rehype-source-lines.ts";
import { commentAnchor } from "@/lib/timeline-anchors.ts";

/**
 * What stamps a rendered body with the source lines Quote reply maps a
 * selection back to. Module-level because `MarkdownView` hands this straight
 * to react-markdown, where a fresh array rebuilds the very text nodes a live
 * selection lives in (T-60).
 */
export const QUOTE_REHYPE_PLUGINS: ComponentProps<
  typeof Markdown
>["rehypePlugins"] = [rehypeSourceLines];

/** Where the quote comes from, whichever project the new card is filed in. */
type QuoteSource = {
  quote_project: string;
  quote_issue: number;
  /** Absent for the issue body, whose permalink is the card itself. */
  quote_comment?: number;
};

/**
 * The `…` on a comment and on an issue body: four things any reader may do
 * with the entry, then whatever the caller's capabilities add below a rule.
 *
 * None of the four is gated, and neither is this project's own row in the
 * Reference submenu. `comment.create` and `issue.create` have no gate anywhere
 * else either — the box at the foot of the page and the navbar's New issue
 * button render for everyone and the server refuses what it must — and
 * `useCan` suspends, which on a timeline would put a boundary on every row.
 * The submenu's other projects are the exception, and they cost no boundary:
 * their role arrives inside the list they are drawn from.
 */
export function EntryActionsMenu({
  slug,
  issueNumber,
  commentId,
  body,
  bodyRef,
  label,
  triggerRef,
  children,
}: {
  slug: string;
  issueNumber: number;
  /** Absent for the issue body, whose permalink is the card itself. */
  commentId?: number;
  /** The stored markdown, which is what gets copied and quoted. */
  body: string;
  /** The rendered body, for reading which blocks the reader selected. */
  bodyRef: RefObject<HTMLElement | null>;
  label: string;
  /** For callers whose own dialogs have to hand focus back here on close. */
  triggerRef?: RefObject<HTMLButtonElement | null>;
  /** Capability-gated entries; omit them and the rule goes too. */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // Controlled, because two of the three gestures below have to open or
  // withhold the submenu by hand.
  const [targets, setTargets] = useState(false);
  /** Which device is making the click under way; the click cannot say. */
  const pointer = useRef<string | null>(null);
  /** Drops the one submenu-open Radix runs behind a modified click. */
  const suppressOpen = useRef(false);
  const { available, quote } = useQuoteReply();
  // Memoized because it is a dependency of the submenu's own memo, and a
  // fresh literal per render would rebuild every row on every keystroke.
  const quoteSource = useMemo<QuoteSource>(
    () => ({
      quote_project: slug,
      quote_issue: issueNumber,
      quote_comment: commentId,
    }),
    [slug, issueNumber, commentId],
  );
  // Read on pointerdown and kept here: the press's own default action
  // collapses the selection, and `markdown-view.tsx` warns that re-rendering
  // the document clears it silently (T-60). Reading before either happens
  // means never having to argue about which of them opening a menu performs.
  const selected = useRef<{ start: number; end: number } | null>(null);

  const readSelection = (): { start: number; end: number } | null => {
    const container = bodyRef.current;
    return container === null ? null : selectedSourceRange(container);
  };

  const permalink = `${window.location.origin}/projects/${slug}/issues/${issueNumber}${
    commentId === undefined ? "" : `#${commentAnchor(commentId)}`
  }`;

  // Nothing to copy and nothing to quote: writing "" to the clipboard would
  // replace whatever the reader had there and still report success, and
  // `blockquote("")` is a lone `>` that lights up the composer's send button.
  // The same test the body block uses to say `No description.`.
  const hasBody = body.trim() !== "";

  const quoteSelected = () => {
    // Opening with the keyboard fires no pointerdown, so nothing was captured
    // and the live selection is still the one to read.
    const range = selected.current ?? readSelection();
    const picked =
      range === null ? "" : sourceLines(body, range.start, range.end);
    quote(picked === "" ? body : picked);
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) selected.current = null;
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          size="icon-sm"
          variant="ghost"
          aria-label={label}
          onPointerDown={() => {
            selected.current = readSelection();
          }}
        >
          <EllipsisIcon className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      {/* The entries need more room than the trigger's 28px. */}
      <DropdownMenuContent className="w-auto" align="end">
        <DropdownMenuItem
          onSelect={() => void copyToClipboard(permalink, "Link copied")}
        >
          <LinkIcon className="size-3.5" />
          Copy link
        </DropdownMenuItem>
        {hasBody && (
          <DropdownMenuItem
            onSelect={() => void copyToClipboard(body, "Markdown copied")}
          >
            <CopyIcon className="size-3.5" />
            Copy Markdown
          </DropdownMenuItem>
        )}
        {available && hasBody && (
          <DropdownMenuItem onSelect={quoteSelected}>
            <TextQuoteIcon className="size-3.5" />
            Quote reply
          </DropdownMenuItem>
        )}
        <DropdownMenuSub
          open={targets}
          onOpenChange={(next) => {
            if (next && suppressOpen.current) {
              suppressOpen.current = false;
              return;
            }
            setTargets(next);
          }}
        >
          {/* This row files the card here; the submenu is for filing it
              somewhere else. Hovering, `→` and a tap all still open it. */}
          <DropdownMenuSubTrigger
            asChild
            onPointerDown={(e) => {
              pointer.current = e.pointerType;
            }}
            onClickCapture={(e) => {
              // A mouse has already opened the submenu by hovering, so its
              // click carries nothing and can be spent on filing the card.
              // Touch has no hover — Radix opens a submenu on pointermove and
              // only for a mouse — so the tap is the only gesture that can
              // reach the other projects, and it stays theirs.
              if (pointer.current !== null && pointer.current !== "mouse") {
                e.preventDefault();
                pointer.current = null;
                setTargets(true);
              }
            }}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              // `→` is APG's key for opening a submenu and stays Radix's.
              if (e.key !== "Enter" && e.key !== " ") return;
              pointer.current = null;
              e.currentTarget.click();
              // Radix reads Enter and Space as "open the submenu" too, and
              // composeEventHandlers skips its half once this is set.
              e.preventDefault();
            }}
          >
            <Link
              to="/projects/$slug/issues/new"
              params={{ slug }}
              search={quoteSource}
              onClick={(e) => {
                // The capture handler above already spent this one on opening
                // the submenu.
                if (e.defaultPrevented) return;
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
                  // The browser is opening a tab in the background, so leave
                  // the menu standing — and keep Radix from taking this click
                  // as "open the submenu", which would pull focus into its
                  // search box out from under the reader.
                  suppressOpen.current = true;
                  // Radix only opens what is not open already, so after a
                  // hover has opened the list this click consumes nothing.
                  // Cleared once the click is fully dispatched — anything
                  // later is a new gesture, and a flag left standing would
                  // eat that reader's next legitimate open.
                  queueMicrotask(() => {
                    suppressOpen.current = false;
                  });
                  return;
                }
                setOpen(false);
              }}
            >
              <CircleDotIcon className="size-3.5" />
              Reference in a new issue
            </Link>
          </DropdownMenuSubTrigger>
          {/* Portalled out of the parent content, which scrolls and clips its
              own overflow. */}
          <DropdownMenuPortal>
            <DropdownMenuSubContent className="w-64 p-0">
              <QuoteTargets
                slug={slug}
                quoteSource={quoteSource}
                onPicked={() => setOpen(false)}
              />
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
        {children != null && (
          <>
            <DropdownMenuSeparator />
            {children}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Where to file the new card: this project first, then everywhere else the
 * reader may open one.
 *
 * Its own component because Radix mounts a submenu's content only while it is
 * open, and a timeline holds one of these menus per comment: the project list,
 * the frecency order's `storage` subscription and `meQuery` underneath it then
 * exist once the reader asks for them rather than two hundred times on load.
 * The parent item's href needs none of it — only the slug it already has.
 */
function QuoteTargets({
  slug,
  quoteSource,
  onPicked,
}: {
  slug: string;
  quoteSource: QuoteSource;
  /** Close the whole menu behind an unmodified pick. */
  onPicked: () => void;
}) {
  const navigate = useNavigate();
  // The project this entry lives in, read from its own query rather than
  // looked up in the list: the pinned row then does not wait on the list, and
  // survives a server that does not return this project in it.
  const current = useQuery(projectQuery(slug));
  const projects = useQuery(projectsQuery);
  const ordered = useProjectOrder(projects.data ?? []);

  const options = useMemo<ProjectListboxOption[]>(() => {
    const row = (project: Project, pinned: boolean): ProjectListboxOption => ({
      project,
      link: {
        to: "/projects/$slug/issues/new",
        params: { slug: project.slug },
        search: quoteSource,
      },
      note: pinned ? (
        <span className="shrink-0 text-muted-foreground text-xs">
          (current)
        </span>
      ) : undefined,
    });
    // The new-issue page gates nothing, so a reader who cannot file here would
    // meet the 403 only after writing the card. The destination's own role,
    // like the Move dialog's. Not the current project, which follows the
    // navbar's New issue button in rendering for every reader.
    const rest = ordered
      .map((item) => item.project)
      .filter(
        (project) =>
          project.slug !== slug &&
          can(project.viewer_role ?? null, "issue.create"),
      );
    return [
      ...(current.data === undefined ? [] : [row(current.data, true)]),
      ...rest.map((project) => row(project, false)),
    ];
  }, [current.data, ordered, quoteSource, slug]);

  return (
    <ProjectListbox
      options={options}
      label="Reference in a new issue"
      idPrefix="quote-target"
      searchPlaceholder="Search projects…"
      emptyText="No matching project."
      listClassName="max-h-64"
      autoFocus
      onSelect={(option) => {
        onPicked();
        navigate({
          to: "/projects/$slug/issues/new",
          params: { slug: option.project.slug },
          search: quoteSource,
        });
      }}
      onLinkClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        onPicked();
      }}
    />
  );
}
