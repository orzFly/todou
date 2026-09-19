/**
 * The chips a rich reference and an attachment wear inside a markdown body,
 * in layers so that the two preferences governing them stay independent: a
 * title ellipsis needs the structure, the border needs only the skin.
 *
 * Nothing here reaches a timeline event row. T-359 measured that row's
 * geometry to 0.00px and these classes must not be able to reopen it.
 */
import "./rich-chip.css";

/**
 * The issue chip's own structure, and the one thing it may not be is a flex
 * container: a flex box puts each child on its own line fragment, and the
 * clipboard serialises those fragments as newlines even where the DOM spells
 * none — `[ \nT-2\n#comment-102\n ]` from a `nowrap` one (T-434 measured it
 * in Chromium against a real drag, Ctrl+C and Ctrl+V, both directions).
 * Spacing is therefore real separator text, which is also what gives a long
 * title somewhere to wrap; see rich-chip.css for the rest.
 */
export const REF_CHIP_STRUCTURE = "ref-chip-body";

/**
 * `.markdown-body a` underlines every link, and a border saying "clickable"
 * on top of an underline says it twice; hover takes over what the underline
 * was for. The utilities layer is emitted after the components layer that
 * rule lives in, so `no-underline` wins without a specificity fight.
 */
export const RICH_CHIP_SKIN =
  "rounded-sm border bg-muted/40 px-[0.3em] py-px no-underline hover:border-ring hover:bg-muted focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-ring";

/** The issue chip's status glyph: spacing and baseline come from the sheet. */
export const REF_CHIP_ICON = "ref-chip-icon inline size-3.5";

/**
 * `overflow: hidden` degrades an inline box's baseline to its bottom edge,
 * which rich-chip.css answers with `vertical-align: bottom` — so the title
 * has to stay a child of the chip rather than the chip itself.
 */
export const REF_CHIP_LABEL = "ref-chip-title truncate";

/**
 * `items-baseline` is what puts the attachment title's baseline on the
 * paragraph's: every child then shares one baseline, and the container
 * reports it as its own. Measured at 1024px and 390px, the title sits 0.00px
 * off the surrounding text; `align-items: center` or the flex default puts it
 * 2.39px out.
 *
 * `leading-[1.2]` keeps a chip from growing the line it sits on. Against the
 * body's 1.6 the budget is exact: 1.2 lands the line box on the same 22.39px
 * as a chipless one, while vscode's 1.25 overruns it by 0.11px.
 *
 * An attachment chip carries a filename, not a reference anyone copies as an
 * identity, so the clipboard note on REF_CHIP_STRUCTURE does not reach it.
 */
export const RICH_CHIP_STRUCTURE =
  "inline-flex max-w-full items-baseline gap-[0.24em] align-baseline leading-[1.2] whitespace-nowrap";

/**
 * `self-center` sits the icon beside the text rather than above it: an SVG
 * has no baseline of its own, so under `items-baseline` it would hang its
 * whole box off the shared one, 1px taller a chip with the glyph riding high.
 */
export const RICH_CHIP_ICON = "inline size-3.5 self-center";

/**
 * `overflow: hidden` degrades an inline box's baseline to its bottom edge but
 * leaves a flex item's alone, which is why the label is a child of the chip
 * rather than the chip itself.
 */
export const RICH_CHIP_LABEL = "min-w-0 flex-initial truncate";

/**
 * About 24 CJK characters or 48 Latin ones at the body's 14px — vscode's
 * 200px cap, widened for a language whose glyphs are twice as wide.
 */
export const RICH_CHIP_TITLE_CAP = "max-w-[24em]";

/** A mention's chip: the current `@login` is the only copyable part. */
export const MENTION_CHIP_STRUCTURE = "mention-chip-body";
