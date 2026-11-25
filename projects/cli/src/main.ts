import { resolveVersion } from "@todou/shared/version";
import { createCli } from "./cli.ts";
import { commands } from "./commands/index.ts";
import {
  commandTable,
  guardDashLeadingValue,
  guardUnknownCommand,
} from "./suggest.ts";

/**
 * One whole CLI run, resolving with its exit code. Shared by every entry
 * point; each decides for itself how a process ends on that code (T-792).
 */
export async function main(argv: string[]): Promise<number> {
  // Ahead of clipanion, whose answer to an unknown command is every usage line
  // it can reach (T-187), and whose answer to a `--`-leading option value names
  // no way to pass one (T-198). Plain text and exit 1, matching `reportError`.
  const guard =
    guardUnknownCommand(argv, commandTable(commands)) ??
    guardDashLeadingValue(argv);
  if (guard) {
    process.stderr.write(`${guard.join("\n")}\n`);
    return 1;
  }
  return createCli(resolveVersion()).run(argv, { cwd: process.cwd() });
}
