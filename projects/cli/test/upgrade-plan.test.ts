import { describe, expect, it } from "vitest";
import { type PlanInput, planUpgrade } from "../src/upgrade/plan.ts";
import type { Probe } from "../src/upgrade/sources.ts";
import { compareVersions, isNewer } from "../src/upgrade/version-order.ts";

const ART = "todou-linux-amd64";
const SHA_G = "a".repeat(64);
const SHA_X = "b".repeat(64);
const SRV = "http://srv.test";

function gh(version: string, sha = SHA_G): Probe {
  return {
    ok: true,
    offer: {
      version,
      artifacts: new Map([
        [ART, { sha256: sha, url: `https://gh.test/${version}/${ART}` }],
      ]),
    },
  };
}

function srv(version: string, sha: string): { origin: string; probe: Probe } {
  return {
    origin: SRV,
    probe: {
      ok: true,
      offer: {
        version,
        artifacts: new Map([
          [ART, { sha256: sha, size: 3, url: `${SRV}/api/cli/${ART}` }],
        ]),
      },
    },
  };
}

const DOWN: Probe = { ok: false, reason: "unreachable (ECONNREFUSED)" };
const NO_CLI = {
  origin: SRV,
  probe: { ok: false, reason: "does not serve /api/cli" } as Probe,
};

function plan(over: Partial<PlanInput>) {
  return planUpgrade({
    current: "v0.6.0",
    artifact: ART,
    from: "auto",
    force: false,
    github: gh("v0.7.0"),
    server: null,
    ...over,
  });
}

/** Source, version and whether a prompt guards each step, in order. */
function steps(p: ReturnType<typeof planUpgrade>) {
  if (p.kind !== "install") return p.kind;
  return p.steps.map(
    (s) =>
      `${s.source} ${s.version} ${s.sha256 === SHA_G ? "G" : "X"}${s.trust === null ? "" : " ask"}`,
  );
}

