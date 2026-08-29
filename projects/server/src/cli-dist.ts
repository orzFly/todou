import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { CliArtifact } from "@todou/shared";
import { z } from "zod";
import { ConfigError } from "./config.ts";

/**
 * The on-disk manifest, as scripts/pack-cli.sh writes it: the wire schema
 * minus `url` (the server derives it) plus the compressed size, which is the
 * Content-Length of a zstd passthrough response.
 *
 * `name` doubles as a file name, so it is constrained here rather than
 * anywhere the path is built — a manifest that got past this check can never
 * point outside its own directory.
 */
const StoredArtifact = CliArtifact.omit({ url: true }).extend({
  name: z.string().regex(/^[A-Za-z0-9._-]+$/),
  compressed_size: z.number().int().nonnegative(),
});
export type StoredArtifact = z.infer<typeof StoredArtifact>;

const StoredIndex = z.object({
  version: z.string(),
  artifacts: z.array(StoredArtifact),
});

export type CliDist = {
  version: string;
  /** Absolute; each artifact lives at `<dir>/<name>.zst`. */
  dir: string;
  artifacts: StoredArtifact[];
  byName: Map<string, StoredArtifact>;
};

const MANIFEST = "manifest.json";

/**
 * Read and verify a packed CLI distribution. Every failure is a ConfigError:
 * a deployment configured to serve artifacts it cannot find is misconfigured,
 * and saying so at startup beats 500s on a download months later — the same
 * reasoning as the S3 bucket check.
 */
export async function loadCliDist(dir: string): Promise<CliDist> {
  const manifestPath = join(dir, MANIFEST);
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (cause) {
    throw new ConfigError(
      `http.cli_dist_dir: cannot read ${manifestPath} (${String(cause)})`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError(
      `${manifestPath} is not valid JSON: ${String(cause)}`,
    );
  }
  const result = StoredIndex.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `${manifestPath} is malformed: ${z.prettifyError(result.error)}`,
    );
  }

  const { version, artifacts } = result.data;
  for (const artifact of artifacts) {
    const path = join(dir, `${artifact.name}.zst`);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      throw new ConfigError(
        `${manifestPath} lists "${artifact.name}" but ${path} is missing`,
      );
    }
    if (size !== artifact.compressed_size) {
      throw new ConfigError(
        `${path} is ${size} bytes, but ${MANIFEST} declares ` +
          `${artifact.compressed_size}`,
      );
    }
  }

  console.log(
    `cli distribution: ${artifacts.length} artifact(s) at version ${version} ` +
      `from ${dir}`,
  );
  return {
    version,
    dir,
    artifacts,
    byName: new Map(artifacts.map((a) => [a.name, a])),
  };
}
