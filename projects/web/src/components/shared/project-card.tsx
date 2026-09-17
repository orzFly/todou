import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ProjectIcon } from "@/components/shared/project-icon.tsx";
import { RefWatermark } from "@/components/shared/ref-watermark.tsx";
import {
  Card,
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
        <CardHeader className="relative z-10">
          <CardTitle
            className={cn(
              "flex items-center gap-2.5 text-base",
              muted && "text-muted-foreground",
            )}
          >
            <ProjectIcon
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
        </CardHeader>
        {project.prefix && <RefWatermark prefix={project.prefix} />}
      </Card>
    </Link>
  );
}
