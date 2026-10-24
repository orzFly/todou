import { z } from "zod";

/**
 * Where releases are published. The one trust root `upgrade` has: CI builds
 * these from the tag (release.yaml), and every other source is judged by
 * whether its bytes match these.
 */
export const GITHUB_REPO = "https://github.com/orzFly/todou";

export type Artifact = { sha256: string; size?: number; url: string };

export type Offer = {
  version: string;
  artifacts: Map<string, Artifact>;
};

export type Probe = { ok: true; offer: Offer } | { ok: false; reason: string };

/** Answers in seconds or not at all; a download is not held to this. */
const PROBE_TIMEOUT_MS = 15_000;

function describeFailure(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return "timed out";
  }
  const cause = (error as { cause?: { code?: string; message?: string } })
    ?.cause;
  return cause?.code ?? cause?.message ?? String(error);
}

const SUMS_LINE = /^([0-9a-f]{64}) [ *]?(\S+)$/;

/**
 * The latest release, through the web redirect rather than the REST API: the
 * API allows 60 unauthenticated calls an hour per address, which a shared NAT
 * full of agents exhausts, while `/releases/latest` is an ordinary page.
 */
export async function probeGithub(
  fetchImpl: typeof fetch,
  repo: string = GITHUB_REPO,
): Promise<Probe> {
  let tag: string;
  try {
    const res = await fetchImpl(`${repo}/releases/latest`, {
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await res.body?.cancel();
    const location = res.headers.get("location") ?? "";
    const m = /\/releases\/tag\/([^/?#]+)$/.exec(location);
    if (!m) {
      return {
        ok: false,
        reason:
          res.status === 404
            ? "has no published release"
            : `answered ${res.status} without naming a release`,
      };
    }
    tag = decodeURIComponent(m[1] as string);
  } catch (error) {
    return { ok: false, reason: `unreachable (${describeFailure(error)})` };
  }

  const base = `${repo}/releases/download/${encodeURIComponent(tag)}`;
  let text: string;
  try {
    const res = await fetchImpl(`${base}/SHA256SUMS`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return {
        ok: false,
        reason: `release ${tag} has no SHA256SUMS (HTTP ${res.status})`,
      };
    }
    text = await res.text();
  } catch (error) {
    return { ok: false, reason: `unreachable (${describeFailure(error)})` };
  }

  const artifacts = new Map<string, Artifact>();
  for (const line of text.split("\n")) {
    const m = SUMS_LINE.exec(line.trim());
    if (!m) continue;
    const name = m[2] as string;
    artifacts.set(name, {
      sha256: m[1] as string,
      url: `${base}/${encodeURIComponent(name)}`,
    });
  }
  return { ok: true, offer: { version: tag, artifacts } };
}

/**
 * Deliberately looser than the shared CliDistIndex: `os`/`arch` are enums
 * there, and a server a release ahead adding a platform must not make its
 * whole manifest unreadable to this one. Only what a download needs is read.
 */
const ServerManifest = z.object({
  version: z.string(),
  artifacts: z.array(
    z.object({
      name: z.string(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      size: z.number().int().nonnegative(),
    }),
  ),
});

export async function probeServer(
  fetchImpl: typeof fetch,
  server: string,
): Promise<Probe> {
  let res: Response;
  try {
    res = await fetchImpl(`${server}/api/cli`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, reason: `unreachable (${describeFailure(error)})` };
  }
  if (!res.ok) {
    await res.body?.cancel();
    return {
      ok: false,
      reason:
        res.status === 404
          ? "does not serve /api/cli"
          : `answered /api/cli with HTTP ${res.status}`,
    };
  }
  let parsed: z.infer<typeof ServerManifest>;
  try {
    parsed = ServerManifest.parse(await res.json());
  } catch {
    return { ok: false, reason: "does not serve a CLI manifest at /api/cli" };
  }
  const artifacts = new Map<string, Artifact>();
  for (const a of parsed.artifacts) {
    // Built here rather than taken from the manifest's `url`: that one is
    // root-relative, and a deployment mounted under a path prefix (T-311's
    // `http://host/todou`) does not know its own prefix.
    artifacts.set(a.name, {
      sha256: a.sha256,
      size: a.size,
      url: `${server}/api/cli/${encodeURIComponent(a.name)}`,
    });
  }
  return { ok: true, offer: { version: parsed.version, artifacts } };
}
