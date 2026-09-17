import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
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
  useRef,
  useState,
} from "react";
import type Markdown from "react-markdown";
import { projectsQuery } from "@/api/queries.ts";
import { ProjectListbox } from "@/components/project-listbox.tsx";
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

/**
 * The `…` on a comment and on an issue body: four things any reader may do
 * with the entry, then whatever the caller's capabilities add below a rule.
 *
 * None of the four is gated. `comment.create` and `issue.create` have no gate
 * anywhere else either — the box at the foot of the page and the navbar's New
 * issue button render for everyone and the server refuses what it must — and
 * `useCan` suspends, which on a timeline would put a boundary on every row.
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
  const navigate = useNavigate();
  const projects = useQuery(projectsQuery);
  const { available, quote } = useQuoteReply();
  /** Where the quote comes from, whichever project the new card is filed in. */
  const quoteSource = {
    quote_project: slug,
    quote_issue: issueNumber,
    quote_comment: commentId,
  };
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
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <CircleDotIcon className="size-3.5" />
            Reference in a new issue
          </DropdownMenuSubTrigger>
          {/* Portalled out of the parent content, which scrolls and clips its
              own overflow. */}
          <DropdownMenuPortal>
            <DropdownMenuSubContent className="w-64 p-0">
              <ProjectListbox
                options={(projects.data ?? []).map((project) => ({
                  project,
                  link: {
                    to: "/projects/$slug/issues/new",
                    params: { slug: project.slug },
                    search: quoteSource,
                  },
                  trailing: (
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {project.slug}
                    </span>
                  ),
                }))}
                label="Reference in a new issue"
                idPrefix="quote-target"
                searchPlaceholder="Search projects…"
                emptyText="No matching project."
                listClassName="max-h-64"
                autoFocus
                onSelect={(option) => {
                  setOpen(false);
                  navigate({
                    to: "/projects/$slug/issues/new",
                    params: { slug: option.project.slug },
                    search: quoteSource,
                  });
                }}
                onLinkClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  setOpen(false);
                }}
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
