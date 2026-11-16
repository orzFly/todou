import type { Status } from "@todou/shared";

/**
 * The only drawing of a status (T-715), in menus and completions as much as
 * on a card: no styling props, and `label-status-rendering.test.ts` fails on
 * any drawing that goes around it. StatusHeading below is the one sanctioned
 * exception.
 *
 * Vertical metrics (text-xs, py-0.5, border) must equal the label chip's —
 * see the note there (T-98). `shrink-0` because on a shared line the labels
 * are what give ground; `align-middle` only acts in running text.
 *
 * The prop is only the face of a status so that timeline events, whose
 * payloads are name-and-id snapshots, can render one too.
 */
export function StatusPill({
  status,
}: {
  status: Pick<Status, "name" | "color">;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 align-middle text-xs whitespace-nowrap">
      <span
        className="size-2 rounded-full"
        style={{ backgroundColor: status.color }}
        aria-hidden
      />
      {status.name}
    </span>
  );
}

/**
 * A status as the title of what it groups — the issue list's group header and
 * a board column. Kept apart from the pill by the user's decision on T-715;
 * it renders into the caller's flex row, whose gap and text size it takes.
 * Only the name gives ground: a long one truncates rather than squeezing the
 * count beside it (T-303).
 */
export function StatusHeading({
  status,
}: {
  status: Pick<Status, "name" | "color">;
}) {
  return (
    <>
      <span
        className="size-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: status.color }}
        aria-hidden
      />
      <span className="min-w-0 truncate font-medium">{status.name}</span>
    </>
  );
}
