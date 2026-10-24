import type { ProjectIconFallback } from "@todou/shared";
import { useId, useLayoutEffect, useRef } from "react";
import { projectTint } from "@/lib/project-tint.ts";
import { cn } from "@/lib/utils";

/**
 * As a share of the box. The text is sized in the box's own units, so it
 * scales with whatever box it is drawn in; this cap is what keeps the widest
 * text (`WWW`, `KGM`) inside it too, at every size and in whichever font
 * actually loaded. It holds for a round box as well: capitals this wide reach
 * 0.45 of the box from its centre.
 */
const GLYPH_MAX_WIDTH = 0.84;

/**
 * Every generator either kind of subject can be set to. The user enum is a
 * subset of the project one for now, so the project enum names them all.
 */
export type FallbackGenerator = ProjectIconFallback;

/**
 * What an avatar box draws when nothing was uploaded (T-544, T-555): `text`
 * drawn by `generator`. `seed` picks the colourful generator's gradient and is
 * ignored by the others.
 *
 * Monochrome draws no background of its own: the `AvatarFallback` it sits in
 * already paints the theme's muted square or circle, and the text takes that
 * element's colour, so the scheme follows the theme the way it always did.
 *
 * The text is HTML over an SVG background rather than SVG `<text>`: Chromium
 * lays SVG text out as a block, and a block on the copy path ends in a newline
 * in `text/plain` whatever `user-select` says, so a mention's avatar pasted
 * `« \n@user »`. Measured on Chromium 156; `foreignObject` and `<use>` do the
 * same.
 */
export function FallbackGlyph({
  text,
  generator,
  seed,
}: {
  text: string;
  generator: FallbackGenerator;
  seed: string;
}) {
  // Every icon on a page carries its own gradient, and a repeated id would let
  // one icon paint with another's.
  const gradient = `fallback-tint-${useId().replace(/[^\w-]/g, "")}`;
  const box = useRef<HTMLSpanElement>(null);
  const fit = useRef<HTMLSpanElement>(null);
  const glyph = useRef<HTMLSpanElement>(null);
  const colorful = generator === "colorful_text";

  // biome-ignore lint/correctness/useExhaustiveDependencies: the text and its weight are the measurement input.
  useLayoutEffect(() => {
    const measure = () => {
      const outer = box.current;
      const group = fit.current;
      const label = glyph.current;
      if (!outer || !group || !label) return;
      group.style.transform = "";
      const room = outer.getBoundingClientRect().width * GLYPH_MAX_WIDTH;
      const width = label.getBoundingClientRect().width;
      // Not laid out (happy-dom, or a closed popover): nothing to fit yet, and
      // the observer below measures again once there is.
      if (room === 0 || width === 0) return;
      if (width > room) group.style.transform = `scale(${room / width})`;
    };
    measure();
    // The ratio holds at every size, since the text is sized in the box's
    // units; what changes it is a box that had no size when this first ran.
    const resize =
      typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    if (box.current) resize?.observe(box.current);
    // A measurement taken in the fallback face is wrong once Geist arrives.
    document.fonts?.addEventListener("loadingdone", measure);
    return () => {
      resize?.disconnect();
      document.fonts?.removeEventListener("loadingdone", measure);
    };
  }, [text, colorful]);

  const tint = colorful ? projectTint(seed) : null;

  return (
    // Announced as the text, the way the bare text it replaced was; the
    // background carries nothing to announce.
    <span
      ref={box}
      role="img"
      aria-label={text}
      data-generator={generator}
      className="relative block size-full [container-type:size]"
    >
      {tint && (
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
          className="absolute inset-0 size-full"
        >
          <defs>
            <linearGradient id={gradient} x2="1" y2="1">
              <stop offset="0" stopColor={tint.from} />
              <stop offset="1" stopColor={tint.to} />
            </linearGradient>
          </defs>
          <rect width="100" height="100" fill={`url(#${gradient})`} />
        </svg>
      )}
      {/* Not centred by flex: the mention chip makes every span in its avatar
          an inline-block, for the same copy-path reason as above. Vertically,
          a line the box's height puts Geist's baseline 0.355em below the
          middle, half its 0.7em cap height, which centres capitals rather than
          the em box. Horizontally, an offset and a translate, because
          `text-align: center` starts a line wider than its box at the left
          edge, and the fit then shrinks it off-centre. That offset counts from
          the line's start, so the alignment is pinned rather than inherited:
          the header's account button centres its text. React never writes the
          outer span's transform, so a re-render cannot undo the fit. */}
      <span
        ref={fit}
        className={cn(
          "absolute inset-0 text-left whitespace-nowrap [font-size:44cqh] [line-height:100cqh]",
          colorful
            ? "font-semibold text-white drop-shadow-[0_1px_1px_rgb(0_0_0/0.25)]"
            : "font-medium",
        )}
      >
        <span
          ref={glyph}
          data-glyph-text=""
          className="relative left-1/2 inline-block -translate-x-1/2"
        >
          {text}
        </span>
      </span>
    </span>
  );
}
