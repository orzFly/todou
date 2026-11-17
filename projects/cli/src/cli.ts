import { Builtins, Cli, type Command } from "clipanion";
import type { CliContext } from "./api-command.ts";
import { commands } from "./commands/index.ts";

/**
 * The listing clipanion builds for `todou issue --help`. Not exported by
 * clipanion, so it is recognised by these two fields.
 */
type HelpListing = {
  commands: number[];
  contexts: Array<{ commandClass: unknown }>;
};

function isHelpListing(command: object): command is HelpListing {
  return (
    Array.isArray((command as Partial<HelpListing>).commands) &&
    Array.isArray((command as Partial<HelpListing>).contexts)
  );
}

/**
 * Clipanion keeps one entry per path, so a command with an alias matches a
 * namespace twice and prints its first path twice (T-728). Keep the first
 * entry per class; `-h=<index>` indexes the same array, so the numbers it
 * accepts still match the ones printed.
 */
function listEachCommandOnce(listing: HelpListing): void {
  const seen = new Set<unknown>();
  listing.commands = listing.commands.filter((index) => {
    const { commandClass } = listing.contexts[index] ?? {};
    if (seen.has(commandClass)) return false;
    seen.add(commandClass);
    return true;
  });
}

export function createCli(binaryVersion: string): Cli<CliContext> {
  const cli = new Cli<CliContext>({
    binaryLabel: "todou",
    binaryName: "todou",
    binaryVersion,
  });

  for (const command of commands) {
    cli.register(command);
  }
  cli.register(Builtins.HelpCommand);
  cli.register(Builtins.VersionCommand);

  const process = cli.process.bind(cli) as (
    ...args: unknown[]
  ) => Command<CliContext>;
  cli.process = ((...args: unknown[]) => {
    const command = process(...args);
    if (isHelpListing(command)) listEachCommandOnce(command);
    return command;
  }) as typeof cli.process;

  return cli;
}
