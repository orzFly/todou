import { unlink } from "node:fs/promises";
import { resolveVersion } from "@todou/shared/version";
import { Command, Option } from "clipanion";
import type { CliContext } from "../api-command.ts";
import { loadCliConfig } from "../config.ts";
import { gitRemoteUrl, resolveContext } from "../context.ts";
import { discoverDirConfig } from "../dir-config.ts";
import { CliError, reportError } from "../errors.ts";
import { confirm } from "../prompt.ts";
import { buildNameTable, unknownServerError } from "../server-alias.ts";
import { currentInstall, type InstallForm } from "../upgrade/install-form.ts";
import {
  type From,
  type Plan,
  planUpgrade,
  type Step,
} from "../upgrade/plan.ts";
import {
  adoptMode,
  DownloadError,
  download,
  type Reserved,
  reserve,
  smokeVersion,
  swap,
  sweepAside,
  VerificationError,
} from "../upgrade/replace.ts";
import {
  GITHUB_REPO,
  type Probe,
  probeGithub,
  probeServer,
} from "../upgrade/sources.ts";

/** What `upgrade` reads about the running process; tests replace all of it. */
export type UpgradeSeam = {
  install?: InstallForm;
  currentVersion?: string;
  smoke?: (argv: string[]) => Promise<string>;
};

const FROM: readonly From[] = ["auto", "github", "server"];

export class UpgradeCommand extends Command<CliContext> {
  static paths = [["upgrade"]];
  static usage = Command.Usage({
    description: "Replace this todou with a newer build",
    details:
      "Looks at the latest GitHub release and at the server's `/api/cli`, " +
      "and installs whichever is newer. A server build installs without a " +
      "question only when GitHub published the same version with the same " +
      "sha256; anything GitHub cannot vouch for asks first, and without a " +
      "terminal is declined unless `--yes` is given. A download that does " +
      "not hash to the expected sha256 is never installed.\n\n" +
      "The new build replaces the running file in one rename, after it has " +
      "answered `--version` with the version it claims. Installs this " +
      "cannot replace — a nix store path, a source checkout, a directory " +
      "you cannot write — are refused before anything is downloaded.",
    examples: [
      ["Upgrade", "$0 upgrade"],
      ["See what an upgrade would do", "$0 upgrade --check"],
      ["Only take GitHub releases", "$0 upgrade --from github"],
      [
        "Take a named server's build, non-interactively",
        "$0 upgrade --from server --server work --yes",
      ],
    ],
  });

  from = Option.String("--from", "auto", {
    description: "Where to look: auto (default), github or server",
  });
  serverFlag = Option.String("--server", {
    description: "Server origin or name whose /api/cli to consult",
  });
  check = Option.Boolean("--check", false, {
    description: "Report what an upgrade would do; download nothing",
  });
  yes = Option.Boolean("-y,--yes", false, {
    description:
      "Install a server build GitHub cannot vouch for without asking",
  });
  force = Option.Boolean("--force", false, {
    description: "Reinstall the same version, or install an older one",
  });
  json = Option.Boolean("--json", false, {
    description: "Print the outcome as JSON",
  });

  private get seam(): UpgradeSeam {
    return this.context.upgrade ?? {};
  }

  /** The file the new build is written to; whatever holds it at exit is removed. */
  private reserved: Reserved | null = null;

