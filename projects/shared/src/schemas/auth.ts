import { z } from "zod";

/**
 * Public discovery endpoint payload: how humans sign in to this deployment.
 * The web login page branches on it; PAT/Bearer auth is mode-independent.
 */
export const AuthMode = z.object({
  mode: z.enum(["single", "oidc", "forward"]),
});
export type AuthMode = z.infer<typeof AuthMode>;
