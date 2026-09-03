/**
 * The character classes a project slug and an internal ref prefix are made
 * of — the single source both the validators and every parser derive from.
 *
 * Four places wrote these shapes out by hand (the zod schemas, the reference
 * scanner, the editor's completion trigger, the CLI's positional parser) and
 * a fifth was about to (T-214). This module imports nothing on purpose: a
 * schema reaching for the grammar scanner would be a backwards dependency,
 * so both point here instead.
 */

export const SLUG_HEAD_CLASS = "[a-z0-9]";
export const SLUG_BODY_CLASS = "[a-z0-9-]";
export const PREFIX_HEAD_CLASS = "[A-Z]";
export const PREFIX_BODY_CLASS = "[A-Z0-9_]";

/** Longest prefix accepted, head included — so the body repeats one less. */
export const MAX_PREFIX_LENGTH = 20;

/** Unanchored, uncaptured; an anchor or a boundary is the caller's to add. */
export const SLUG_PATTERN = `${SLUG_HEAD_CLASS}${SLUG_BODY_CLASS}*`;
export const PREFIX_PATTERN = `${PREFIX_HEAD_CLASS}${PREFIX_BODY_CLASS}{0,${MAX_PREFIX_LENGTH - 1}}`;