  async execute(): Promise<number> {
    try {
      const from = this.from as From;
      if (!FROM.includes(from)) {
        throw new CliError(
          `--from takes auto, github or server, not "${this.from}"`,
        );
      }
      const install = this.seam.install ?? currentInstall();
      const current =
        this.seam.currentVersion ?? this.cli.binaryVersion ?? resolveVersion();

      if (!this.check) {
        if (install.kind === "refused") {
          throw new CliError(`cannot upgrade: ${install.reason}`, install.hint);
        }
        if (install.artifact === null) {
          throw new CliError(
            `no build of todou is published for ${install.platform}/${process.arch}`,
            "todou.cjs runs on any node>=20.12 — install that instead",
          );
        }
        // Before any network: a refusal costs nothing to report, and a
        // 100 MB download that cannot be installed is the worst way to learn it.
        await sweepAside(install.path);
        this.reserved = await reserve(install.path);
      }

      const origin = from === "github" ? undefined : this.serverOrigin(from);
      const fetchImpl = this.context.fetchImpl ?? fetch;
      const [github, server] = await Promise.all([
        probeGithub(fetchImpl, GITHUB_REPO),
        origin === undefined
          ? Promise.resolve(null)
          : probeServer(fetchImpl, origin),
      ]);

      if (install.kind === "refused" || install.artifact === null) {
        return this.report(current, install, github, origin, server, null);
      }
      const plan = planUpgrade({
        current,
        artifact: install.artifact,
        from,
        force: this.force,
        github,
        server:
          origin === undefined || server === null
            ? null
            : { origin, probe: server },
      });
      if (this.check) {
        return this.report(current, install, github, origin, server, plan);
      }

      if (plan.kind === "unavailable") {
        throw new CliError(
          "nothing to upgrade from:",
          plan.reasons.map((r) => `  ${r}`).join("\n"),
        );
      }
      for (const note of plan.notes) this.note(`note: ${note}`);
      if (plan.kind === "current") {
        this.done(
          { upgraded: false, version: current },
          `todou ${current} is up to date`,
        );
        return 0;
      }
      return await this.installSteps(plan.steps, install, current, origin);
    } catch (error) {
      return reportError(error, this.context.stderr);
    } finally {
      await this.release();
    }
  }

  private async installSteps(
    steps: Step[],
    install: Extract<InstallForm, { kind: "binary" | "script" }>,
    current: string,
    origin: string | undefined,
  ): Promise<number> {
    let declined: Step | null = null;
    let failure: CliError | null = null;
    let failureNoted = false;
    for (const [i, step] of steps.entries()) {
      const where = step.source === "github" ? "GitHub" : (origin as string);
      if (step.trust !== null && !(await this.trusts(step, where))) {
        declined = step;
        continue;
      }
      if (i > 0 && failure !== null) {
        this.note(`trying ${where} instead`);
      }
      // A failed attempt's bytes go with its file; every attempt starts clean.
      this.reserved ??= await reserve(install.path);
      const reserved = this.reserved;
      this.note(`downloading todou ${step.version} from ${step.url}`);
      try {
        await download(this.context.fetchImpl ?? fetch, step, reserved.handle);
        await reserved.handle.close();
        await adoptMode(reserved.path, install.path, install.platform);
        const argv =
          install.kind === "script"
            ? [...install.runner, reserved.path, "--version"]
            : [reserved.path, "--version"];
        const said = await (this.seam.smoke ?? smokeVersion)(argv).catch(
          (error: unknown) => {
            throw new VerificationError(
              `the downloaded build does not start: ${String(error)}`,
            );
          },
        );
        if (said !== step.version) {
          throw new VerificationError(
            `the downloaded build reports ${said || "nothing"}, expected ${step.version} — not installed`,
          );
        }
        await swap(reserved.path, install.path, install.platform);
      } catch (error) {
        if (
          !(
            error instanceof DownloadError || error instanceof VerificationError
          )
        ) {
          throw error;
        }
        failure = error;
        await this.release();
        // The last failure is the command's own error; earlier ones are notes.
        if (i < steps.length - 1) {
          this.note(`error: ${error.message}`);
          failureNoted = true;
        } else {
          failureNoted = false;
        }
        continue;
      }
      const record = {
        upgraded: true,
        from: current,
        version: step.version,
        source: step.source === "github" ? "github" : origin,
        sha256: step.sha256,
        path: install.path,
      };
      this.done(
        record,
        `upgraded todou ${current} → ${step.version} (${install.path})`,
      );
      return 0;
    }
    if (failure !== null) {
      throw failureNoted
        ? new CliError(
            `nothing was installed: ${declined === null ? "every source failed" : `${origin} was not trusted`}`,
          )
        : failure;
    }
    throw new CliError(
      `not installing ${declined?.version}: ${origin} was not trusted`,
      "rerun with --yes to trust it, or --from github for GitHub's release",
    );
  }

