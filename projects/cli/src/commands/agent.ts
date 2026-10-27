import { homedir } from "node:os";
import { resolveVersion } from "@todou/shared/version";
import { Command } from "clipanion";
import { doctorReport } from "../agent-doctor.ts";
import type { CliContext } from "../api-command.ts";
import type { CliConfig, Env } from "../config.ts";
import {
  configPath,
  loadCliConfig,
  loadCliConfigSet,
  saveCliConfig,
  tildePath,
} from "../config.ts";
import { reportError } from "../errors.ts";
import { type FollowAdvice, followAdvice } from "../follow-advice.ts";
import { detectHarnessId } from "../harness/index.ts";
import {
  type HarnessMessaging,
  harnessMessaging,
} from "../harness/messaging.ts";

/** Absent means advised, so only an explicit `false` opts out. */
function optedOut(config: CliConfig): boolean {
  return config.agent?.follow_uds === false;
}

function whereItLives(env: Env): string {
  return tildePath(configPath(env), env);
}

/**
 * Which follow mode this harness supports, in prose an agent acts on.
 *
 * Purely local, like `config show`: no server, no token, no git. It answers
 * while the tracker is down, and it costs one process start — which is what
 * makes "run it and do what it says" a reasonable thing for a skill to ask
 * of every session.
 */
export class AgentCanIFollowCommand extends Command<CliContext> {
  static paths = [["agent", "can-i-follow"]];
  static usage = Command.Usage({
    description: "Report which watch follow mode this environment supports",
    details:
      "Detects the agent harness and its local push channel, then says " +
      "which of `--follow=codex`, `--follow=uds`, `--follow=stdout` " +
      "and poll mode to use on `todou watch` and `todou issue watch`. It " +
      "talks to no server and resolves no project, so it answers in every " +
      "state a session can start in.\n\n" +
      "Exit code is always 0: this is advice, not a test, and a wrapper " +
      'should not read "this harness cannot push" as a failure.',
    examples: [
      ["Which follow mode should I use here", "$0 agent can-i-follow"],
    ],
  });

  async execute(): Promise<number | undefined> {
    try {
      const { advice } = adviseHere(this.context);
      this.context.stdout.write(`${advice.paragraphs.join("\n\n")}\n`);
      return 0;
    } catch (error) {
      return reportError(error, this.context.stderr);
    }
  }
}

/**
 * The inputs `can-i-follow` decides on and the decision, computed once for it
 * and for `doctor`, so the report describes the very advice an agent got.
 */
function adviseHere(context: CliContext): {
  advice: FollowAdvice;
  messaging: HarnessMessaging;
  optedOut: boolean;
} {
  const env = context.env;
  // Threaded the way `watch` threads it: under omp the answer depends on
  // which ancestor published a record, so a test can only state a
  // situation by handing this command a process tree of its own.
  const tree = context.processTree;
  // Read once, read whole: the socket and the tool list come out of the
  // same lookup, and two lookups could straddle an extension update.
  const messaging = harnessMessaging(env, tree);
  const opted = optedOut(loadCliConfig(env));
  const advice = followAdvice({
    harness: detectHarnessId(env, tree),
    socket: messaging.socket,
    codex: messaging.codex,
    tools: messaging.tools ?? [],
    optedOut: opted,
  });
  return { advice, messaging, optedOut: opted };
}

export class AgentDoctorCommand extends Command<CliContext> {
  static paths = [["agent", "doctor"]];
  static usage = Command.Usage({
    description:
      "Report what `can-i-follow` saw, for pasting into a bug report",
    details:
      "Prints how the harness was detected, the process tree it was read " +
      "from, the variables follow depends on, which `todou` is running and " +
      "which ones PATH finds, the account a bare command would use, the push " +
      "channel, the installed integrations and the advice `can-i-follow` " +
      "chose. Run it in the same place the failing watch runs — inside a " +
      "background job or service, not in a fresh terminal.\n\n" +
      "No todou token appears in it: secret variables print as " +
      "`<redacted>`, and every stored, exported or published token, plus " +
      "anything shaped like a personal access token, is masked in the " +
      "finished text. Ancestors' variables are named, never shown; their " +
      "command lines are printed, cut at 120 characters. Like " +
      "`can-i-follow`, it talks to no server and exits 0.",
    examples: [["Diagnose follow here", "$0 agent doctor"]],
  });

