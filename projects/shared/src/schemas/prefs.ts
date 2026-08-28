import { z } from "zod";

/** Where a surface puts the ref relative to the title (T-157). */
export const RefPlacement = z.enum(["before", "after"]);
export type RefPlacement = z.infer<typeof RefPlacement>;

/**
 * Board cards carry a third form: the ref on a line of its own, under the
 * title and above the meta row.
 */
export const BoardRefPlacement = z.enum(["before", "after", "own_line"]);
export type BoardRefPlacement = z.infer<typeof BoardRefPlacement>;

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
  /*
   * Ref placement, one key per rendering surface (T-157). Display-only: no
   * server code reads these, unlike `show_weak_unread` above. They live here
   * anyway so the choice follows the user between browsers.
   *
   * Flat rather than a `{surface: placement}` map because the server merges
   * patches with jsonb `||`, which is shallow: a nested object would be
   * replaced wholesale, so two tabs changing two different surfaces would
   * lose the earlier write.
   *
   * A stored value outside these enums cannot reach a parse — the server's
   * `toPrefs` drops it first, so the default below covers it.
   */
  ref_placement_list: RefPlacement.default("before"),
  ref_placement_board: BoardRefPlacement.default("own_line"),
  ref_placement_detail: RefPlacement.default("before"),
  ref_placement_reference: RefPlacement.default("before"),
});
export type MePrefs = z.infer<typeof MePrefs>;

/**
 * Body of PATCH /me/prefs — a shallow partial merge. Built without the
 * defaults on purpose: a defaulted key would materialize in every parsed
 * patch and overwrite the stored value ("{}" must merge as a no-op).
 */
export const MePrefsPatch = z.strictObject({
  show_weak_unread: z.boolean().optional(),
  ref_placement_list: RefPlacement.optional(),
  ref_placement_board: BoardRefPlacement.optional(),
  ref_placement_detail: RefPlacement.optional(),
  ref_placement_reference: RefPlacement.optional(),
});
export type MePrefsPatch = z.infer<typeof MePrefsPatch>;
