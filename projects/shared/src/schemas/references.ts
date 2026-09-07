import { z } from "zod";
import { Id, Timestamp } from "./common.ts";
import { MovedTo } from "./move.ts";
import { InternalRefPrefix, ProjectSlug } from "./project.ts";

// A trailing digit would make the prefix/number boundary ambiguous
// ("GH2" + "123" reads the same as "GH" + "2123").
export const AutolinkPrefix = z
  .string()
  .min(1)
  .max(20)
  .regex(/^[A-Za-z0-9_#-]+$/, "letters, digits, and _ # -")
  .refine((p) => !/\d$/.test(p), "prefix must not end with a digit");
export type AutolinkPrefix = z.infer<typeof AutolinkPrefix>;

export const AutolinkUrlTemplate = z
  .string()
  .max(500)
  .refine((u) => /^https?:\/\//.test(u), "must be an http(s) URL")
  .refine(
    (u) => u.split("<num>").length === 2,
    "must contain exactly one <num> placeholder",
  );
export type AutolinkUrlTemplate = z.infer<typeof AutolinkUrlTemplate>;

export const Autolink = z.object({
  id: Id,
  prefix: z.string(),
  url_template: z.string(),
});
export type Autolink = z.infer<typeof Autolink>;

export const RefFormatChange = z.object({
  prefix: z.string().nullable(),
  effective_from: Timestamp,
});
export type RefFormatChange = z.infer<typeof RefFormatChange>;

export const ReferenceConfig = z.object({
  format: z.object({
    prefix: z.string().nullable(),
    /** Ascending by effective_from; empty = `#N` since project creation. */
    history: z.array(RefFormatChange),
  }),
  autolinks: z.array(Autolink),
});
export type ReferenceConfig = z.infer<typeof ReferenceConfig>;

const PrefixInterval = { from: Timestamp, to: Timestamp.nullable() };

export const PrefixClaimEntry = z.object({
  prefix: z.string(),
  slug: ProjectSlug,
  ...PrefixInterval,
});
export type PrefixClaimEntry = z.infer<typeof PrefixClaimEntry>;

/** A window several projects held at once — no slug, so no holder is leaked. */
export const ContestedInterval = z.object({
  prefix: z.string(),
  ...PrefixInterval,
});
export type ContestedInterval = z.infer<typeof ContestedInterval>;

/** One project's hold on a slug (T-156); `to` null = still its current slug. */
export const SlugClaimEntry = z.object({
  slug: z.string(),
  canonical: ProjectSlug,
  ...PrefixInterval,
});
export type SlugClaimEntry = z.infer<typeof SlugClaimEntry>;

/**
 * What a client needs to resolve a bare `PREFIX-N` (T-150), trimmed to the
 * viewer's readable projects.
 */
export const ReferenceDirectory = z.object({
  entries: z.array(PrefixClaimEntry),
  contested: z.array(ContestedInterval),
  // Optional so a client talking to a pre-T-156 server degrades to "no
  // renames ever happened" instead of failing the whole directory.
  slug_entries: z.array(SlugClaimEntry).optional(),
});
export type ReferenceDirectory = z.infer<typeof ReferenceDirectory>;

/**
 * One `PREFIX-N` resolved the way the resolve pass resolves the same token
 * (T-288), for a client that cannot: the prefix directory it is given is
 * trimmed to what it may read, and a prefix belongs to whoever holds it
 * deployment-wide.
 */
export const ResolvedRef = z.object({
  /**
   * The address the ref spells, and the one to send requests to — so a
   * prefixed ref meets the same 301 on a read and the same 409 on a write
   * as the id form of the very same address would.
   *
   * The project is its id, never its slug: the holder may be a project the
   * caller cannot read, whose name is therefore not theirs to learn, while
   * the id is what stored links have carried in the clear since T-266.
   */
  names: z.object({ project_ref: z.string().regex(/^\d+$/), number: Id }),
  /** Where the card is now; readable to the caller by construction. */
  at: MovedTo,
});
export type ResolvedRef = z.infer<typeof ResolvedRef>;

export const RefFormatSetInput = z.strictObject({
  prefix: InternalRefPrefix,
});
export type RefFormatSetInput = z.infer<typeof RefFormatSetInput>;

export const AutolinkCreateInput = z.strictObject({
  prefix: AutolinkPrefix,
  url_template: AutolinkUrlTemplate,
});
export type AutolinkCreateInput = z.infer<typeof AutolinkCreateInput>;

/** Config carrying no customisation — old servers and fresh projects. */
export const DEFAULT_REFERENCE_CONFIG: ReferenceConfig = {
  format: { prefix: null, history: [] },
  autolinks: [],
};

/** The written form of an internal ref token: `#` or `T-`. */
export function refToken(prefix: string | null): string {
  return prefix === null ? "#" : `${prefix}-`;
}

/** Spell an issue number in a project's reference format. */
export function formatRef(prefix: string | null, number: number): string {
  return `${refToken(prefix)}${number}`;
}

/**
 * The internal format in force at `at`: the newest history entry with
 * effective_from <= at, `#` before the first entry. Content created in
 * the same instant as a switch reads the new format (>= comparison).
 */
export function refPrefixAt(
  history: RefFormatChange[],
  at: string,
): string | null {
  const time = Date.parse(at);
  let prefix: string | null = null;
  for (const change of history) {
    if (Date.parse(change.effective_from) <= time) prefix = change.prefix;
  }
  return prefix;
}
