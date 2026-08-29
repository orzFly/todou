import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCliDist } from "../src/cli-dist.ts";
import { ConfigError } from "../src/config.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";
import { testTmpDir } from "./setup.ts";

type Fixture = {
  name: string;
  os: string;
  arch: string;
  kind: string;
  runtime?: string;
  body: Buffer;
};

const FIXTURES: Fixture[] = [
  {
    name: "todou-linux-amd64",
    os: "linux",
    arch: "amd64",
    kind: "binary",
    // Long enough that a stray gzip/br layer would show up as shorter bytes.
    body: Buffer.from("\x7fELF fake linux executable payload\n".repeat(300)),
  },
  {
    name: "todou.cjs",
    os: "any",
    arch: "any",
    kind: "script",
    runtime: "node>=20.12",
    body: Buffer.from("#!/usr/bin/env node\nconsole.log('todou')\n"),
  },
];

const sha256 = (body: Buffer) =>
  createHash("sha256").update(body).digest("hex");

const compress = (body: Buffer) =>
  zstdCompressSync(body, {
    params: { [constants.ZSTD_c_compressionLevel]: 19 },
  });

/** Stands in for `scripts/pack-cli.sh` output. */
function packDist(options?: {
  version?: string;
  /** Skip writing this artifact's .zst, as a truncated build would. */
  omitFile?: string;
  /** Declare a compressed_size that disagrees with the file on disk. */
  wrongSizeFor?: string;
  /** Replace the manifest with this raw text instead of generating one. */
  rawManifest?: string;
}): string {
  const dir = testTmpDir("todou-cli-dist-");
  const artifacts = FIXTURES.map((fixture) => {
    const packed = compress(fixture.body);
    if (fixture.name !== options?.omitFile) {
      writeFileSync(join(dir, `${fixture.name}.zst`), packed);
    }
    return {
      name: fixture.name,
      os: fixture.os,
      arch: fixture.arch,
      kind: fixture.kind,
      ...(fixture.runtime ? { runtime: fixture.runtime } : {}),
      size: fixture.body.byteLength,
      compressed_size:
        fixture.name === options?.wrongSizeFor
          ? packed.byteLength + 1
          : packed.byteLength,
      sha256: sha256(fixture.body),
    };
  });
  writeFileSync(
    join(dir, "manifest.json"),
    options?.rawManifest ??
      JSON.stringify({
        version: options?.version ?? "v0.2.0-58-gabc1234",
        artifacts,
      }),
  );
  return dir;
}

const buffer = async (res: Response) => Buffer.from(await res.arrayBuffer());
const binary = FIXTURES[0] as Fixture;
const script = FIXTURES[1] as Fixture;

