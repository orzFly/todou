import { z } from "zod";
import { Id, Timestamp } from "./common.ts";
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

/**
 * What a client needs to resolve a bare `PREFIX-N` (T-150), trimmed to the
 * viewer's readable projects. `since` null means the deployment has no
 * cutoff recorded, which reads as "cross-project grammar off".
 */
export const ReferenceDirectory = z.object({
  since: Timestamp.nullable(),
  entries: z.array(PrefixClaimEntry),
  contested: z.array(ContestedInterval),
});
export type ReferenceDirectory = z.infer<typeof ReferenceDirectory>;

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
