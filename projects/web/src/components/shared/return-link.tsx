import { Link } from "@tanstack/react-router";
import { formatRef } from "@todou/shared";
import { ArrowLeftIcon } from "lucide-react";
import { Slot } from "radix-ui";
import type { MouseEvent, ReactNode } from "react";
import { useRefPlacement } from "@/api/prefs.ts";
import { useRefPrefix } from "@/api/references.ts";
import {
  restoreLinkState,
  useReturnLinkState,
  useReturnOrigin,
} from "@/components/shared/return-context.tsx";
import { Button } from "@/components/ui/button";
import { type ReturnView, returnAccessibleName } from "@/lib/return-view.ts";
import { cn } from "@/lib/utils";

/**
 * The one back control, worn identically by the issue page and the spec page
 * (T-407). The customer's complaint was that the two pages disagreed about
 * whether going back was even possible; one component is what stops them
 * disagreeing again.
 *
 * It says where it goes with an arrow and nothing else (T-461). The word it
 * used to carry — `Issues`, `Board`, the name of a user — is still the
 * accessible name, because a bare arrow announces nothing; what the word was
 * doing on screen was repeating the title it sits beside.
 */

/**
 * Which title this control is standing next to, which is the whole of what
 * decides its size (T-461): the icon matches that title's font size and the
 * box its line height. There is no size of its own to pick — an arrow keeping
 * its toolbar size beside a `text-2xl` heading reads as a different control
 * that happens to point the same way, which is the complaint this answers.
 */
export type BackScale = "nav" | "heading" | "compact";

/** Which back control a route wears; the destination is resolved at render. */
export type BackControlKind = "issue" | "spec" | "project" | "projects";

const ARROW: Record<BackScale, string> = {
  nav: "size-4",
  heading: "size-6",
  compact: "size-4",
};

const BOX = { heading: "icon", compact: "icon-xs" } as const;

/**
 * The floating title bar reads a click on itself as "take me back to the top",
 * and going back to the collection is not a request to stay on this page. Same
 * remedy and same reason as the reveal eye that shares that bar — see
 * `reveal-all-eye.tsx`.
 */
const stopBubbling = (event: MouseEvent) => event.stopPropagation();

function BackButton({
  scale,
  slot,
  floating,
  mirrored,
  children,
}: {
  scale: BackScale;
  /** The spec toolbar addresses its controls by slot; the issue row does not. */
  slot?: string;
  /** Hang in the gutter outside the column rather than take room inside it. */
  floating?: boolean;
  /** This copy rides inside the floating title bar's click target. */
  mirrored?: boolean;
  children: ReactNode;
}) {
  const onClick = mirrored ? stopBubbling : undefined;
  // The tab strip dresses its own members, so this one wears their clothes
  // rather than a button's: among four text tabs, a ghost button reads as
  // something bolted onto the nav instead of one more thing in it.
  if (scale === "nav") {
    return (
      <Slot.Root
        data-toolbar-slot={slot}
        className="shrink-0 rounded-md px-1 py-1 text-muted-foreground hover:text-foreground"
        onClick={onClick}
      >
        {children}
      </Slot.Root>
    );
  }
  return (
    <Button
      asChild
      size={BOX[scale]}
      variant="ghost"
      className={cn(
        "pointer-events-auto shrink-0",
        floating && "absolute right-full mr-2",
      )}
      data-toolbar-slot={slot}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

type BackProps = {
  scale: BackScale;
  slot?: string;
  floating?: boolean;
  mirrored?: boolean;
};

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
  ...back
}: BackProps & {
  /** The project to fall back to, which is the card's own. */
  slug: string;
}) {
  const origin = useReturnOrigin();
  if (origin === undefined) {
    return (
      <BackButton {...back}>
        <Link
          to="/projects/$slug"
          params={{ slug }}
          aria-label="Back to Issues"
        >
          <ArrowLeftIcon className={ARROW[back.scale]} />
        </Link>
      </BackButton>
    );
  }
  return <CollectionLink view={origin} {...back} />;
}

function CollectionLink({ view, ...back }: BackProps & { view: ReturnView }) {
  const name = returnAccessibleName(view);
  // The snapshot travels as state on this navigation, which is what the
  // collection page reads to rebuild its pages and its reading position.
  const state = restoreLinkState(view);
  const body = <ArrowLeftIcon className={ARROW[back.scale]} />;
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
  return <BackButton {...back}>{link}</BackButton>;
}

/**
 * The spec page's back control, which always goes to the spec's own issue —
 * one step, even for a reader who arrived at the spec straight from a search
 * hit or a review badge. The card is where a spec is understood, and the
 * issue page carries the origin the rest of the way.
 *
 * This is the unmerged half of the pair: `SpecIssueReturnLink` is what the
 * toolbar wears where the card's ref sits right beside the arrow.
 */
export function SpecReturnLink({
  slug,
  number,
  ...back
}: BackProps & { slug: string; number: number }) {
  const state = useReturnLinkState();
  return (
    <BackButton {...back}>
      <Link
        to="/projects/$slug/issues/$number"
        params={{ slug, number: String(number) }}
        state={state}
        aria-label="Back to Issue"
      >
        <ArrowLeftIcon className={ARROW[back.scale]} />
      </Link>
    </BackButton>
  );
}

