import { useId, useLayoutEffect, useRef } from "react";
import { initialsOf } from "@/components/shared/user-chip.tsx";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { projectTint } from "@/lib/project-tint.ts";
import { cn } from "@/lib/utils";

/**
 * A project's icon — `UserAvatar`'s opposite number, square where people are
 * round so the two never read as the same kind of thing.
 *
 * The fallback is the REF rather than initials because most projects will
 * never upload an icon, which makes the fallback the everyday case: a bare
 * `CH` identifies a project far better than `H` does. Initials are the last
 * resort, for a project holding no usable prefix.
 */
/**
 * As much of a REF as a box this size can hold. Prefixes run to 20 characters
 * and the box is 14–40px, so the whole of a long one is never legible here —
 * and unclipped it draws straight across the card.
 */
const GLYPH_LIMIT = 3;

/**
 * In the glyph's 100-unit box. The text is sized in the same units, so it
 * scales with whatever box it is drawn in; this cap is what keeps the widest
 * REFs (`WWW`, `KGM`) inside it too, at every size and in whichever font
 * actually loaded.
 */
const GLYPH_MAX_WIDTH = 84;

interface FallbackSubject {
  slug: string;
  name: string;
  prefix?: string | null;
}

function ProjectGlyph({ slug, text }: { slug: string; text: string }) {
  const { from, to } = projectTint(slug);
  // Every icon on a page carries its own gradient, and a repeated id would let
  // one icon paint with another's.
  const gradient = `project-tint-${useId().replace(/[^\w-]/g, "")}`;
  const fit = useRef<SVGGElement>(null);
  const glyph = useRef<SVGTextElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the text is the measurement input.
  useLayoutEffect(() => {
    const measure = () => {
      const group = fit.current;
      const label = glyph.current;
      // happy-dom has no layout to measure.
      if (!group || !label || typeof label.getBBox !== "function") return;
      const { width } = label.getBBox();
      const scale = width > GLYPH_MAX_WIDTH ? GLYPH_MAX_WIDTH / width : 1;
      group.setAttribute("transform", `scale(${scale})`);
    };
    measure();
    // A measurement taken in the fallback face is wrong once Geist arrives.
    document.fonts?.addEventListener("loadingdone", measure);
    return () => document.fonts?.removeEventListener("loadingdone", measure);
  }, [text]);

  return (
    // Announced as the REF, the way the bare text it replaced was; the
    // gradient carries nothing to announce.
    <svg
      viewBox="0 0 100 100"
      role="img"
      aria-label={text}
      className="size-full"
    >
      <defs>
        <linearGradient id={gradient} x2="1" y2="1">
          <stop offset="0" stopColor={from} />
          <stop offset="1" stopColor={to} />
        </linearGradient>
      </defs>
      <rect width="100" height="100" fill={`url(#${gradient})`} />
      <g transform="translate(50 50)">
        {/* Left to the effect: React never writes this group's transform, so
            a re-render cannot undo the fit. */}
        <g ref={fit}>
          {/* The baseline sits half of Geist's 0.7em cap height below the
              middle, which centres capitals rather than the em box. */}
          <text
            ref={glyph}
            y="15.5"
            textAnchor="middle"
            fontSize="44"
            fontWeight="600"
            fill="#fff"
            className="drop-shadow-[0_1px_1px_rgb(0_0_0/0.25)]"
          >
            {text}
          </text>
        </g>
      </g>
    </svg>
  );
}

/**
 * What an avatar box draws for a project that has no icon.
 *
 * Exported because the settings page's icon editor draws the same box through
 * `AvatarEditor` instead of through `ProjectIcon`, and for as long as each of
 * them spelled this rule out separately the two drifted apart.
 */
export function projectIconFallback(project: FallbackSubject) {
  const text = project.prefix
    ? project.prefix.slice(0, GLYPH_LIMIT)
    : initialsOf(project.name);
  return <ProjectGlyph slug={project.slug} text={text} />;
}

export function ProjectIcon({
  project,
  className,
  ...props
}: {
  project: FallbackSubject & { icon_url?: string | null };
} & React.ComponentProps<typeof Avatar>) {
  return (
    <Avatar
      shape="square"
      // Clipped here rather than on `Avatar` itself: only this caller fills
      // the fallback with a square gradient that has to take the box's
      // rounded corners, and a shared component should not carry one
      // caller's constraint.
      className={cn(
        "inline-flex size-5 overflow-hidden align-middle",
        className,
      )}
      {...props}
    >
      {/* Absent rather than empty: an <AvatarImage> with no src would cost a
          404 on every project that has no icon, which is most of them. */}
      {project.icon_url && <AvatarImage src={project.icon_url} alt="" />}
      <AvatarFallback>{projectIconFallback(project)}</AvatarFallback>
    </Avatar>
  );
}
