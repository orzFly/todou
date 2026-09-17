/**
 * How big the watermark is drawn, and how much room the card's own text has
 * to leave it, by prefix length.
 *
 * The watermark is never clipped, so length has to buy its room twice over:
 * from the type size, or a long prefix would sit on top of the description
 * line, and from the description's own right padding, or a long description
 * would run underneath it. Prefixes may reach 20 characters
 * (`[A-Z][A-Z0-9_]{0,19}`); past about 13 this has stopped looking like a
 * watermark at all, which is the honest degradation for an input that
 * pathological. The everyday case is one to four characters.
 *
 * `clearance` is measured against the widest prefix its band admits, plus the
 * `right-3` the mark itself sits at.
 */
const BANDS: ReadonlyArray<{ max: number; size: string; clearance: string }> = [
  { max: 3, size: "3.25rem", clearance: "pr-28" },
  { max: 6, size: "2.25rem", clearance: "pr-40" },
  { max: 12, size: "1.5rem", clearance: "pr-48" },
  { max: 20, size: "1rem", clearance: "pr-56" },
];

const bandFor = (prefix: string) =>
  BANDS.find((b) => prefix.length <= b.max) ?? BANDS[BANDS.length - 1];

/** Exported so the bands can be tested at their edges directly. */
export function watermarkFontSize(prefix: string): string {
  return (bandFor(prefix) as { size: string }).size;
}

/**
 * The padding a card's text needs so it stops before the watermark instead of
 * running under it. Empty for a card with no watermark to avoid.
 */
export function watermarkClearance(prefix: string | null): string {
  return prefix === null
    ? ""
    : (bandFor(prefix) as { clearance: string }).clearance;
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