  async execute(): Promise<number | undefined> {
    try {
      const { advice, messaging, optedOut } = adviseHere(this.context);
      this.context.stdout.write(
        doctorReport({
          env: this.context.env,
          cwd: this.context.cwd,
          home: this.context.home ?? homedir(),
          processTree: this.context.processTree,
          version: this.cli.binaryVersion ?? resolveVersion(),
          script: process.argv[1],
          advice,
          messaging,
          optedOut,
        }),
      );
      return 0;
    } catch (error) {
      return reportError(error, this.context.stderr);
    }
  }
}

export class AgentOptOutUdsCommand extends Command<CliContext> {
  static paths = [["agent", "opt-out-uds"]];
  static usage = Command.Usage({
    description: "Stop advising `--follow=uds` on this machine",
    details:
      "Records in the user config that `todou agent can-i-follow` must not " +
      "offer the push transport here, which is the answer when a session " +
      "keeps holding, refusing or dropping pushed messages.\n\n" +
      "It changes advice only. `todou watch --follow=uds` keeps working " +
      "exactly as before, because passing the flag is a deliberate act and " +
      "the failure path already degrades cleanly.\n\n" +
      "`todou agent opt-in-uds` undoes it.",
    examples: [
      ["Stop offering the push transport here", "$0 agent opt-out-uds"],
    ],
  });

  async execute(): Promise<number | undefined> {
    try {
      const env = this.context.env;
      // Judged on the merged view — a fragment's opt-out counts — while
      // the write lands in `config.toml` alone.
      const { config, own } = loadCliConfigSet(env);
      if (optedOut(config)) {
        this.context.stdout.write(
          `--follow=uds was already opted out · ${whereItLives(env)}\n`,
        );
        return 0;
      }
      own.agent = { ...own.agent, follow_uds: false };
      saveCliConfig(own, env);
      this.context.stdout.write(
        `--follow=uds opted out · ${whereItLives(env)}\n` +
          "`todou agent can-i-follow` will stop offering it; " +
          "`todou agent opt-in-uds` undoes this.\n",
      );
      return 0;
    } catch (error) {
      return reportError(error, this.context.stderr);
    }
  }
}

export class AgentOptInUdsCommand extends Command<CliContext> {
  static paths = [["agent", "opt-in-uds"]];
  static usage = Command.Usage({
    description: "Advise `--follow=uds` again on this machine",
    details:
      "Undoes `todou agent opt-out-uds` by removing the preference, after " +
      "which `todou agent can-i-follow` offers the push transport wherever " +
      "a Claude Code session exports a socket.",
    examples: [["Offer the push transport again", "$0 agent opt-in-uds"]],
  });

  async execute(): Promise<number | undefined> {
    try {
      const env = this.context.env;
      const { config, own, files } = loadCliConfigSet(env);
      if (config.agent?.follow_uds === undefined) {
        this.context.stdout.write(
          `--follow=uds was already advised · ${whereItLives(env)}\n`,
        );
        return 0;
      }
      // A fragment's `false` cannot be deleted from here; only an explicit
      // `true` in config.toml outranks it. Absent any fragment, the key is
      // removed rather than set — an `[agent]` section left behind saying
      // the default is one more thing for the next reader to wonder about.
      const fragmentOptOut = files.some(
        (f) =>
          f.path !== configPath(env) &&
          (f.doc.agent as { follow_uds?: unknown } | undefined)?.follow_uds ===
            false,
      );
      if (fragmentOptOut) {
        own.agent = { ...own.agent, follow_uds: true };
      } else if (own.agent) {
        const { follow_uds: _, ...rest } = own.agent;
        if (Object.keys(rest).length > 0) own.agent = rest;
        else delete own.agent;
      }
      saveCliConfig(own, env);
      this.context.stdout.write(
        `--follow=uds advised again · ${whereItLives(env)}\n` +
          (fragmentOptOut
            ? `note: a config fragment still says follow_uds = false; ${whereItLives(env)} now overrides it\n`
            : ""),
      );
      return 0;
    } catch (error) {
      return reportError(error, this.context.stderr);
    }
  }
}
