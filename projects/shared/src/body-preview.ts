/**
 * What an untitled card (T-785) shows where a title would go: a plain-text
 * head of its body. A hand-written pass rather than a markdown parser — the
 * server has no markdown stack, and the result is a hint that the card has no
 * title, not a rendering of the body, so imperfect output on exotic markdown
 * is acceptable.
 */

export const BODY_PREVIEW_MAX = 160;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const BLOCK_MARKER =
  /^\s*(?:#{1,6}(?=\s|$)|>|[-*+](?=\s)|\d{1,9}[.)](?=\s|$)|\[[ xX]\](?=\s|$))\s*/;

function stripBlockMarkers(line: string): string {
  let rest = line;
  for (;;) {
    const next = rest.replace(BLOCK_MARKER, "");
    if (next === rest) return rest;
    rest = next;
  }
}

// Escaped punctuation is parked in the Private Use Area while the markers are
// stripped, so `\*` survives as a literal `*` and `\|` is not a table pipe.
const PARK = 0xe000;

function stripInline(text: string): string {
  return text
    .replace(/\\([!-/:-@[-`{-~])/g, (_, ch: string) =>
      String.fromCharCode(PARK + ch.charCodeAt(0)),
    )
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/~~|[*`]/g, "")
    .replace(/(^|[^\p{L}\p{N}_])_+|_+(?=$|[^\p{L}\p{N}_])/gu, "$1")
    .replace(/\|/g, " ")
    .replace(/[\ue021-\ue07e]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - PARK),
    );
}

export function bodyPreview(body: string): string {
  let text = body.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  let lines = text.split(/\r?\n/);
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (end > 0) lines = lines.slice(end + 1);
  }
  const kept: string[] = [];
  for (const line of lines) {
    if (FENCE.test(line)) continue;
    if (THEMATIC_BREAK.test(line) || TABLE_DELIMITER.test(line)) continue;
    kept.push(stripBlockMarkers(line));
  }
  text = stripInline(kept.join("\n")).replace(/\s+/g, " ").trim();
  const points = Array.from(text);
  if (points.length <= BODY_PREVIEW_MAX) return text;
  return `${points.slice(0, BODY_PREVIEW_MAX).join("").trimEnd()}…`;
}

export function displayTitle(item: {
  title: string;
  body_preview?: string | null;
}): { text: string; untitled: boolean } {
  if (item.title !== "") return { text: item.title, untitled: false };
  return { text: item.body_preview ?? "", untitled: true };
}