  private async release(): Promise<void> {
    const reserved = this.reserved;
    this.reserved = null;
    if (reserved === null) return;
    await reserved.handle.close().catch(() => {});
    // After a successful swap the name is already gone; nothing to remove.
    await unlink(reserved.path).catch(() => {});
  }

  /** The prompt is the whole of the trust decision: nothing is remembered. */
  private async trusts(step: Step, where: string): Promise<boolean> {
    const lines = [
      `${where} offers todou ${step.version}, which GitHub cannot vouch for:`,
      `  ${step.trust}`,
      `  sha256 ${step.sha256}`,
    ];
    if (this.yes) {
      for (const line of lines) this.note(line);
      this.note("installing it anyway: --yes");
      return true;
    }
    if (!(this.context.stdin as { isTTY?: boolean }).isTTY) {
      for (const line of lines) this.note(line);
      this.note("declined: no terminal to ask on (--yes accepts it)");
      return false;
    }
    for (const line of lines) this.note(line);
    return confirm(
      this.context.stdin,
      this.context.stderr,
      `Install it from ${where}?`,
    );
  }

  private serverOrigin(from: From): string | undefined {
    const env = this.context.env;
    const config = loadCliConfig(env);
    const ctx = resolveContext({
      flags: { server: this.serverFlag },
      env,
      config,
      remoteUrl: gitRemoteUrl(this.context.cwd),
      dirConfig: discoverDirConfig(this.context.cwd, env),
    });
    if (ctx.serverUnknownName) {
      // Only fatal when the server is the point; otherwise GitHub still answers.
      if (from === "server" || this.serverFlag !== undefined) {
        throw unknownServerError(ctx.server as string, buildNameTable(config));
      }
      this.note(`note: server "${ctx.server}" is not configured — skipped`);
      return undefined;
    }
    return ctx.server;
  }

  private report(
    current: string,
    install: InstallForm,
    github: Probe,
    origin: string | undefined,
    server: Probe | null,
    plan: Plan | null,
  ): number {
    const side = (probe: Probe | null) =>
      probe === null
        ? { version: null, reason: "not consulted" }
        : probe.ok
          ? { version: probe.offer.version }
          : { version: null, reason: probe.reason };
    const outcome =
      install.kind === "refused"
        ? `cannot upgrade: ${install.reason} (${install.hint})`
        : install.artifact === null
          ? `no build of todou is published for ${install.platform}/${process.arch}`
          : plan === null || plan.kind === "unavailable"
            ? "nothing to upgrade from"
            : plan.kind === "current"
              ? "up to date"
              : plan.steps
                  .map((s, i) => {
                    const where = s.source === "github" ? "GitHub" : origin;
                    const verb = i === 0 ? "would install" : "otherwise";
                    return s.trust === null
                      ? `${verb} ${s.version} from ${where}`
                      : `${verb} ${s.version} from ${where} after asking (${s.trust})`;
                  })
                  .join("; ");
    const record = {
      current,
      install:
        install.kind === "refused"
          ? { kind: "refused", reason: install.reason }
          : {
              kind: install.kind,
              path: install.path,
              artifact: install.artifact,
            },
      github: side(github),
      server: origin === undefined ? null : { origin, ...side(server) },
      plan,
      outcome,
    };
    const show = (s: { version: string | null; reason?: string }) =>
      s.version ?? `- (${s.reason})`;
    this.done(record, () =>
      [
        `current  ${current}${install.kind === "refused" ? "" : `  ${install.path}`}`,
        `github   ${show(record.github)}`,
        ...(record.server === null
          ? []
          : [`server   ${show(record.server)}  ${record.server.origin}`]),
        ...(plan !== null && plan.kind !== "unavailable"
          ? plan.notes.map((n) => `note     ${n}`)
          : []),
        ...(plan?.kind === "unavailable"
          ? plan.reasons.map((r) => `skipped  ${r}`)
          : []),
        `→ ${outcome}`,
      ].join("\n"),
    );
    return 0;
  }

  private done(record: unknown, human: string | (() => string)): void {
    const text = this.json
      ? JSON.stringify(record, null, 2)
      : typeof human === "string"
        ? human
        : human();
    this.context.stdout.write(`${text}\n`);
  }

  private note(line: string): void {
    this.context.stderr.write(`${line}\n`);
  }
}
