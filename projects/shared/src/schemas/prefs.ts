import { z } from "zod";

/**
 * Per-user preferences (T-97), stored server-side so every browser and
 * machine sees the same values — the weak-unread toggle must agree with
 * the server-side inbox filtering, which reads the same row. Strict so
 * unknown keys are rejected instead of silently dropped; defaults keep
 * clients parseable against servers that predate a key.
 */
export const MePrefs = z.strictObject({
  /**
   * Show the hollow-ring marker (and inbox rows) for issues whose only
   * news is events — no new comments (T-77's weak-unread state).
   */
  show_weak_unread: z.boolean().default(true),
});
export type MePrefs = z.infer<typeof MePrefs>;

/**
 * Body of PATCH /me/prefs — a shallow partial merge. Built without the
 * defaults on purpose: a defaulted key would materialize in every parsed
 * patch and overwrite the stored value ("{}" must merge as a no-op).
 */
export const MePrefsPatch = z.strictObject({
  show_weak_unread: z.boolean().optional(),
});
export type MePrefsPatch = z.infer<typeof MePrefsPatch>;
