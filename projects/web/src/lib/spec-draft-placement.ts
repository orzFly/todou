import { remapLineRange } from "@todou/shared/spec-remap";
import type { SpecReviewDraft } from "@/lib/spec-drafts.ts";

/** Where a staged comment stands on the version on screen. */
export type DraftPlacement =
  | { kind: "line"; start: number; end: number }
  | { kind: "file" }
  | { kind: "unplaced" }
  /** Its own version's files have not arrived yet. */
  | { kind: "loading" };

/**
 * Places a draft on `version` the way the server places a submitted comment
 * on a newer version: lines move with the text around them, and lines whose
 * text changed have no place left. The draft itself keeps its anchor; this
 * only decides where it is drawn.
 */
export function placeDraft(
  draft: SpecReviewDraft,
  version: number,
  /** Path to body, for the version on screen. */
  viewedFiles: ReadonlyMap<string, string>,
  /** Path to body, for the draft's own version; undefined until fetched. */
  anchorFiles: ReadonlyMap<string, string> | undefined,
): DraftPlacement {
  const { anchor } = draft;
  const start = anchor.line_start;
  const end = anchor.line_end;
  if (anchor.version === version) {
    return start === null || end === null
      ? { kind: "file" }
      : { kind: "line", start, end };
  }
  const viewed = viewedFiles.get(anchor.path);
  if (viewed === undefined) return { kind: "unplaced" };
  if (start === null || end === null) return { kind: "file" };
  if (anchorFiles === undefined) return { kind: "loading" };
  const original = anchorFiles.get(anchor.path);
  if (original === undefined) return { kind: "unplaced" };
  const moved = remapLineRange(original, viewed, start, end);
  if (moved.outdated || moved.start === null || moved.end === null) {
    return { kind: "unplaced" };
  }
  return { kind: "line", start: moved.start, end: moved.end };
}
