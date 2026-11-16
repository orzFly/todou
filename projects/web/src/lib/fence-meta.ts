/** Lines past which a post's code block is capped and scrolls in its frame. */
export const FENCE_COLLAPSE_LINES = 30;

/**
 * The filename a fence's info string names after its language, if any:
 * `title="…"` as Docusaurus and Expressive Code write it, else a bare first
 * word as DokuWiki's `<code yaml compose.yaml>` does. GitHub highlights both
 * by the first word and ignores the rest, so either survives a paste
 * elsewhere. A first word holding `=` is an option, and one opening on `{`
 * is line-highlight syntax (`{1,3}`); neither names a file.
 */
export function fenceTitle(meta: string | undefined): string | undefined {
  if (meta === undefined) return undefined;
  const titled = /(?:^|\s)title=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(meta);
  let raw: string | undefined;
  if (titled) {
    raw = titled[1] ?? titled[2] ?? titled[3];
  } else {
    const first = meta.trim().split(/\s+/)[0];
    if (!first.includes("=") && !first.startsWith("{")) raw = first;
  }
  const title = raw?.trim();
  return title === "" ? undefined : title;
}