describe("cli distribution", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await makeTestApp("shared", {
      cliDistDir: packDist({ version: "v9.9.9-artifacts" }),
    });
  });
  afterAll(() => t.cleanup());

  describe("GET /api/cli", () => {
    it("lists every artifact with its digest and download URL", async () => {
      const res = await t.app.request("/api/cli");
      expect(res.status).toBe(200);
      // The artifacts' own build version, not the running server's.
      const body = (await res.json()) as {
        version: string;
        artifacts: Record<string, unknown>[];
      };
      expect(body.version).toBe("v9.9.9-artifacts");
      expect(body.artifacts).toHaveLength(2);
      expect(body.artifacts[0]).toEqual({
        name: "todou-linux-amd64",
        os: "linux",
        arch: "amd64",
        kind: "binary",
        size: binary.body.byteLength,
        sha256: sha256(binary.body),
        url: "/api/cli/todou-linux-amd64",
      });
      expect(body.artifacts[1]).toMatchObject({
        name: "todou.cjs",
        os: "any",
        arch: "any",
        kind: "script",
        runtime: "node>=20.12",
        url: "/api/cli/todou.cjs",
      });
    });

    // compressed_size is a packing detail; clients verify the decompressed
    // file, and the passthrough Content-Length comes from the server.
    it("keeps compressed_size off the wire", async () => {
      const res = await t.app.request("/api/cli");
      const body = await res.text();
      expect(body).not.toContain("compressed_size");
    });

    it("needs no authentication", async () => {
      const res = await t.app.request("/api/cli");
      expect(res.status).toBe(200);
    });
  });

  describe("GET /api/cli/{name}", () => {
    it("streams the decompressed artifact with a full header set", async () => {
      const res = await t.app.request("/api/cli/todou-linux-amd64");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-length")).toBe(
        String(binary.body.byteLength),
      );
      expect(res.headers.get("content-disposition")).toBe(
        'attachment; filename="todou-linux-amd64"',
      );
      expect(res.headers.get("etag")).toBe(`"${sha256(binary.body)}"`);
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(res.headers.get("vary")).toBe("Accept-Encoding");
      expect(res.headers.get("content-encoding")).toBeNull();
      expect((await buffer(res)).equals(binary.body)).toBe(true);
    });

    it("serves the stored bytes when the client accepts zstd", async () => {
      const res = await t.app.request("/api/cli/todou-linux-amd64", {
        headers: { "accept-encoding": "gzip, br, zstd" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-encoding")).toBe("zstd");
      expect(res.headers.get("etag")).toBe(`"${sha256(binary.body)}+zstd"`);
      const body = await buffer(res);
      expect(res.headers.get("content-length")).toBe(String(body.byteLength));
      expect(body.byteLength).toBeLessThan(binary.body.byteLength);
      // What lands on disk after the client decodes is the original file, so
      // the manifest's sha256 checks out either way.
      expect(zstdDecompressSync(body).equals(binary.body)).toBe(true);
    });

    it("decompresses for clients that do not accept zstd", async () => {
      for (const accept of ["gzip, br", "identity", "zstd;q=0"]) {
        const res = await t.app.request("/api/cli/todou-linux-amd64", {
          headers: { "accept-encoding": accept },
        });
        expect(res.headers.get("content-encoding")).toBeNull();
        expect((await buffer(res)).equals(binary.body)).toBe(true);
      }
    });

    it("304s a client that already holds the build", async () => {
      for (const [accept, etag] of [
        ["identity", `"${sha256(binary.body)}"`],
        ["zstd", `"${sha256(binary.body)}+zstd"`],
      ] as const) {
        const res = await t.app.request("/api/cli/todou-linux-amd64", {
          headers: { "accept-encoding": accept, "if-none-match": etag },
        });
        expect(res.status).toBe(304);
        expect(res.headers.get("etag")).toBe(etag);
        expect(res.headers.get("cache-control")).toBe("no-cache");
        expect((await buffer(res)).byteLength).toBe(0);
      }
    });

    it("honours a wildcard and a weak If-None-Match", async () => {
      for (const inm of ["*", `W/"${sha256(binary.body)}"`]) {
        const res = await t.app.request("/api/cli/todou-linux-amd64", {
          headers: { "if-none-match": inm },
        });
        expect(res.status).toBe(304);
      }
    });

    // The identity and zstd representations are different bytes, so one's
    // validator must never satisfy a conditional request for the other.
    it("sends the file when the held ETag is for the other variant", async () => {
      const res = await t.app.request("/api/cli/todou-linux-amd64", {
        headers: {
          "accept-encoding": "zstd",
          "if-none-match": `"${sha256(binary.body)}"`,
        },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-encoding")).toBe("zstd");
    });

    it("serves the script artifact too", async () => {
      const res = await t.app.request("/api/cli/todou.cjs");
      expect(res.status).toBe(200);
      expect((await buffer(res)).equals(script.body)).toBe(true);
    });

    it("404s anything outside the manifest", async () => {
      for (const name of [
        "nope",
        "manifest.json",
        "todou-linux-amd64.zst",
        "..%2f..%2fetc%2fpasswd",
        "%2e%2e%2fmanifest.json",
      ]) {
        const res = await t.app.request(`/api/cli/${name}`);
        expect(res.status).toBe(404);
        expect(res.headers.get("content-type")).toContain("application/json");
        expect(await res.json()).toMatchObject({
          error: { code: "not_found" },
        });
      }
    });
  });

  // The download is octet-stream with a declared length: the negotiated
  // compression middleware must leave both variants exactly as they are.
  it("is never re-encoded by the compression middleware", async () => {
    for (const path of ["/api/cli/todou-linux-amd64", "/api/cli/todou.cjs"]) {
      const res = await t.app.request(path, {
        headers: { "accept-encoding": "gzip, br" },
      });
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(res.headers.get("etag")).not.toContain("W/");
    }
    const passthrough = await t.app.request("/api/cli/todou-linux-amd64", {
      headers: { "accept-encoding": "gzip, br, zstd" },
    });
    expect(passthrough.headers.get("content-encoding")).toBe("zstd");
  });
});

describe("cli distribution: not configured", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await makeTestApp();
  });
  afterAll(() => t.cleanup());

  // The routes stay mounted so the OpenAPI document has one shape everywhere;
  // what changes is the answer.
  it("404s both endpoints with a distinguishable code", async () => {
    for (const path of ["/api/cli", "/api/cli/todou-linux-amd64"]) {
      const res = await t.app.request(path);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({
        error: { code: "cli_dist_not_configured" },
      });
    }
  });

  it("still documents the endpoints", async () => {
    const res = await t.app.request("/api/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    expect(doc.paths["/api/cli"]).toBeDefined();
    expect(doc.paths["/api/cli/{name}"]).toBeDefined();
  });
});

describe("loadCliDist", () => {
  it("loads a well-formed directory", async () => {
    const dist = await loadCliDist(packDist({ version: "v1.2.3" }));
    expect(dist.version).toBe("v1.2.3");
    expect(dist.byName.get("todou.cjs")?.runtime).toBe("node>=20.12");
  });

  it("refuses a manifest whose artifact file is missing", async () => {
    const dir = packDist({ omitFile: "todou.cjs" });
    await expect(loadCliDist(dir)).rejects.toBeInstanceOf(ConfigError);
    await expect(loadCliDist(dir)).rejects.toThrow(/todou\.cjs/);
  });

  it("refuses a size that disagrees with the file on disk", async () => {
    const dir = packDist({ wrongSizeFor: "todou-linux-amd64" });
    await expect(loadCliDist(dir)).rejects.toThrow(/bytes, but manifest\.json/);
  });

  it("refuses a missing, unparseable, or malformed manifest", async () => {
    await expect(
      loadCliDist(testTmpDir("todou-cli-empty-")),
    ).rejects.toBeInstanceOf(ConfigError);
    await expect(
      loadCliDist(packDist({ rawManifest: "{not json" })),
    ).rejects.toThrow(/not valid JSON/);
    await expect(
      loadCliDist(packDist({ rawManifest: '{"version": "v1"}' })),
    ).rejects.toThrow(/malformed/);
  });

  // The name is the only user-facing half of a file path in this feature.
  it("refuses a name that could escape the directory", async () => {
    await expect(
      loadCliDist(
        packDist({
          rawManifest: JSON.stringify({
            version: "v1",
            artifacts: [
              {
                name: "../escape",
                os: "linux",
                arch: "amd64",
                kind: "binary",
                size: 1,
                compressed_size: 1,
                sha256: "0".repeat(64),
              },
            ],
          }),
        }),
      ),
    ).rejects.toThrow(/malformed/);
  });
});
