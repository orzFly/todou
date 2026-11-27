import { cn } from "@orz/ui";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
  ModuleGrid,
} from "@orz/ui/components/card";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ProjectIcon } from "@/components/shared/project-icon.tsx";

/**
 * The projects page's cards and the grid they stand in.
 *
 * The grid is exported beside the card rather than left to the call site
 * because even rows are held up by three classes split across the pair: the
 * grid's `auto-rows-fr`, the card's `h-full` and the description's
 * `line-clamp-3`.
 */
export function ProjectCardGrid({ children }: { children: ReactNode }) {
  // `auto-rows-fr` makes every row as tall as its tallest card. No padding of
  // the grid's own: the cards line up with the page's heading. Important,
  // because `cn` keeps `p-module` beside a plain `p-0` (UI-264).
  return (
    <ModuleGrid className="auto-rows-fr p-0! sm:grid-cols-2 lg:grid-cols-3">
      {children}
    </ModuleGrid>
  );
}

/**
 * One project. The name is the link, and its click area is stretched over
 * the whole card, so the card still opens on a click anywhere — middle and
 * modified clicks included — while the controls on it stay out of the
 * anchor: an interactive element inside an `<a>` is invalid, and a screen
 * reader stepping through the cards hears the name, not the description.
 */
export function ProjectCard({
  project,
  muted = false,
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
  /** The never-visited dimming. */
  muted?: boolean;
  /** Optional header action; omitted means no action wrapper or layout change. */
  action?: ReactNode;
  /** The bottom-right corner, under the action (T-542). */
  corner?: ReactNode;
  /** The description slot. */
  children?: ReactNode;
}) {
  return (
    // `h-full` is not redundant beside `auto-rows-fr` — it is what passes the
    // row's height down to the card. `relative` is what the name's stretched
    // click area covers.
    <Card className="relative h-full transition-colors hover:bg-accent/50 has-[a:focus-visible]:focus-ring">
      <CardHeader>
        <CardTitle
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2",
            muted && "text-muted-foreground",
          )}
        >
          {/* Lifted over the icon, which positions itself to draw and would
              otherwise take the clicks on it; the badge and the watchers sit
              higher still. */}
          <Link
            to="/projects/$slug"
            params={{ slug: project.slug }}
            className="min-w-0 truncate outline-none after:absolute after:inset-0 after:z-1"
          >
            {project.name}
            {/* The REF for a screen reader, which the drawn one never
                reaches: the icon is `aria-hidden`, and an uploaded icon draws
                no REF at all. In the link, after the name, so it is part of
                the link's name. */}
            {project.prefix && (
              <>
                {" "}
                <span className="sr-only">{project.prefix}</span>
              </>
            )}
          </Link>
        </CardTitle>
        {action !== undefined && (
          <CardAction className="relative z-10">{action}</CardAction>
        )}
      </CardHeader>
      {/* The content takes the card's slack, so the corner's `self-end` lands
          on the card's bottom padding. The corner sits in the row rather than
          out of flow: it narrows the description, which is what keeps a
          three-line description from running under it. */}
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
          <div
            data-slot="project-card-corner"
            className="relative z-10 flex self-end"
          >
            {corner}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
