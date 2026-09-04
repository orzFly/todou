import { z } from "zod";
import { PREFIX_PATTERN, SLUG_PATTERN } from "../ref-shapes.ts";
import { Id, Timestamp } from "./common.ts";
import { UserRef } from "./user.ts";

export const ProjectSlug = z
  .string()
  .min(1)
  .max(64)
  .regex(
    new RegExp(`^${SLUG_PATTERN}$`),
    "lowercase letters, digits, and dashes",
  );

/**
 * Internal issue reference prefix: null = `#N`, 'T' = `T-N`. Lives here
 * rather than in references.ts because project creation takes one too, and
 * references.ts already imports this file — the other direction would cycle.
 */
export const InternalRefPrefix = z
  .string()
  .regex(
    new RegExp(`^${PREFIX_PATTERN}$`),
    "capital letter, then capitals/digits/_",
  )
  .nullable();
export type InternalRefPrefix = z.infer<typeof InternalRefPrefix>;

export const MemberRole = z.enum(["admin", "writer", "reader"]);
export type MemberRole = z.infer<typeof MemberRole>;

export const Project = z.object({
  id: Id,
  slug: ProjectSlug,
  name: z.string(),
  description: z.string(),
  created_at: Timestamp,
  /**
   * Retired slugs that still route here, oldest first (T-156). Only the
   * single-project GET carries it; listing every project's history would be
   * a query per row for something no list view shows.
   */
  former_slugs: z.array(ProjectSlug).optional(),
  /**
   * The requesting user's role here (T-231). Optional: servers predating it
   * omit it. Lets a picker offer only the projects a card may be moved into
   * without a request per row — the server checks the role again anyway.
   */
  viewer_role: MemberRole.optional(),
});
export type Project = z.infer<typeof Project>;

/** Just enough of a project to name and link it from another entity's view. */
export const ProjectBrief = Project.pick({ id: true, slug: true, name: true });
export type ProjectBrief = z.infer<typeof ProjectBrief>;

export const ProjectCreateInput = z.object({
  slug: ProjectSlug,
  name: z.string().min(1).max(200),
  description: z.string().max(4000).default(""),
  // Omitted and null both mean `#N`: no format history row is written, so
  // the project claims nothing in the cross-project prefix directory.
  ref_prefix: InternalRefPrefix.optional(),
  reclaim: z.boolean().optional(),
});
export type ProjectCreateInput = z.infer<typeof ProjectCreateInput>;

export const ProjectUpdateInput = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  slug: ProjectSlug.optional(),
  /**
   * Take a slug another project used to hold. Required because reclaiming
   * silently would repoint that project's off-site links — including the
   * attachment URLs pasted verbatim into old comments, where a same-numbered
   * attachment in the new project is fetched instead of 404ing.
   */
  reclaim: z.boolean().optional(),
});
export type ProjectUpdateInput = z.infer<typeof ProjectUpdateInput>;

/**
 * Set on a 2xx whose path named a retired slug (T-156), carrying the
 * project's current one. A 3xx would be the obvious spelling and is wrong
 * here: `fetch` follows redirects silently, so the caller would never learn
 * the new slug, and a redirect inside a batch sub-request reads as an error.
 */
export const CANONICAL_SLUG_HEADER = "x-todou-canonical-slug";

export const Member = z.object({
  user: UserRef,
  role: MemberRole,
  created_at: Timestamp,
});
export type Member = z.infer<typeof Member>;

export const MemberSetInput = z.object({
  role: MemberRole,
});
export type MemberSetInput = z.infer<typeof MemberSetInput>;

export const StatusCategory = z.enum(["open", "closed"]);
export type StatusCategory = z.infer<typeof StatusCategory>;

const ColorHex = z.string().regex(/^#[0-9a-f]{6}$/i);

export const Status = z.object({
  id: Id,
  name: z.string(),
  category: StatusCategory,
  color: ColorHex,
  position: z.number().int(),
  is_default: z.boolean(),
});
export type Status = z.infer<typeof Status>;

export const StatusCreateInput = z.object({
  name: z.string().min(1).max(60),
  category: StatusCategory,
  color: ColorHex.default("#6b7280"),
  position: z.number().int().optional(),
});
export type StatusCreateInput = z.infer<typeof StatusCreateInput>;

export const StatusUpdateInput = z.object({
  name: z.string().min(1).max(60).optional(),
  category: StatusCategory.optional(),
  color: ColorHex.optional(),
  position: z.number().int().optional(),
  is_default: z.boolean().optional(),
});
export type StatusUpdateInput = z.infer<typeof StatusUpdateInput>;

/**
 * The status flow agents work in (see the todou-cli skill). Shared because
 * two places must agree on it: the server seeds it into every new project,
 * and `todou status init` applies it to projects that predate it.
 *
 * Colors run gray (not started) → cyan/blue (active) → amber (awaiting
 * delivery) → violet (out) → green (terminal). Category only has two values
 * and cannot carry that, so it holds one invariant instead: Done, the only
 * closed status, is green.
 *
 * Todo is pinned as the default rather than left to the first-by-position
 * fallback, which Backlog now sits ahead of.
 */
export const CANONICAL_STATUSES: ReadonlyArray<{
  name: string;
  category: StatusCategory;
  color: string;
  is_default?: true;
}> = [
  { name: "Backlog", category: "open", color: "#9ca3af" },
  { name: "Todo", category: "open", color: "#6b7280", is_default: true },
  { name: "Next", category: "open", color: "#06b6d4" },
  { name: "In Progress", category: "open", color: "#3b82f6" },
  { name: "Ready to Ship", category: "open", color: "#f59e0b" },
  { name: "Shipped", category: "open", color: "#8b5cf6" },
  { name: "Done", category: "closed", color: "#22c55e" },
];

/** The name a label is actually stored under: trimmed, spaces collapsed. */
export function canonicalizeLabelName(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

/**
 * A writable label name (T-136). Two rules, both of them the CLI's
 * addressing model made binding:
 *
 * - **No commas.** `--label 'a,b'` means two labels there, the way it does
 *   in gh, so a stored `a,b` could be created and then never selected,
 *   renamed or deleted from the CLI again.
 * - **Canonical whitespace.** The CLI trims each comma-separated piece, so
 *   `" bug "` would be just as unreachable. Collapsing runs of whitespace
 *   comes along for free and matches what the web already sent.
 *
 * Read schemas stay unconstrained on purpose: rows that predate this rule
 * must remain listable and renameable — the point is to stop new ones, not
 * to make an existing project unreadable.
 */
export const LabelName = z
  .string()
  .transform(canonicalizeLabelName)
  .pipe(
    z
      .string()
      // Said in terms of what was sent, not of the canonical form the
      // checks actually run against — "too small" reads as nonsense to
      // someone who passed three spaces.
      .min(1, { error: "label names cannot be blank (whitespace is trimmed)" })
      .max(60, { error: "label names are at most 60 characters" })
      .refine((name) => !name.includes(","), {
        error: "label names cannot contain a comma — commas separate labels",
      }),
  );

export const Label = z.object({
  id: Id,
  name: z.string(),
  color: ColorHex,
});
export type Label = z.infer<typeof Label>;

export const LabelCreateInput = z.object({
  name: LabelName,
  color: ColorHex.default("#3b82f6"),
});
export type LabelCreateInput = z.infer<typeof LabelCreateInput>;

export const LabelUpdateInput = z.object({
  name: LabelName.optional(),
  color: ColorHex.optional(),
});
export type LabelUpdateInput = z.infer<typeof LabelUpdateInput>;
