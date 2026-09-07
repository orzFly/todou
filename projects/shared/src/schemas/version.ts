import { z } from "zod";

/**
 * Public discovery endpoint payload: the running server's version string.
 * The web footer compares it, by strict equality, with its own build-time
 * version to surface half-finished deploys.
 */
export const VersionInfo = z.object({
  version: z.string(),
  /**
   * The deployment's public address, as a bare origin (T-280). Omitted when
   * the deployment has not configured one, and a client that needs a link a
   * person will open then falls back to its own API base — which may be an
   * internal forwarding address no browser outside the datacenter can reach.
   */
  public_origin: z.string().optional(),
});
export type VersionInfo = z.infer<typeof VersionInfo>;
