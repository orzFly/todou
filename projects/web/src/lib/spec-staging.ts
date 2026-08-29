import type { ComposerStaging } from "@/components/spec/spec-composer.tsx";
import type { SpecReviewDraft } from "@/lib/spec-drafts.ts";

/**
 * What the spec composer is currently writing: the anchor it will stage
 * against, which staged draft it is rewriting (T-159), and the session the
 * composer is keyed by.
 *
 * The session number — not the anchor — is what remounts the composer, so
 * re-aiming the anchor mid-sentence keeps the text that was already typed.
 */
export type Staging = ComposerStaging & {
  /** Set while editing an existing draft; unset for a brand-new comment. */
  draftId?: string;
  session: number;
};

/**
 * Point the composer at another anchor. A closed composer opens a fresh
 * session; an open one keeps writing what it was writing — before T-159 a
 * new selection re-keyed the composer and silently dropped the body.
 */
export function retarget(
  prev: Staging | null,
  next: ComposerStaging,
  newSession: number,
): Staging {
  if (prev === null) return { ...next, session: newSession };
  return { ...next, session: prev.session, draftId: prev.draftId };
}

/**
 * Load a staged draft back into the composer. Always a new session: the
 * editor reads its document at mount, so the body only lands by remounting.
 */
export function beginEdit(draft: SpecReviewDraft, newSession: number): Staging {
  return {
    path: draft.anchor.path,
    version: draft.anchor.version,
    lineStart: draft.anchor.line_start,
    lineEnd: draft.anchor.line_end,
    colStart: draft.anchor.col_start,
    colEnd: draft.anchor.col_end,
    quote: draft.quote,
    draftId: draft.id,
    session: newSession,
  };
}
