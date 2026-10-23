import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ProjectIcon } from "@/components/shared/project-icon.tsx";
import { RefWatermark } from "@/components/shared/ref-watermark.tsx";
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * The project card and the grid it stands in — one definition for the
 * projects home and for the user page's seats (T-390). Changing a class here
 * changes both pages, which is the point and the thing to know before
 * touching it.
 *
 * The grid is exported beside the card rather than left to the call site
 * because "one watermark size per page" is held up by three classes split
 * across the pair: the grid's `auto-rows-fr`, the card's `h-full` and the
 * description's `line-clamp-3`. A caller that spelled the grid itself and
 * forgot `auto-rows-fr` would get a page whose marks are each drawn at their
 * own size, with nothing wrong in the card to find.
 */
export function ProjectCardGrid({ children }: { children: ReactNode }) {
  // `auto-rows-fr` makes every row as tall as its tallest card. The watermark
  // resolves its size against the card's box, so cards of different heights
  // would draw the same REF at two sizes on one page.
  return (
    <div className="grid auto-rows-fr gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {children}
    </div>
  );
}

export function ProjectCard({
  project,
  muted = false,
  badge,
  action,
  corner,
  children,
}: {
  project: {
    slug: string;
    name: string;
    prefix: string | null;
    icon_url?: string | null;
  };
  /** The home's never-visited dimming; the user page has no such state. */
  muted?: boolean;
  /** Trailing element of the title row. */
  badge?: ReactNode;
  /** Optional header action; omitted means no action wrapper or layout change. */
  action?: ReactNode;
  /** The bottom-right corner, under the action (T-542). */
  corner?: ReactNode;
  /** The description slot. */
  children?: ReactNode;
}) {
  return (
    <Link to="/projects/$slug" params={{ slug: project.slug }}>
      {/* `relative` so the watermark anchors to the card rather than to the
          page; `Card` already clips its overflow, and that clip is what cuts
          the mark's bleed. `h-full` is not redundant beside `auto-rows-fr` —
          it is what passes the row's height down to the card, which is the box
          the mark sizes itself against. */}
      <Card className="relative h-full transition-colors hover:bg-accent/50">
        {/* Above the watermark: the mark is a background, and a positioned
            element would otherwise paint over this. */}
        {/* With a corner the header takes the card's full height and its
            second row the slack, so the corner's `self-end` lands on the
            card's bottom padding. The corner sits in the action's column
            rather than out of flow: the column narrows the title and the
            description, which is what keeps a three-line description from
            running under it. `minmax(0,1fr)`, not the base `1fr`: that
            column's floor is the title's min-content, so a long name pushed
            the whole second column out past the card's clip, unread badge
            included. */}
        <CardHeader
          className={cn(
            "relative z-10 has-data-[slot=card-action]:grid-cols-[minmax(0,1fr)_auto]",
            corner !== undefined &&
              "flex-1 grid-cols-[minmax(0,1fr)_auto] has-data-[slot=card-description]:grid-rows-[auto_1fr]",
          )}
        >
          <CardTitle
            className={cn(
              "flex items-center gap-2.5 text-base",
              muted && "text-muted-foreground",
            )}
          >
            <ProjectIcon
              aria-hidden="true"
              project={{
                name: project.name,
                prefix: project.prefix,
                icon_url: project.icon_url,
              }}
              className="size-10 text-sm"
            />
            {/* No `min-w-0`: `truncate` brings `overflow-hidden`, which
                already resolves this flex item's `min-width: auto` to 0, so a
                long name gives way and the badge keeps its place. */}
            <span className="truncate">{project.name}</span>
            {/* `ml-auto` belongs to the component, not to the caller: right
                alignment is what makes a column of roles readable, and passed
                in as a class it would be a rule each call site restates. */}
            {badge !== undefined && (
              <span data-slot="project-card-badge" className="ml-auto">
                {badge}
              </span>
            )}
          </CardTitle>
          {/* Without the clamp every card on the page pays the tallest card's
              height: measured, one five-line description takes every card to
              176px against the 136px the clamp holds them to. */}
          <CardDescription className="line-clamp-3">{children}</CardDescription>
          {action !== undefined && <CardAction>{action}</CardAction>}
          {corner !== undefined && (
            <div
              data-slot="project-card-corner"
              className="col-start-2 row-span-2 row-start-1 flex self-end justify-self-end"
            >
              {corner}
            </div>
          )}
        </CardHeader>
        {project.prefix && <RefWatermark prefix={project.prefix} />}
      </Card>
    </Link>
  );
}
