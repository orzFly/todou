import { arrayMove } from "@dnd-kit/sortable";
import type { Status, StatusOrderInput } from "@todou/shared";

/**
 * The Statuses page's one sortable list (T-712): every status, and the block
 * clear line as an item among them, directly above the status it names.
 */
export type Item = { kind: "status"; id: number } | { kind: "line" };

/** The line's sortable id; status ids are numbers, so it cannot collide. */
export const LINE_ID = "line";

export const itemId = (item: Item): number | typeof LINE_ID =>
  item.kind === "line" ? LINE_ID : item.id;

export function arrangementOf(
  statuses: readonly Pick<Status, "id">[],
  lineStatusId: number | null,
): Item[] {
  const items: Item[] = [];
  for (const status of statuses) {
    if (status.id === lineStatusId) items.push({ kind: "line" });
    items.push({ kind: "status", id: status.id });
  }
  return items;
}

/**
 * A line with nothing below it names no status, so a drop that leaves it
 * last puts it back above the last status instead.
 */
export function move(
  items: Item[],
  fromId: number | typeof LINE_ID,
  toId: number | typeof LINE_ID,
): Item[] {
  const from = items.findIndex((item) => itemId(item) === fromId);
  const to = items.findIndex((item) => itemId(item) === toId);
  if (from < 0 || to < 0 || from === to) return items;
  const moved = arrayMove(items, from, to);
  const last = moved.at(-1);
  if (last?.kind !== "line" || moved.length < 2) return moved;
  return [...moved.slice(0, -2), last, moved.at(-2) as Item];
}

export function lineStatusOf(items: Item[]): number | null {
  const at = items.findIndex((item) => item.kind === "line");
  const next = at < 0 ? undefined : items[at + 1];
  return next?.kind === "status" ? next.id : null;
}

export function orderRequest(items: Item[]): StatusOrderInput {
  return {
    ids: items.flatMap((item) => (item.kind === "status" ? [item.id] : [])),
    block_clear_status_id: lineStatusOf(items),
  };
}

/** Where **Draw a line** puts it: above the first closed status, else the last. */
export function drawLine(
  items: Item[],
  statuses: readonly Pick<Status, "id" | "category">[],
): Item[] {
  const rows = items.filter((item) => item.kind === "status");
  if (rows.length === 0) return items;
  const closed = new Set(
    statuses.filter((s) => s.category === "closed").map((s) => s.id),
  );
  const target =
    rows.find((item) => closed.has(item.id)) ?? (rows.at(-1) as Item);
  return rows.flatMap((item) =>
    item === target ? [{ kind: "line" } as Item, item] : [item],
  );
}

/** What a category alone would make of a status in the burn charts. */
const PLAIN_ROLE: Record<string, string> = {
  open: "remaining",
  closed: "completed",
};

/**
 * A row names its chart role only when it departs from what the category
 * says, so on the seeded set most rows carry no text at all.
 */
export function roleException(
  status: Pick<Status, "category">,
  role: string,
): string | null {
  // A category from a newer server has no plain role; every role departs.
  const plain = Object.hasOwn(PLAIN_ROLE, status.category)
    ? PLAIN_ROLE[status.category]
    : undefined;
  return plain === role ? null : role;
}
