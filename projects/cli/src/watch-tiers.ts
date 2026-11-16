import type { IssueEventType } from "@todou/shared";

/** How long a minor entry may wait for an urgent one to ride along with. */
export const DEFER_SEC = 300;

// An allowlist rather than a denylist: an event type missing here costs one
// extra wake-up, while an urgent one mistaken for minor arrives five minutes
// late — and every event type added later starts out urgent.
const MINOR_EVENTS: ReadonlySet<string> = new Set<IssueEventType>([
  "referenced",
  "cross_referenced",
  "attachment_added",
  "attachment_deleted",
  "spec_comments_resolved",
]);

/**
 * Whether a watch may hold this entry back until something urgent comes
 * along (T-694). Comments are always urgent.
 *
 * `block_added`/`block_removed` are minor only on the blocker's end. On the
 * blocked end they are the news itself: removing a card's last blocker
 * announces `block_removed` alone, with no `block_cleared` beside it
 * (`removeBlock` in the server's services/blocks.ts), so that line may be
 * the go-ahead.
 */
export function isMinor(
  item:
    | { type: "comment" }
    | { type: "event"; event_type: string; payload: Record<string, unknown> },
): boolean {
  if (item.type !== "event") return false;
  if (MINOR_EVENTS.has(item.event_type)) return true;
  if (
    item.event_type === "block_added" ||
    item.event_type === "block_removed"
  ) {
    return item.payload.role === "blocker";
  }
  return false;
}
