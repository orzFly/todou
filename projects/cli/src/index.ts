import { Builtins, Cli } from "clipanion";
import type { CliContext } from "./api-command.ts";
import { commands } from "./commands/index.ts";

const cli = new Cli<CliContext>({
  binaryLabel: "todou",
  binaryName: "todou",
  binaryVersion: "0.1.0",
});

for (const command of commands) {
  cli.register(command);
}
cli.register(Builtins.HelpCommand);
cli.register(Builtins.VersionCommand);

cli.runExit(process.argv.slice(2), { cwd: process.cwd() });
