import { Builtins, Cli, Command } from "clipanion";

class PingCommand extends Command {
  static paths = [["ping"], Command.Default];

  static usage = Command.Usage({
    description: "Check that the todou CLI is alive",
  });

  async execute(): Promise<number | undefined> {
    this.context.stdout.write("todou 🥔 — pong\n");
    return 0;
  }
}

const cli = new Cli({
  binaryLabel: "todou",
  binaryName: "todou",
  binaryVersion: "0.1.0",
});

cli.register(PingCommand);
cli.register(Builtins.HelpCommand);
cli.register(Builtins.VersionCommand);
cli.runExit(process.argv.slice(2));
