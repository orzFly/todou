import type { MemberRole } from "./schemas/project.ts";

/**
 * Roles are a total order, not a set of independent grants: every role holds
 * everything the one below it holds. `reporter` was added between reader and
 * writer because what it gains — opening issues, commenting, and fixing its
 * own — was already a subset of writer's, so nothing had to become a lattice.
 */
export const ROLE_RANK: Record<MemberRole, number> = {
  reader: 0,
  reporter: 1,
  writer: 2,
  admin: 3,
};

type Capability = {
  id: string;
  /** The lowest role the gate lets through. */
  minRole: MemberRole;
  /**
   * - `"gate"` — enforced by `requireCapability`; editing `minRole` here is
   *   the behaviour change, with no server code to edit alongside it.
   * - `"addressed"` — the route resolves the project without demanding a
   *   role, and visibility is decided afterwards from where the thing now
   *   lives (T-242). `minRole` is then the floor a reader needs to see
   *   anything at all, not a gate anyone can move.
   */
  enforce: "gate" | "addressed";
  /**
   * Orthogonal to the role order: reaching `minRole` still only reaches your
   * own rows, unless you are an admin. Without this flag the permission table
   * would read "writers may delete issues" where the code means "their own".
   */
  ownerOnly?: true;
};

/**
 * Every role check in the product, in one place, so the same field is read
 * by the gate that enforces it and by the table that documents it. Anything
 * less — a second list for the UI, prose in an OpenAPI summary — drifts,
 * which is exactly how the four copies this replaced came about.
 *
 * Two tests in the server package keep it honest: no `requireProject` call
 * may pass a role literal, and no `"gate"` entry may go unused.
 */
export const CAPABILITIES = [
  { id: "project.read", minRole: "reader", enforce: "gate" },
  { id: "project.stream", minRole: "reader", enforce: "gate" },
  { id: "project.update", minRole: "admin", enforce: "gate" },
  { id: "project.delete", minRole: "admin", enforce: "gate" },

  { id: "member.list", minRole: "reader", enforce: "gate" },
  { id: "member.set", minRole: "admin", enforce: "gate" },
  { id: "member.remove", minRole: "admin", enforce: "gate" },

  { id: "issue.list", minRole: "reader", enforce: "gate" },
  { id: "issue.count", minRole: "reader", enforce: "gate" },
  { id: "issue.read", minRole: "reader", enforce: "addressed" },
  { id: "issue.mark_read", minRole: "reader", enforce: "gate" },
  { id: "issue.create", minRole: "reporter", enforce: "gate" },
  // `PATCH issue` carries five fields behind one gate, so it takes two
  // entries: `issue.update` opens the endpoint, `issue.triage` is what the
  // three fields a reporter must not touch are checked against.
  { id: "issue.update", minRole: "reporter", enforce: "gate", ownerOnly: true },
  { id: "issue.triage", minRole: "writer", enforce: "gate" },
  { id: "issue.trash", minRole: "reporter", enforce: "gate", ownerOnly: true },
  { id: "issue.move", minRole: "writer", enforce: "gate", ownerOnly: true },
  // Deliberately not shared with `issue.create`: this is the gate on the
  // destination project, so borrowing the create gate would let someone who
  // is merely a reporter in B drag other people's cards into B.
  { id: "issue.move_in", minRole: "writer", enforce: "gate" },

  { id: "comment.read", minRole: "reader", enforce: "addressed" },
  { id: "comment.create", minRole: "reporter", enforce: "gate" },
  {
    id: "comment.modify",
    minRole: "reporter",
    enforce: "gate",
    ownerOnly: true,
  },
  { id: "comment.commands", minRole: "writer", enforce: "gate" },

  { id: "question.read", minRole: "reader", enforce: "addressed" },
  { id: "question.answer", minRole: "writer", enforce: "gate" },

  { id: "revision.read", minRole: "reader", enforce: "addressed" },

  { id: "attachment.read", minRole: "reader", enforce: "addressed" },
  // A screenshot is part of the bug report, not a separate privilege.
  { id: "attachment.upload", minRole: "reporter", enforce: "gate" },

  { id: "spec.read", minRole: "reader", enforce: "addressed" },
  { id: "spec.push", minRole: "writer", enforce: "gate" },
  { id: "spec.review", minRole: "writer", enforce: "gate" },
  { id: "spec.resolve", minRole: "writer", enforce: "gate" },

  { id: "label.list", minRole: "reader", enforce: "gate" },
  // Putting a label on a card has always been a writer's to do; keeping the
  // catalog it draws from at admin only meant asking someone else to type
  // the name first.
  { id: "label.create", minRole: "writer", enforce: "gate" },
  { id: "label.update", minRole: "writer", enforce: "gate" },
  { id: "label.delete", minRole: "writer", enforce: "gate" },

  { id: "status.list", minRole: "reader", enforce: "gate" },
  { id: "status.manage", minRole: "admin", enforce: "gate" },

  { id: "reference.read", minRole: "reader", enforce: "gate" },
  { id: "reference.manage", minRole: "admin", enforce: "gate" },

  { id: "search.run", minRole: "reader", enforce: "gate" },

  { id: "timeline.read", minRole: "reader", enforce: "addressed" },
  { id: "activity.read", minRole: "reader", enforce: "gate" },
  { id: "inbox.read", minRole: "reader", enforce: "gate" },
] as const satisfies readonly Capability[];

export type CapabilityId = (typeof CAPABILITIES)[number]["id"];

const BY_ID = Object.fromEntries(
  CAPABILITIES.map((cap) => [cap.id, cap]),
) as Record<CapabilityId, Capability>;

export function capabilityOf(id: CapabilityId): Capability {
  return BY_ID[id];
}

export function minRoleOf(id: CapabilityId): MemberRole {
  return BY_ID[id].minRole;
}

/** Null is a non-member, who holds nothing — not even the reader floor. */
export function can(role: MemberRole | null, id: CapabilityId): boolean {
  if (role === null) return false;
  return ROLE_RANK[role] >= ROLE_RANK[minRoleOf(id)];
}
