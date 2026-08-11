import { Builtins, Cli, Command, Option } from "clipanion";

class ServeCommand extends Command {
  static paths = [["serve"], Command.Default];

  static usage = Command.Usage({
    description: "Start the todou server",
  });

  port = Option.String("--port", "3000", {
    description: "Port to listen on",
  });

  async execute(): Promise<number | undefined> {
    this.context.stdout.write(
      `todou server placeholder — would listen on :${this.port} 🥔\n`,
    );
    return 0;
  }
}

const cli = new Cli({
  binaryLabel: "todou server",
  binaryName: "todou-server",
  binaryVersion: "0.1.0",
});

cli.register(ServeCommand);
cli.register(Builtins.HelpCommand);
cli.register(Builtins.VersionCommand);
cli.runExit(process.argv.slice(2));