/**
 * The spec toolbar's back control and the card's ref as one button (T-461):
 * the arrow hangs in the gutter, the ref stays at the pixel it would sit at
 * without the button, and the title beside it stays outside the hit area.
 *
 * Only where the ref leads. With the ref placed after the title the two
 * halves are not adjacent, and one button spanning them would swallow the
 * whole title — see the caller, which is where that choice is made.
 *
 * No resting background, because the ref not moving is the requirement. The
 * hover one is back (T-470): its padding is cancelled by an equal negative
 * margin, so the tint has room to sit in while the ref keeps the pixel it
 * would occupy without a button around it. Out in the gutter the arrow tints
 * as its own box — the two halves are too far apart for one — which is what
 * the whole control lighting up at once comes to there.
 */
export function SpecIssueReturnLink({
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
  const prefix = useRefPrefix(slug);
  const state = useReturnLinkState();
  const reference = formatRef(prefix, number);
  return (
    <Link
      to="/projects/$slug/issues/$number"
      params={{ slug, number: String(number) }}
      state={state}
      // The visible label is the ref, so the accessible name has to carry it:
      // a name of "Back to Issue" over a control reading `T-1` leaves voice
      // control with nothing to say (WCAG 2.5.3).
      aria-label={`Back to ${reference}`}
      data-toolbar-slot={slot}
      className={cn(
        "group/back -my-1 inline-flex shrink-0 items-center gap-2 rounded-md py-1 text-sm text-muted-foreground tabular-nums hover:bg-muted hover:text-foreground",
        // Left padding only while the arrow is still in the row: in the gutter
        // it would run the two tints together across the column's edge.
        floating ? "-mr-2 pr-2" : "-mx-2 px-2",
      )}
    >
      {/* The same 4px of slack the icon buttons give a `size-4` arrow, so the
          gutter offset is one number for every host that hangs one (T-470). */}
      <span
        className={cn(
          "inline-flex shrink-0 items-center justify-center",
          floating &&
            "absolute right-full mr-2 size-6 rounded-md group-hover/back:bg-muted",
        )}
      >
        <ArrowLeftIcon className="size-4" />
      </span>
      {reference}
    </Link>
  );
}

/**
 * Back to the card, on the page that has no spec to show yet.
 *
 * The one place the arrow keeps its words. Every other host sits beside a
 * title that says where back goes; a lone arrow centred under one sentence
 * says nothing, so this one names the card and wears a border to look like
 * the action it is (T-461).
 */
export function SpecEmptyReturnButton({
  slug,
  number,
}: {
  slug: string;
  number: number;
}) {
  const prefix = useRefPrefix(slug);
  const state = useReturnLinkState();
  return (
    <Button asChild size="sm" variant="outline" className="mt-4">
      <Link
        to="/projects/$slug/issues/$number"
        params={{ slug, number: String(number) }}
        state={state}
      >
        <ArrowLeftIcon className="size-4" />
        Back to {formatRef(prefix, number)}
      </Link>
    </Button>
  );
}

/** Back to this project's list, for the pages under it that are not tabs. */
export function ProjectReturnLink({
  slug,
  ...back
}: BackProps & { slug: string }) {
  return (
    <BackButton {...back}>
      <Link to="/projects/$slug" params={{ slug }} aria-label="Back to Issues">
        <ArrowLeftIcon className={ARROW[back.scale]} />
      </Link>
    </BackButton>
  );
}

/** Back out of the project, which is where the four project tabs go. */
export function ProjectsReturnLink({ ...back }: BackProps) {
  return (
    <BackButton {...back}>
      <Link to="/projects" aria-label="Back to Projects">
        <ArrowLeftIcon className={ARROW[back.scale]} />
      </Link>
    </BackButton>
  );
}

/**
 * The back control the header wears on a phone, where no page has a gutter or
 * a heading to hang one beside (T-461). The route says which kind; where the
 * kind is a card's, the destination is still resolved by the control itself,
 * from the origin frozen into this history entry.
 */
export function NavBackControl({
  kind,
  slug,
  number,
}: {
  kind: BackControlKind;
  slug: string;
  number?: string;
}) {
  switch (kind) {
    case "issue":
      return <IssueReturnLink slug={slug} scale="nav" />;
    case "spec":
      return number === undefined ? null : (
        <SpecReturnLink slug={slug} number={Number(number)} scale="nav" />
      );
    case "project":
      return <ProjectReturnLink slug={slug} scale="nav" />;
    case "projects":
      return <ProjectsReturnLink scale="nav" />;
  }
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
  omitRef = false,
}: {
  slug: string;
  number: number;
  title?: string;
  slot?: string;
  className?: string;
  /**
   * The ref is being drawn by the back control beside this one, which has
   * absorbed it into its hit area. Saying the number twice on one row is
   * worse than either place saying it alone.
   */
  omitRef?: boolean;
}) {
  const prefix = useRefPrefix(slug);
  const refLeads = useRefPlacement("detail") === "before";
  const reference = omitRef ? null : (
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
