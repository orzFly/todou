import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { harnessRoute } from "../src/agent-doctor.ts";
import { saveCliConfig } from "../src/config.ts";
import { procTree, scratchDir } from "./harness/proc-fixture.ts";
import { runCli } from "./harness.ts";

const SERVER = "https://todou.example";

/**
 * Every credential the report can reach, each by a different road: the
 * environment, the user config, the record the omp extension published, an
 * ancestor's command line, and a token this process was never told about.
 */
const SECRETS = {
  envToken: "todou_pat_EnvTokenAaBbCcDdEe",
  messagingToken: "FAKE_MSG_FfGgHhIiJjKkLlMm",
  recordToken: "FAKE_REC_NnOoPpQqRrSsTtUu",
  storedDefault: "FAKE_DEF_VvWwXxYyZz0011223",
  storedProfile: "FAKE_ALT_3445566778899aAbB",
  ancestorOnly: "todou_pat_NeverSeenByThisProcess",
};

/**
 * T-564's first failure as the doctor would meet it: a named bash service
 * under omp's daemon broker, whose environment carries neither omp's marker
 * nor Claude Code's, with an older extension installed and a PATH that finds
 * two `todou`s.
 */
function ompService() {
  const root = scratchDir("todou-doctor-");
  const home = join(root, "home");
  const runtime = join(root, "run");
  const stateDir = join(runtime, "todou-omp");
  mkdirSync(stateDir, { recursive: true });
  // The publisher has to be alive, and this process is the one pid a test
  // can promise is.
  const ompPid = process.pid;
  const record = join(stateDir, `${ompPid}.json`);
  const socket = join(stateDir, `${ompPid}.sock`);
  writeFileSync(
    record,
    JSON.stringify({
      v: 1,
      pid: ompPid,
      agent: "omp",
      session_id: "omp-session-1",
      socket,
      token: SECRETS.recordToken,
      tools: ["todou_watch"],
    }),
  );

  const extensions = join(home, ".omp", "agent", "extensions");
  mkdirSync(extensions, { recursive: true });
  writeFileSync(
    join(extensions, "todou-omp-session.ts"),
    "// TODOU_INTEGRATION_ID=omp\n// TODOU_INTEGRATION_VERSION=1\n",
  );

  const bins = [join(root, "system-bin"), join(home, ".local", "bin")];
  for (const dir of bins) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "todou"), "#!/bin/sh\n");
    chmodSync(join(dir, "todou"), 0o755);
  }

  const xdg = join(root, "xdg");
  saveCliConfig(
    {
      default_server: SERVER,
      servers: {
        [SERVER]: {
          token: SECRETS.storedDefault,
          tokens: { alt: SECRETS.storedProfile },
          instead_of: [],
        },
      },
      bindings: [],
    },
    { XDG_CONFIG_HOME: xdg },
  );

  const env: Record<string, string> = {
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    XDG_RUNTIME_DIR: runtime,
    PATH: bins.join(":"),
    OMPCODE: "1",
    CLAUDECODE: "1",
    TODOU_OMP_STATE: record,
    TODOU_MESSAGING_SOCKET: socket,
    TODOU_MESSAGING_TOKEN: SECRETS.messagingToken,
    TODOU_TOKEN: SECRETS.envToken,
  };
  const zshLead = `echo ${SECRETS.recordToken} ${SECRETS.storedDefault} ${SECRETS.storedProfile} `;
  const zshHead = `${zshLead}${"p".repeat(98 - "zsh -c ".length - zshLead.length - 1)} `;
  const processTree = procTree([
    {
      pid: 4711,
      ppid: 4700,
      env,
      argv: [
        "sh",
        "-c",
        `TODOU_TOKEN=${SECRETS.envToken} todou watch --token ${SECRETS.ancestorOnly}`,
      ],
    },
    {
      pid: 4700,
      ppid: ompPid,
      env: { HOME: home },
      argv: ["omp", "__omp_worker_daemon_broker"],
    },
    { pid: ompPid, ppid: 4000, env: { HOME: home }, argv: ["omp"] },
    {
      pid: 4000,
      ppid: 1,
      env: { HOME: home },
      // One credential from each place the doctor collects them, the last
      // one starting at column 98 of a line the report keeps 119 characters
      // of — so cutting it before masking would print twelve of its own.
      argv: ["zsh", "-c", `${zshHead}${SECRETS.messagingToken}`],
    },
  ]);
  return { env, home, processTree, record, socket, bins, ompPid };
}

async function doctor(options: Parameters<typeof runCli>[1]) {
  const result = await runCli(["agent", "doctor"], options);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  return result.stdout;
}

