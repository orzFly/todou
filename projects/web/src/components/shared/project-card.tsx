import { cn } from "@orz/ui";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@orz/ui/components/card";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ProjectIcon } from "@/components/shared/project-icon.tsx";

/**
 * The project card and the grid it stands in — one definition for the
 * projects home and for the user page's seats (T-390). Changing a class here
 * changes both pages, which is the point and the thing to know before
 * touching it.
 *
 * The grid is exported beside the card rather than left to the call site
 * because even rows are held up by three classes split across the pair: the
 * grid's `auto-rows-fr`, the card's `h-full` and the description's
 * `line-clamp-3`.
 */
export function ProjectCardGrid({ children }: { children: ReactNode }) {
  // `auto-rows-fr` makes every row as tall as its tallest card.
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
      {/* `h-full` is not redundant beside `auto-rows-fr` — it is what passes
          the row's height down to the card. `relative` anchors the `sr-only`
          REF below to the card rather than to the page. */}
      <Card className="relative h-full transition-colors hover:bg-accent/50">
        <CardHeader>
          <CardTitle
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2",
              muted && "text-muted-foreground",
            )}
          >
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
          {action !== undefined && <CardAction>{action}</CardAction>}
        </CardHeader>
        {/* The content takes the card's slack, so the corner's `self-end`
            lands on the card's bottom padding. The corner sits in the row
            rather than out of flow: it narrows the description, which is
            what keeps a three-line description from running under it. */}
        <CardContent className="flex flex-1 items-start gap-3">
          <ProjectIcon
            aria-hidden="true"
            project={{
              slug: project.slug,
              name: project.name,
              prefix: project.prefix,
              icon_url: project.icon_url,
            }}
            className="size-10 shrink-0"
          />
          {/* Without the clamp every card on the page pays the tallest card's
              height: measured, one five-line description takes every card to
              176px against the 136px the clamp holds them to. */}
          <p
            data-slot="project-card-description"
            className="line-clamp-3 min-w-0 flex-1 text-muted-foreground"
          >
            {children}
          </p>
          {corner !== undefined && (
            <div data-slot="project-card-corner" className="flex self-end">
              {corner}
            </div>
          )}
        </CardContent>
        {/* The REF for a screen reader, which the drawn one never reaches: the
            icon is `aria-hidden`, and an uploaded icon draws no REF at all.
            Last in DOM order, so it is read after the name. */}
        {project.prefix && <span className="sr-only">{project.prefix}</span>}
      </Card>
    </Link>
  );
}
