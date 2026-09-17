/**
 * How big the watermark is drawn, by prefix length.
 *
 * The watermark is never clipped, so length has to buy its room from the type
 * size, or a long prefix would sit on top of the description line. Prefixes
 * may reach 20 characters (`[A-Z][A-Z0-9_]{0,19}`); past about 13 this has
 * stopped looking like a watermark at all, which is the honest degradation
 * for an input that pathological. The everyday case is one to four
 * characters.
 */
const BANDS: ReadonlyArray<{ max: number; rem: number }> = [
  { max: 3, rem: 3.25 },
  { max: 6, rem: 2.25 },
  { max: 12, rem: 1.5 },
  { max: 20, rem: 1 },
];

const bandFor = (prefix: string) =>
  (BANDS.find((b) => prefix.length <= b.max) ?? BANDS[BANDS.length - 1]) as {
    max: number;
    rem: number;
  };

/**
 * One em per character — more than any character can actually take. `W` is
 * the widest of `[A-Z0-9_]` and measures 0.958em at 700 weight with the
 * -0.05em tracking below, the same at both ends of the size range. Reserving
 * the round number leaves room for a font that draws slightly wider: getting
 * this too small puts description text on top of the mark, while getting it
 * too large costs a few pixels of description nobody will miss.
 */
const WIDEST_ADVANCE_EM = 1;

/**
 * The card's own horizontal padding (`px-4`, 1rem) minus the offset the mark
 * sits at (`right-3`, 0.75rem). The description starts inside that padding,
 * so it may reach this much further right than the reserve alone implies.
 */
const HEADER_INSET_REM = 0.25;

/** Exported so the bands can be tested at their edges directly. */
export function watermarkFontSize(prefix: string): string {
  return `${bandFor(prefix).rem}rem`;
}

/**
 * The `padding-right` a card's text needs so it stops before the watermark
 * instead of running under it, in rem so it tracks the type size rather than
 * a pixel assumption. Empty for a card with no watermark to avoid.
 *
 * Sized from the prefix itself, not from the widest one its band admits: a
 * two-character REF is the common case and has no reason to pay for a
 * twenty-character one.
 */
export function watermarkClearance(prefix: string | null): string {
  if (prefix === null || prefix === "") return "";
  const reserve =
    prefix.length * WIDEST_ADVANCE_EM * bandFor(prefix).rem - HEADER_INSET_REM;
  return `${reserve.toFixed(2)}rem`;
}

/**
 * A project's REF, sunk into the bottom-right corner of its card.
 *
 * Not `aria-hidden`: with no badge anywhere on the card this is the only place
 * the REF appears, and hiding it would keep that from a screen reader
 * entirely. It sits after the header in DOM order, so it is read last.
 */
export function RefWatermark({ prefix }: { prefix: string }) {
  return (
    <span
      data-slot="ref-watermark"
      className="pointer-events-none absolute right-3 bottom-1.5 select-none font-bold text-foreground opacity-[0.09] leading-none"
      style={{ fontSize: watermarkFontSize(prefix), letterSpacing: "-0.05em" }}
    >
      {prefix}
    </span>
  );
}
