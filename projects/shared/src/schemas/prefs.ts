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
   *
   * A card someone else just opened is *not* one of those, despite `opened`
   * being an event: its top post counts as the first unread comment
   * (T-151), so turning this off never hides a new card.
   */
  show_weak_unread: z.boolean().default(true),
  /**
   * Put the ref before the title wherever the web UI renders both.
   *
   * Display-only: no server code reads it, unlike `show_weak_unread` above.
   * It lives here anyway so the choice follows the user between browsers.
   */
  ref_before_title: z.boolean().default(true),
});
export type MePrefs = z.infer<typeof MePrefs>;

/**
 * Body of PATCH /me/prefs — a shallow partial merge. Built without the
 * defaults on purpose: a defaulted key would materialize in every parsed
 * patch and overwrite the stored value ("{}" must merge as a no-op).
 */
export const MePrefsPatch = z.strictObject({
  show_weak_unread: z.boolean().optional(),
  ref_before_title: z.boolean().optional(),
});
export type MePrefsPatch = z.infer<typeof MePrefsPatch>;
