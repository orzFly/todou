import { Link } from "@tanstack/react-router";
import { formatRef } from "@todou/shared";
import { ArrowLeftIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useRefPlacement } from "@/api/prefs.ts";
import { useRefPrefix } from "@/api/references.ts";
import {
  restoreLinkState,
  useReturnLinkState,
  useReturnOrigin,
} from "@/components/shared/return-context.tsx";
import { Button } from "@/components/ui/button";
import {
  type ReturnView,
  returnAccessibleName,
  returnLabelOf,
} from "@/lib/return-view.ts";
import { cn } from "@/lib/utils";

/**
 * The one back control, worn identically by the issue page and the spec page
 * (T-407). The customer's complaint was that the two pages disagreed about
 * whether going back was even possible; one component is what stops them
 * disagreeing again.
 */

function BackButton({
  slot,
  floating,
  children,
}: {
  /** The spec toolbar addresses its controls by slot; the issue row does not. */
  slot?: string;
  floating?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      asChild
      size="sm"
      variant="ghost"
      className={cn(
        "pointer-events-auto shrink-0",
        floating &&
          "min-[1440px]:absolute min-[1440px]:right-full min-[1440px]:mr-6",
      )}
      data-toolbar-slot={slot}
    >
      {children}
    </Button>
  );
}

/**
 * Back to wherever this card was opened from, or — for a card opened from a
 * permalink, a bookmark or another tab — to this project's list.
 *
 * The destination is resolved during render, so it is a real `href` a reader
 * can preview, middle-click and bookmark before deciding to follow it. The
 * snapshot rides the navigation as history state instead, which is why
 * opening this link in a new tab lands on the same filters with none of the
 * reading position: a second tab has a history of its own.
 */
export function IssueReturnLink({
  slug,
  slot,
  floating,
}: {
  /** The project to fall back to, which is the card's own. */
  slug: string;
  slot?: string;
  floating?: boolean;
}) {
  const origin = useReturnOrigin();
  if (origin === undefined) {
    return (
      <BackButton slot={slot} floating={floating}>
        <Link
          to="/projects/$slug"
          params={{ slug }}
          aria-label="Back to Issues"
        >
          <ArrowLeftIcon className="size-4" />
          Issues
        </Link>
      </BackButton>
    );
  }
  return <CollectionLink view={origin} slot={slot} floating={floating} />;
}

function CollectionLink({
  view,
  slot,
  floating,
}: {
  view: ReturnView;
  slot?: string;
  floating?: boolean;
}) {
  const label = returnLabelOf(view.target);
  const name = returnAccessibleName(view);
  // The snapshot travels as state on this navigation, which is what the
  // collection page reads to rebuild its pages and its reading position.
  const state = restoreLinkState(view);
  const body = (
    <>
      <ArrowLeftIcon className="size-4" />
      {label}
    </>
  );
  // Slot props must reach the actual anchor, not stop at this component.
  const link = (() => {
    switch (view.target.kind) {
      case "list":
        return (
          <Link
            to="/projects/$slug"
            params={{ slug: view.target.slug }}
            search={view.target.search}
            state={state}
            aria-label={name}
          >
            {body}
          </Link>
        );
      case "board":
        return (
          <Link
            to="/projects/$slug/board"
            params={{ slug: view.target.slug }}
            state={state}
            aria-label={name}
          >
            {body}
          </Link>
        );
      case "search":
        return (
          <Link
            to="/projects/$slug/search"
            params={{ slug: view.target.slug }}
            search={view.target.search}
            state={state}
            aria-label={name}
          >
            {body}
          </Link>
        );
      case "inbox":
        return (
          <Link
            to="/inbox"
            search={{ tab: view.tab === "all" ? undefined : view.tab }}
            state={state}
            aria-label={name}
          >
            {body}
          </Link>
        );
      case "user":
        return (
          <Link
            to="/users/$ref"
            params={{ ref: view.target.ref }}
            search={view.target.search}
            state={state}
            aria-label={name}
          >
            {body}
          </Link>
        );
    }
  })();
  return (
    <BackButton slot={slot} floating={floating}>
      {link}
    </BackButton>
  );
}

/**
 * The spec page's back control, which always goes to the spec's own issue —
 * one step, even for a reader who arrived at the spec straight from a search
 * hit or a review badge. The card is where a spec is understood, and the
 * issue page carries the origin the rest of the way.
 */
export function SpecReturnLink({
  slug,
  number,
  slot,
  floating,
}: {
  slug: string;
  number: number;
  slot?: string;
  floating?: boolean;
}) {
  const state = useReturnLinkState();
  return (
    <BackButton slot={slot} floating={floating}>
      <Link
        to="/projects/$slug/issues/$number"
        params={{ slug, number: String(number) }}
        state={state}
        aria-label="Back to Issue"
      >
        <ArrowLeftIcon className="size-4" />
        Issue
      </Link>
    </BackButton>
  );
}

/**
 * The card's number and title, small enough to sit on a toolbar row. Shared
 * so the issue page's sticky row and the spec page's toolbar read as one
 * design rather than two that happen to say the same words.
 *
 * The ref keeps its own box outside the truncating span, so no title length
 * can eat it, and it honours the reader's ref-placement preference — the same
 * two rules the full-size heading follows.
 */
export function CompactIssueIdentity({
  slug,
  number,
  title,
  slot,
  className,
}: {
  slug: string;
  number: number;
  title?: string;
  slot?: string;
  className?: string;
}) {
  const prefix = useRefPrefix(slug);
  const refLeads = useRefPlacement("detail") === "before";
  const reference = (
    <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
      {formatRef(prefix, number)}
    </span>
  );
  return (
    <span
      data-toolbar-slot={slot}
      className={cn("inline-flex min-w-0 items-center gap-2", className)}
    >
      {refLeads && reference}
      <span
        className="min-w-0 truncate text-[0.9375rem] font-semibold"
        title={title}
      >
        {title}
      </span>
      {!refLeads && reference}
    </span>
  );
}
