import { z } from "zod";

/**
 * Public discovery endpoint payload: the running server's version string.
 * The web footer compares it, by strict equality, with its own build-time
 * version to surface half-finished deploys.
 */
export const VersionInfo = z.object({
  version: z.string(),
});
export type VersionInfo = z.infer<typeof VersionInfo>;