describe("agent doctor", () => {
  it("shows every input T-564's four failures turned on", async () => {
    const fx = ompService();
    const out = await doctor({
      env: fx.env,
      home: fx.home,
      processTree: fx.processTree,
    });

    // Which harness, and why: the broker skipped rather than read as the
    // boundary that made this service look like Claude Code.
    expect(out).toMatch(
      /^harness +omp — tied for nearest host in the process tree, registry order decides \(omp depth 2, claude-code depth 2\)$/m,
    );
    expect(out).toMatch(/^candidates +omp, claude-code /m);
    expect(out).toMatch(
      /^ {2}0 +4711 +sh -c .* · OMPCODE CLAUDECODE TODOU_OMP_STATE TODOU_MESSAGING_SOCKET$/m,
    );
    expect(out).toMatch(
      /^ {2}1 +4700 +omp __omp_worker_daemon_broker {2}· omp worker — skipped$/m,
    );
    expect(out).toMatch(
      new RegExp(
        `^ {2}2 +${fx.ompPid} +omp {2}· omp host published ${fx.ompPid}\\.json$`,
        "m",
      ),
    );

    // The variables that matter, secrets by presence only.
    expect(out).toContain("  OMPCODE=1\n");
    expect(out).toContain(`  TODOU_OMP_STATE=${fx.record}\n`);
    expect(out).toContain("  TODOU_TOKEN=<redacted>\n");
    expect(out).toContain("  TODOU_MESSAGING_TOKEN=<redacted>\n");
    expect(out).toMatch(/^ {2}unset: .*\bTODOU_PROFILE\b/m);

    // Which todou: the service's PATH and everything on it.
    expect(out).toMatch(/^running +\S/m);
    expect(out).toContain(`on PATH      ${fx.bins[0]}/todou  ← first\n`);
    expect(out).toContain("             ~/.local/bin/todou\n");
    expect(out).toContain(`PATH         ${fx.bins[0]}:~/.local/bin\n`);

    // Which account a bare command would use.
    expect(out).toMatch(
      /^account +https:\/\/todou\.example \(default_server\) · token: TODOU_TOKEN \(env\)$/m,
    );
    expect(out).toContain(
      "stored for this server: default token · profiles alt\n",
    );

    // The push channel, the record behind it, and the extension's version.
    expect(out).toContain(
      `push         omp · socket ${fx.socket} (missing) · token present · tools todou_watch\n`,
    );
    expect(out).toMatch(
      new RegExp(
        `^record +.*${fx.ompPid}\\.json read · pid ${fx.ompPid} `,
        "m",
      ),
    );
    expect(out).toMatch(
      new RegExp(`^published +.*todou-omp: ${fx.ompPid} \\(alive\\)$`, "m"),
    );
    expect(out).toContain(
      "  omp: installed v1, current is v6 — reinstall · ~/.omp/agent/extensions/todou-omp-session.ts\n",
    );
    expect(out).toMatch(/^ {2}pi: not installed · /m);

    // And what was chosen.
    expect(out).toMatch(
      /^config +.*\/todou\/config\.toml · follow_uds advised$/m,
    );
    expect(out).toMatch(/^advice +omp-tool$/m);
  });

  it("never prints a token, from any source", async () => {
    const fx = ompService();
    const out = await doctor({
      env: fx.env,
      home: fx.home,
      processTree: fx.processTree,
    });
    // Any eight characters past the shared prefix, so a token cut in half
    // by the argv limit counts as the leak it is.
    for (const [what, secret] of Object.entries(SECRETS)) {
      const body = secret.replace(/^(todou_pat_|FAKE_[A-Z]+_)/, "");
      for (let i = 0; i + 8 <= body.length; i++) {
        expect(out, what).not.toContain(body.slice(i, i + 8));
      }
    }
    // The command lines were printed, with every token masked.
    expect(out).toContain(
      "TODOU_TOKEN=<redacted> todou watch --token todou_pat_<redacted>",
    );
    expect(out).toMatch(
      /zsh -c echo <redacted> <redacted> <redacted> p+ <redacted>/,
    );
    expect(out).not.toContain(fx.home);
  });

  it("names the record when no marker reached this process", async () => {
    const fx = ompService();
    const out = await doctor({
      env: {
        HOME: fx.env.HOME as string,
        XDG_CONFIG_HOME: fx.env.XDG_CONFIG_HOME as string,
        XDG_RUNTIME_DIR: fx.env.XDG_RUNTIME_DIR as string,
      },
      home: fx.home,
      processTree: fx.processTree,
    });
    expect(out).toMatch(
      new RegExp(
        `^harness +omp — named by the record pid ${fx.ompPid} published at .*/todou-omp/${fx.ompPid}\\.json$`,
        "m",
      ),
    );
    expect(out).toMatch(/^candidates +none /m);
  });

  it("still prints a route this report has no wording for", () => {
    const trace = {
      candidates: ["omp" as const],
      // A route `select` might grow before this report is taught it.
      route: "future-rule" as never,
      depths: { omp: 3 },
    };
    expect(harnessRoute("omp", trace)).toBe(
      "omp — route future-rule (omp depth 3)",
    );
    expect(harnessRoute(null, { ...trace, candidates: [] })).toBe(
      "none — route future-rule (no candidates)",
    );
  });

  it("says plainly when there is nothing to find", async () => {
    const out = await doctor({ env: { PATH: "" } });
    expect(out).toMatch(
      /^harness +none — no harness marker in this environment/m,
    );
    expect(out).toMatch(/^candidates +none /m);
    expect(out).toContain("process tree unavailable");
    expect(out).toContain("on PATH      no todou on PATH\n");
    expect(out).toMatch(/^account +no server resolved · token: none$/m);
    expect(out).toMatch(/^push +none found$/m);
    expect(out).toMatch(/^ {2}omp: not installed /m);
    expect(out).toMatch(/^advice +no-harness$/m);
  });
});
