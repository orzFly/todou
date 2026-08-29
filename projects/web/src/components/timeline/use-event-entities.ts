import { useQuery } from "@tanstack/react-query";
import type { Label, Status, UserRef } from "@todou/shared";
import { useMemo } from "react";
import { labelsQuery, membersQuery, statusesQuery } from "@/api/queries.ts";
import { displayNameOf } from "@/components/shared/user-chip.tsx";

/** Project metadata a timeline row needs to render payload entities. */
export type EventEntities = {
  labelById: Map<number, Label>;
  statusById: Map<number, Status>;
  memberById: Map<number, UserRef>;
};

export const NO_ENTITIES: EventEntities = {
  labelById: new Map(),
  statusById: new Map(),
  memberById: new Map(),
};

/**
 * Event payloads are write-time snapshots, so a label recolored or a status
 * renamed since would make the timeline the one place an entity looks unlike
 * itself. All three queries are already hot on an issue page (filter bar,
 * status menu, assignee picker); while they load, every resolver below falls
 * back to the snapshot, so nothing waits on them.
 */
export function useEventEntities(slug?: string): EventEntities {
  const enabled = slug !== undefined;
  const labels = useQuery({ ...labelsQuery(slug ?? ""), enabled });
  const statuses = useQuery({ ...statusesQuery(slug ?? ""), enabled });
  const members = useQuery({ ...membersQuery(slug ?? ""), enabled });
  return useMemo(
    () => ({
      labelById: new Map((labels.data ?? []).map((l) => [l.id, l])),
      statusById: new Map((statuses.data ?? []).map((s) => [s.id, s])),
      memberById: new Map((members.data ?? []).map((m) => [m.user.id, m.user])),
    }),
    [labels.data, statuses.data, members.data],
  );
}

/** Entities the project no longer has still render, in Tailwind's gray-500. */
const NEUTRAL_COLOR = "#6b7280";

const field = (raw: unknown, key: string): unknown =>
  typeof raw === "object" && raw !== null && key in raw
    ? (raw as Record<string, unknown>)[key]
    : undefined;

/**
 * Current label first, snapshot second, `?` last. A label deleted since keeps
 * its snapshot color, and a payload written during the id-only race (the
 * server lost the row mid-write) still yields something chip-shaped.
 */
export function resolveLabel(raw: unknown, byId: Map<number, Label>): Label {
  const id = field(raw, "id");
  const current = typeof id === "number" ? byId.get(id) : undefined;
  if (current) return current;
  const name = field(raw, "name");
  const color = field(raw, "color");
  return {
    id: typeof id === "number" ? id : -1,
    name: typeof name === "string" ? name : "?",
    color: typeof color === "string" ? color : NEUTRAL_COLOR,
  };
}

/** What a pill needs; status payloads are too thin to satisfy `Status`. */
export type StatusFace = Pick<Status, "name" | "color">;

/**
 * Status payloads carry `{id, name}` and no color, so a status deleted since
 * can only come back neutral — the name survives, the hue does not.
 */
export function resolveStatus(
  raw: unknown,
  byId: Map<number, Status>,
): StatusFace {
  const id = field(raw, "id");
  const current = typeof id === "number" ? byId.get(id) : undefined;
  if (current) return current;
  const name = field(raw, "name");
  return {
    name: typeof name === "string" ? name : "?",
    color: NEUTRAL_COLOR,
  };
}

/** A member resolves to a chip; anyone else to the payload's bare login. */
export type ResolvedUser = { user: UserRef | null; text: string };

/**
 * Assignment payloads carry `{id, login}` and no display name, so showing one
 * means finding the member. Someone who has since left the project has no
 * name to show and honestly degrades to `@login`.
 */
export function resolveUser(
  raw: unknown,
  byId: Map<number, UserRef>,
): ResolvedUser {
  const id = field(raw, "id");
  const member = typeof id === "number" ? byId.get(id) : undefined;
  if (member) return { user: member, text: displayNameOf(member) };
  const login = field(raw, "login");
  return { user: null, text: `@${typeof login === "string" ? login : "?"}` };
}
