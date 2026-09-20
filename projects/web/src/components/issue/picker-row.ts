/**
 * The row geometry the Labels and Assignees pickers share (T-458).
 *
 * One constant rather than a matching pair of class strings, because the two
 * menus are built out of different parts — the Labels rows are hand-rolled
 * `role="option"` buttons inside a popover, the Assignees rows are Radix menu
 * items carrying their own padding — and nothing else would make a row in one
 * the same height as a row in the other.
 *
 * `min-h-8.5` is 34px, and it is what makes the two equal rather than merely
 * similar: padding and type scale alone leave the Assignees rows 2px shorter,
 * because a Labels row is built around a 22px chip (16px of text inside a
 * border and 2px of padding) where an Assignees row is built around a 20px
 * avatar. 34px is 22px of that chip plus this padding — a Labels row at its
 * natural height, which the Assignees rows are then held up to.
 *
 * The corner radius is deliberately not here: each menu keeps its own, so the
 * Assignees menu still matches the Status and Notifications menus standing
 * beside it in the same sidebar.
 */
export const PICKER_ROW = "min-h-8.5 gap-2 px-2 py-1.5 text-sm";
