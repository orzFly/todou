/**
 * How big the watermark is drawn, by prefix length.
 *
 * Size gives way to length because the card clips its own overflow: twenty
 * `W`s at 3.25rem measure 993px against a 363px card, and the whole point of
 * this mark is that the prefix is legible in full. Nothing here is about the
 * description — text lies over the mark by design.
 *
 * Prefixes may reach 20 characters (`[A-Z][A-Z0-9_]{0,19}`); past about 13
 * this has stopped looking like a watermark at all, which is the honest
 * degradation for an input that pathological. The everyday case is one to
 * four characters.
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

/** Exported so the bands can be tested at their edges directly. */
export function watermarkFontSize(prefix: string): string {
  return `${bandFor(prefix).rem}rem`;
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
      // `z-0` against the header's `z-10`: an absolutely positioned element
      // paints after static content whatever the DOM order, so without this
      // the mark sits *over* the description instead of behind it. A negative
      // z-index is the obvious alternative and the wrong one — `Card` opens no
      // stacking context, so the mark would sink behind the card's own
      // background and vanish.
      className="pointer-events-none absolute right-3 bottom-1.5 z-0 select-none font-bold text-foreground opacity-[0.09] leading-none"
      style={{ fontSize: watermarkFontSize(prefix), letterSpacing: "-0.05em" }}
    >
      {prefix}
    </span>
  );
}
