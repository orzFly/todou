import type { Artifact, Probe } from "./sources.ts";
import { compareVersions, isNewer } from "./version-order.ts";

export type From = "auto" | "github" | "server";

/** One way to install: tried in order, the next one only when this one is declined or fails. */
export type Step = {
  source: "github" | "server";
  version: string;
  /** What the downloaded bytes must hash to; anything else is discarded. */
  sha256: string;
  size?: number;
  url: string;
  /**
   * Null when GitHub vouches for the bytes. Otherwise why it cannot, which
   * the user has to accept before this step downloads anything.
   */
  trust: string | null;
};

export type Plan =
  | { kind: "current"; notes: string[] }
  | { kind: "install"; steps: Step[]; notes: string[] }
  | { kind: "unavailable"; reasons: string[] };

export type PlanInput = {
  current: string;
  artifact: string;
  from: From;
  force: boolean;
  /** null when not consulted (`--from server` still consults it). */
  github: Probe | null;
  /** null when not consulted or no server is configured. */
  server: { origin: string; probe: Probe } | null;
};

type Found = { version: string; artifact: Artifact };

/**
 * The decision table posted on T-570, as a pure function so every row is a
 * unit test. GitHub's SHA256SUMS is the only thing that vouches for bytes; a
 * server is either a mirror of exactly those bytes or something the user has
 * to choose to trust.
 */
export function planUpgrade(input: PlanInput): Plan {
  const { current, artifact, from, force } = input;
  const skipped: string[] = [];

  let g: Found | null = null;
  if (input.github !== null) {
    if (!input.github.ok) skipped.push(`GitHub ${input.github.reason}`);
    else {
      const found = input.github.offer.artifacts.get(artifact);
      if (found) g = { version: input.github.offer.version, artifact: found };
      else {
        skipped.push(
          `GitHub release ${input.github.offer.version} has no ${artifact}`,
        );
      }
    }
  }

  let s: Found | null = null;
  const origin = input.server?.origin;
  if (input.server === null) {
    if (from === "server") skipped.push("no server is configured");
  } else if (!input.server.probe.ok) {
    skipped.push(`${origin} ${input.server.probe.reason}`);
  } else {
    const found = input.server.probe.offer.artifacts.get(artifact);
    if (found)
      s = { version: input.server.probe.offer.version, artifact: found };
    else {
      skipped.push(
        `${origin} serves no ${artifact} (at ${input.server.probe.offer.version})`,
      );
    }
  }

  const ahead = (v: string) => force || isNewer(v, current);
  const github = (found: Found): Step => ({
    source: "github",
    version: found.version,
    sha256: found.artifact.sha256,
    url: found.artifact.url,
    trust: null,
  });
  const server = (found: Found, trust: string | null): Step => ({
    source: "server",
    version: found.version,
    sha256: found.artifact.sha256,
    ...(found.artifact.size === undefined ? {} : { size: found.artifact.size }),
    url: found.artifact.url,
    trust,
  });
  const install = (steps: Step[], notes: string[] = []): Plan =>
    steps.length === 0
      ? { kind: "current", notes: [...skipped, ...notes] }
      : { kind: "install", steps, notes: [...skipped, ...notes] };
  const mirrors = (a: Found, b: Found) =>
    a.version === b.version && a.artifact.sha256 === b.artifact.sha256;

  if (from === "github") {
    if (g === null) return { kind: "unavailable", reasons: skipped };
    return install(ahead(g.version) ? [github(g)] : []);
  }

  if (from === "server") {
    if (s === null) return { kind: "unavailable", reasons: skipped };
    // Explicitly asked for, so an unorderable version is installable here —
    // only an identical one is "already installed".
    const wanted =
      force ||
      (s.version !== current && (compareVersions(s.version, current) ?? 1) > 0);
    if (!wanted) return install([]);
    if (g !== null && mirrors(s, g)) return install([server(s, null)]);
    return install([server(s, distrust(s, g, input.github, artifact))]);
  }

  if (g !== null && s !== null) {
    if (s.version === g.version) {
      if (!ahead(g.version)) return install([]);
      if (mirrors(s, g)) return install([server(s, null), github(g)]);
      return install(
        [github(g)],
        [
          `${origin}'s ${artifact} for ${s.version} differs from the one ` +
            "GitHub published — installing GitHub's",
        ],
      );
    }
    const order = compareVersions(s.version, g.version);
    if (order !== null && order > 0) {
      const steps: Step[] = [];
      if (ahead(s.version)) {
        steps.push(server(s, distrust(s, g, input.github, artifact)));
      }
      // The fallback after a declined prompt only ever moves forward: --force
      // asked for the server's build, not for a downgrade to GitHub's.
      if (isNewer(g.version, current)) steps.push(github(g));
      return install(steps);
    }
    const notes =
      order === null
        ? [
            `${origin} offers ${s.version}, which cannot be ordered against ` +
              "releases — install it with --from server",
          ]
        : [];
    return install(ahead(g.version) ? [github(g)] : [], notes);
  }

  if (g !== null) return install(ahead(g.version) ? [github(g)] : []);

  if (s !== null) {
    if (compareVersions(s.version, current) === null && s.version !== current) {
      return {
        kind: "unavailable",
        reasons: [
          ...skipped,
          `${origin} offers ${s.version}, which cannot be ordered against ` +
            `${current} — install it with --from server`,
        ],
      };
    }
    return install(
      ahead(s.version)
        ? [server(s, distrust(s, g, input.github, artifact))]
        : [],
    );
  }

  return { kind: "unavailable", reasons: skipped };
}

/** Why GitHub cannot vouch for a server's build, in the words the prompt shows. */
function distrust(
  s: Found,
  g: Found | null,
  github: Probe | null,
  artifact: string,
): string {
  if (g !== null && g.version === s.version) {
    return (
      `its ${artifact} differs from the one GitHub published for ` +
      `${g.version} (GitHub: ${g.artifact.sha256})`
    );
  }
  if (g !== null) {
    return `${s.version} is not GitHub's latest release (${g.version})`;
  }
  if (github === null) return "GitHub was not consulted";
  return github.ok
    ? `GitHub's release ${github.offer.version} has no ${artifact}`
    : `GitHub ${github.reason}`;
}
