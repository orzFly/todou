import { Command } from "clipanion";
import type { CliContext } from "../api-command.ts";
import type { CliConfig, Env } from "../config.ts";
import {
  configPath,
  loadCliConfig,
  saveCliConfig,
  tildePath,
} from "../config.ts";
import { reportError } from "../errors.ts";
import { followAdvice } from "../follow-advice.ts";
import { detectHarnessId } from "../harness/index.ts";

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
      "Detects the agent harness and whether a Claude Code session exported " +
      "a push socket, then says which of `--follow=uds`, `--follow=stdout` " +
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
      const env = this.context.env;
      const advice = followAdvice({
        harness: detectHarnessId(env),
        socket: env.CLAUDE_CODE_MESSAGING_SOCKET,
        optedOut: optedOut(loadCliConfig(env)),
      });
      this.context.stdout.write(`${advice.paragraphs.join("\n\n")}\n`);
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
      const config = loadCliConfig(env);
      if (optedOut(config)) {
        this.context.stdout.write(
          `--follow=uds was already opted out · ${whereItLives(env)}\n`,
        );
        return 0;
      }
      saveCliConfig({ ...config, agent: { follow_uds: false } }, env);
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
      const config = loadCliConfig(env);
      if (config.agent === undefined) {
        this.context.stdout.write(
          `--follow=uds was already advised · ${whereItLives(env)}\n`,
        );
        return 0;
      }
      // Removed rather than set to `true`: `saveCliConfig` rewrites the whole
      // document, and an `[agent]` section left behind saying the default is
      // one more thing for the next reader to wonder about.
      const { agent: _removed, ...rest } = config;
      saveCliConfig(rest, env);
      this.context.stdout.write(
        `--follow=uds advised again · ${whereItLives(env)}\n`,
      );
      return 0;
    } catch (error) {
      return reportError(error, this.context.stderr);
    }
  }
}
