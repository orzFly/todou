import { createReadStream } from "node:fs";
import { join } from "node:path";
import { pipeline, Readable } from "node:stream";
import { createZstdDecompress } from "node:zlib";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { CliDistIndex } from "@todou/shared";
import type { Context } from "hono";
import { parseAccept } from "hono/utils/accept";
import type { AppEnv } from "../auth/middleware.ts";
import type { CliDist } from "../cli-dist.ts";
import { CliDistNotConfiguredError, NotFoundError } from "../errors.ts";
import { contentDisposition } from "../http/content-disposition.ts";

/**
 * The decompressor's default 64 KiB chunk caps throughput around 90 MB/s;
 * 4 MiB gets the same frames out at ~220 MB/s, which is what turns a 94 MB
 * binary into ~0.45 s of CPU rather than ~1 s.
 */
const CHUNK_BYTES = 4 << 20;

const indexRoute = createRoute({
  method: "get",
  path: "/cli",
  summary:
    "List the CLI builds this deployment carries, with their sha256 " +
    "digests (public)",
  responses: {
    200: {
      description: "The artifacts and the version they were built from",
      content: { "application/json": { schema: CliDistIndex } },
    },
    404: { description: "This deployment carries no CLI artifacts" },
  },
});

const downloadRoute = createRoute({
  method: "get",
  path: "/cli/{name}",
  summary:
    "Download one CLI build, decompressed on the fly; ETag is its sha256 " +
    "(public)",
  request: { params: z.object({ name: z.string() }) },
  responses: {
    200: { description: "File stream" },
    304: { description: "The client already holds this exact build" },
    404: { description: "No such artifact" },
  },
});

function requireDist(c: Context<AppEnv>): CliDist {
  const dist = c.get("appCtx").cliDist;
  if (!dist) throw new CliDistNotConfiguredError();
  return dist;
}

/**
 * Explicit `zstd` only: a bare `*` also permits identity, and identity is the
 * representation every client can read.
 */
function acceptsZstd(header: string | undefined): boolean {
  if (header === undefined) return false;
  return parseAccept(header).some(
    (a) => a.type.toLowerCase() === "zstd" && a.q > 0,
  );
}

/**
 * If-None-Match uses the weak comparison function (RFC 9110 §13.1.2), so a
 * `W/` prefix on either side is ignored — only the opaque tag has to match.
 */
function matchesEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  if (header.trim() === "*") return true;
  return header
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//, ""))
    .includes(etag);
}

export function cliDistRoutes() {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(indexRoute, (c) => {
    const dist = requireDist(c);
    return c.json(
      {
        version: dist.version,
        artifacts: dist.artifacts.map(({ compressed_size, ...artifact }) => ({
          ...artifact,
          url: `/api/cli/${artifact.name}`,
        })),
      },
      200,
    );
  });

  app.openapi(downloadRoute, (c) => {
    const dist = requireDist(c);
    const { name } = c.req.valid("param");
    const artifact = dist.byName.get(name);
    if (!artifact) throw new NotFoundError(`no CLI artifact named "${name}"`);

    // A different content-coding is a different representation, so it needs
    // its own strong validator (RFC 9110 §8.8.3).
    const passthrough = acceptsZstd(c.req.header("Accept-Encoding"));
    const etag = passthrough
      ? `"${artifact.sha256}+zstd"`
      : `"${artifact.sha256}"`;
    c.header("ETag", etag);
    // The same URL serves different bytes after every deploy, so a cached
    // copy is only ever usable after revalidating it against that ETag.
    c.header("Cache-Control", "no-cache");
    c.header("Vary", "Accept-Encoding");
    if (matchesEtag(c.req.header("If-None-Match"), etag)) {
      return c.body(null, 304);
    }

    c.header("Content-Type", "application/octet-stream");
    c.header(
      "Content-Disposition",
      contentDisposition("attachment", artifact.name),
    );
    const source = createReadStream(join(dist.dir, `${artifact.name}.zst`));
    if (passthrough) {
      c.header("Content-Encoding", "zstd");
      c.header("Content-Length", String(artifact.compressed_size));
      return c.body(Readable.toWeb(source) as ReadableStream);
    }
    c.header("Content-Length", String(artifact.size));
    const decompressor = createZstdDecompress({ chunkSize: CHUNK_BYTES });
    // pipeline (not .pipe) so a read error tears the decompressor down
    // instead of leaving the response stream hanging.
    pipeline(source, decompressor, () => {});
    return c.body(Readable.toWeb(decompressor) as ReadableStream);
  });

  return app;
}
