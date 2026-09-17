/**
 * How many ems wide the mark is allowed to be, and therefore how many
 * characters it draws: one em per character is an upper bound on the widest
 * glyph the charset allows, `W` advancing 0.95601em with the tracking applied.
 *
 * Deliberately not `ProjectIcon`'s `GLYPH_LIMIT`. The icon draws three because
 * a 14–40px box holds no more; the mark draws four because that is the
 * height-against-legibility trade chosen for a corner mark. Two constants for
 * two constraints, and unifying them would move one of them silently.
 */
const WATERMARK_EMS = 4;

/** Tallest ink in `[A-Z0-9_]`, measured: `W` is 0.71em, round glyphs 0.73em. */
const CAP_RATIO = 0.73;

/** How far past the card's corner the ink runs, in em of the rendered mark. */
const BLEED_EM = 0.06;

/**
 * A project's REF, sunk into the bottom-right corner of its card.
 *
 * Not `aria-hidden`, and `aria-label` carries the REF whole although four
 * characters are drawn: with no badge anywhere on the card this is the only
 * place a screen reader meets it. It sits after the header in DOM order, so it
 * is read last.
 */
export function RefWatermark({ prefix }: { prefix: string }) {
  return (
    <svg
      data-slot="ref-watermark"
      role="img"
      aria-label={prefix}
      // The viewBox width is the allowance, not the REF's length, which is what
      // makes every mark on a page of equal-size cards resolve to one size.
      viewBox={`0 0 ${WATERMARK_EMS} ${CAP_RATIO}`}
      // `meet` has the browser resolve min(as wide as the card allows, as tall
      // as the card); `xMaxYMax` pins the result to the bottom-right corner.
      preserveAspectRatio="xMaxYMax meet"
      // `h-full` and `w-[calc(100%-0.75rem)]` are load-bearing. An <svg> is a
      // replaced element: given `height: auto` and both `top` and `bottom`, CSS
      // takes the intrinsic height and drops `bottom`, and the same goes for
      // `left`/`right`/`width`. An svg carrying only a viewBox has a ratio but
      // no intrinsic size, so it falls back to 300×150 and the mark comes out
      // unrelated to its card. Both axes have to be given outright.
      //
      // `overflow-visible` because svg defaults to `overflow: hidden`, which
      // would swallow the bleed; the cut is meant to be `Card`'s own
      // `overflow-hidden`, nothing nearer.
      //
      // `z-0` against the header's `z-10`: an absolutely positioned element
      // paints after static content whatever the DOM order, so without this the
      // mark sits *over* the description instead of behind it. A negative
      // z-index is the obvious alternative and the wrong one — `Card` opens no
      // stacking context, so the mark would sink behind the card's own
      // background and vanish.
      className="pointer-events-none absolute top-0 left-3 z-0 h-full w-[calc(100%-0.75rem)] select-none overflow-visible text-foreground opacity-[0.09]"
    >
      <text
        // The bleed lives inside the viewBox rather than on the element box, so
        // it stays 0.06em of the rendered mark at every size.
        x={WATERMARK_EMS + BLEED_EM}
        y={CAP_RATIO + BLEED_EM}
        fontSize="1"
        textAnchor="end"
        className="fill-current font-bold tracking-[-0.05em]"
      >
        {prefix.slice(0, WATERMARK_EMS)}
      </text>
    </svg>
  );
}
