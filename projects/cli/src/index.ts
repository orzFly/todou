import { resolveVersion } from "@todou/shared/version";
import { Builtins, Cli } from "clipanion";
import type { CliContext } from "./api-command.ts";
import { commands } from "./commands/index.ts";
import {
  commandTable,
  guardDashLeadingValue,
  guardUnknownCommand,
} from "./suggest.ts";

const argv = process.argv.slice(2);

// Ahead of clipanion, whose answer to an unknown command is every usage line
// it can reach (T-187), and whose answer to a `--`-leading option value names
// no way to pass one (T-198). Plain text and exit 1, matching `reportError`.
const guard =
  guardUnknownCommand(argv, commandTable(commands)) ??
  guardDashLeadingValue(argv);

if (guard) {
  process.stderr.write(`${guard.join("\n")}\n`);
  // Not process.exit(1): stderr to a pipe is asynchronous, and exiting
  // outright can drop the very lines this branch exists to print.
  process.exitCode = 1;
} else {
  const cli = new Cli<CliContext>({
    binaryLabel: "todou",
    binaryName: "todou",
    binaryVersion: resolveVersion(),
  });

  for (const command of commands) {
    cli.register(command);
  }
  cli.register(Builtins.HelpCommand);
  cli.register(Builtins.VersionCommand);

  cli.runExit(argv, { cwd: process.cwd() });
}
