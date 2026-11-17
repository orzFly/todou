import type { Completion } from "@codemirror/autocomplete";
import type { Label, Status } from "@todou/shared";
import { LabelChip } from "@/components/issue/label-chip.tsx";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import { reactOption } from "./user-completion.tsx";

/**
 * Completion rows that name a status or a label draw it the way every picker
 * does (T-739): the pill or the chip, at the picker row's height. The face
 * already shows the name the row inserts, so the theme hides the label text
 * rather than print it twice.
 *
 * A WeakMap for the reason `user-completion.tsx` gives: CodeMirror owns the
 * `Completion` shape.
 */
const faces = new WeakMap<
  Completion,
  { status: Pick<Status, "name" | "color"> } | { label: Label }
>();

export function withStatus<C extends Completion>(
  completion: C,
  status: Pick<Status, "name" | "color">,
): C {
  faces.set(completion, { status });
  return completion;
}

export function withLabel<C extends Completion>(
  completion: C,
  label: Label,
): C {
  faces.set(completion, { label });
  return completion;
}

/** Tags a face's row so the theme can trade its icon and text for the face. */
export function faceOptionClass(completion: Completion): string {
  return faces.has(completion) ? "cm-completion-face" : "";
}

export function faceOption() {
  return reactOption(20, "cm-completionFace", (completion) => {
    const face = faces.get(completion);
    if (face === undefined) return null;
    return "status" in face ? (
      <StatusPill status={face.status} />
    ) : (
      <LabelChip label={face.label} />
    );
  });
}
