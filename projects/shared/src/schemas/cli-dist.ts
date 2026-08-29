import { z } from "zod";

/**
 * One downloadable CLI build. `sha256` and `size` describe the *decompressed*
 * file — what a client gets on disk, whichever transfer encoding it took —
 * so `sha256sum` against the manifest works either way.
 */
export const CliArtifact = z.object({
  /** Also the last path segment of `url`. */
  name: z.string(),
  os: z.enum(["linux", "darwin", "windows", "any"]),
  arch: z.enum(["amd64", "arm64", "any"]),
  kind: z.enum(["binary", "script"]),
  /** Scripts only: what the client must already have, e.g. "node>=20.12". */
  runtime: z.string().optional(),
  size: z.number().int(),
  sha256: z.string(),
  url: z.string(),
});
export type CliArtifact = z.infer<typeof CliArtifact>;

/**
 * Public discovery payload for the CLI builds a deployment carries. `version`
 * is the artifacts' own build version, which in a checkout deployment may lag
 * the running server's — clients compare it against their `todou --version`.
 */
export const CliDistIndex = z.object({
  version: z.string(),
  artifacts: z.array(CliArtifact),
});
export type CliDistIndex = z.infer<typeof CliDistIndex>;