describe("version order", () => {
  it("orders the release form before the everyday form past it", () => {
    expect(compareVersions("v0.6.5-12-g2cc59bb", "v0.6.5")).toBeGreaterThan(0);
    expect(compareVersions("v0.6.6", "v0.6.5-12-g2cc59bb")).toBeGreaterThan(0);
    expect(compareVersions("v0.10.0", "v0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("v0.6.5", "v0.6.5")).toBe(0);
  });

  it("refuses to order a dirty build, a bare sha, unknown and the nix form", () => {
    for (const v of [
      "v0.6.5-dirty",
      "v0.6.5-3-gabc-dirty",
      "2cc59bb",
      "unknown",
      "0.6.5-g2cc59bb",
    ]) {
      expect(compareVersions(v, "v0.6.5")).toBeNull();
    }
  });

  it("never calls an equal string newer, and lets any release replace an unorderable build", () => {
    expect(isNewer("v0.6.5", "v0.6.5")).toBe(false);
    expect(isNewer("v0.6.5", "2cc59bb")).toBe(true);
    expect(isNewer("2cc59bb", "v0.6.5")).toBe(false);
  });
});

describe("the T-570 decision table, --from auto", () => {
  it("row 1: an unusable server is skipped and GitHub installs", () => {
    for (const server of [null, NO_CLI, { origin: SRV, probe: DOWN }]) {
      expect(steps(plan({ server }))).toEqual(["github v0.7.0 G"]);
    }
  });

  it("row 1: a server with no build for this platform is skipped too", () => {
    const p = plan({
      server: {
        origin: SRV,
        probe: { ok: true, offer: { version: "v0.7.0", artifacts: new Map() } },
      },
    });
    expect(steps(p)).toEqual(["github v0.7.0 G"]);
    expect(p.kind === "install" && p.notes).toEqual([
      `${SRV} serves no ${ART} (at v0.7.0)`,
    ]);
  });

  it("row 2: same version and sha downloads from the server without asking, GitHub behind it", () => {
    const p = plan({ server: srv("v0.7.0", SHA_G) });
    expect(steps(p)).toEqual(["server v0.7.0 G", "github v0.7.0 G"]);
    expect(p.kind === "install" && p.steps[0]?.url).toBe(
      `${SRV}/api/cli/${ART}`,
    );
  });

  it("row 3: same version, different sha — the server's bytes are never a step", () => {
    const p = plan({ server: srv("v0.7.0", SHA_X) });
    expect(steps(p)).toEqual(["github v0.7.0 G"]);
    expect(p.kind === "install" && p.notes[0]).toMatch(
      /differs from the one GitHub published/,
    );
  });

  it("row 4: a server ahead of GitHub asks first, then falls back to GitHub", () => {
    const p = plan({ server: srv("v0.7.0-12-gabcdef0", SHA_X) });
    expect(steps(p)).toEqual([
      "server v0.7.0-12-gabcdef0 X ask",
      "github v0.7.0 G",
    ]);
    expect(p.kind === "install" && p.steps[0]?.trust).toBe(
      "v0.7.0-12-gabcdef0 is not GitHub's latest release (v0.7.0)",
    );
  });

  it("row 4: a decline never falls back to a downgrade", () => {
    const p = plan({
      current: "v0.7.0-3-g1111111",
      server: srv("v0.7.0-12-gabcdef0", SHA_X),
    });
    expect(steps(p)).toEqual(["server v0.7.0-12-gabcdef0 X ask"]);
    const forced = plan({
      current: "v0.7.0-3-g1111111",
      force: true,
      server: srv("v0.7.0-12-gabcdef0", SHA_X),
    });
    expect(steps(forced)).toEqual(["server v0.7.0-12-gabcdef0 X ask"]);
  });

  it("row 5: a server behind GitHub, or unorderable, is ignored", () => {
    expect(steps(plan({ server: srv("v0.6.9", SHA_X) }))).toEqual([
      "github v0.7.0 G",
    ]);
    const p = plan({ server: srv("v0.7.0-1-gabc-dirty", SHA_X) });
    expect(steps(p)).toEqual(["github v0.7.0 G"]);
    expect(p.kind === "install" && p.notes[0]).toMatch(/--from server/);
  });

  it("row 6: GitHub down, server up — the server is installable only after asking", () => {
    const p = plan({ github: DOWN, server: srv("v0.7.0", SHA_X) });
    expect(steps(p)).toEqual(["server v0.7.0 X ask"]);
    expect(p.kind === "install" && p.steps[0]?.trust).toBe(
      "GitHub unreachable (ECONNREFUSED)",
    );
  });

  it("row 6: an unorderable server version with GitHub down is not guessed at", () => {
    const p = plan({ github: DOWN, server: srv("deadbee", SHA_X) });
    expect(p.kind).toBe("unavailable");
  });

  it("row 7: both unusable — every reason is reported", () => {
    expect(plan({ github: DOWN, server: NO_CLI })).toEqual({
      kind: "unavailable",
      reasons: [
        "GitHub unreachable (ECONNREFUSED)",
        `${SRV} does not serve /api/cli`,
      ],
    });
  });

  it("row 8: nothing newer than the running build is up to date, unless --force", () => {
    expect(plan({ current: "v0.7.0" }).kind).toBe("current");
    expect(plan({ current: "v0.7.1" }).kind).toBe("current");
    expect(plan({ current: "v0.7.0", server: srv("v0.7.0", SHA_G) }).kind).toBe(
      "current",
    );
    expect(steps(plan({ current: "v0.7.1", force: true }))).toEqual([
      "github v0.7.0 G",
    ]);
  });

  it("GitHub without a build for this platform is a skip reason, not a crash", () => {
    const p = plan({
      github: { ok: true, offer: { version: "v0.7.0", artifacts: new Map() } },
    });
    expect(p).toEqual({
      kind: "unavailable",
      reasons: [`GitHub release v0.7.0 has no ${ART}`],
    });
  });
});

describe("--from github", () => {
  it("installs GitHub's release and nothing else", () => {
    expect(
      steps(plan({ from: "github", server: srv("v0.8.0", SHA_X) })),
    ).toEqual(["github v0.7.0 G"]);
    expect(plan({ from: "github", github: DOWN }).kind).toBe("unavailable");
  });
});

describe("--from server", () => {
  it("a GitHub-verified mirror installs without asking and without a GitHub fallback", () => {
    expect(
      steps(plan({ from: "server", server: srv("v0.7.0", SHA_G) })),
    ).toEqual(["server v0.7.0 G"]);
  });

  it("same version, different sha asks (T-570 q4) and says why", () => {
    const p = plan({ from: "server", server: srv("v0.7.0", SHA_X) });
    expect(steps(p)).toEqual(["server v0.7.0 X ask"]);
    expect(p.kind === "install" && p.steps[0]?.trust).toBe(
      `its ${ART} differs from the one GitHub published for v0.7.0 (GitHub: ${SHA_G})`,
    );
  });

  it("GitHub down or a version GitHub never published asks", () => {
    expect(
      steps(
        plan({ from: "server", github: DOWN, server: srv("v0.7.0", SHA_X) }),
      ),
    ).toEqual(["server v0.7.0 X ask"]);
    expect(
      steps(plan({ from: "server", server: srv("deadbee", SHA_X) })),
    ).toEqual(["server deadbee X ask"]);
  });

  it("no usable server is an error, never a quiet GitHub install", () => {
    expect(plan({ from: "server", server: null })).toEqual({
      kind: "unavailable",
      reasons: ["no server is configured"],
    });
    expect(plan({ from: "server", server: NO_CLI }).kind).toBe("unavailable");
  });

  it("the server's own version is up to date", () => {
    expect(
      plan({
        from: "server",
        current: "deadbee",
        server: srv("deadbee", SHA_X),
      }).kind,
    ).toBe("current");
  });
});
