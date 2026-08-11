import { serve } from "@hono/node-server";
import { Builtins, Cli, Command, Option } from "clipanion";
import { createApp } from "./app.ts";
import { bootstrap } from "./bootstrap.ts";
import { loadConfig } from "./config.ts";
import { DbRouter } from "./db/router.ts";
import { projects } from "./db/system-schema.ts";

abstract class ConfiguredCommand extends Command {
  configPath = Option.String("--config", {
    description: "Path to todou.toml (default: ./todou.toml)",
  });

  loadConfig() {
    return loadConfig({ configPath: this.configPath });
  }
}

class ServeCommand extends ConfiguredCommand {
  static paths = [["serve"], Command.Default];

  static usage = Command.Usage({
    description: "Start the todou server",
  });

  port = Option.String("--port", {
    description: "Port to listen on (overrides config)",
  });

  async execute(): Promise<number | undefined> {
    const config = this.loadConfig();
    const context = await bootstrap(config);
    const app = createApp(context);
    const port = this.port ? Number(this.port) : config.http.port;

    const server = serve({ fetch: app.fetch, port }, (info) => {
      this.context.stdout.write(`todou server listening on :${info.port} 🥔\n`);
    });

    await new Promise<void>((resolve) => {
      const shutdown = () => {
        this.context.stdout.write("shutting down…\n");
        server.close(() => resolve());
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
    await context.router.close();
    return 0;
  }
}

class MigrateCommand extends ConfiguredCommand {
  static paths = [["migrate"]];

  static usage = Command.Usage({
    description:
      "Apply pending migrations to the system database and every project database",
  });

  async execute(): Promise<number | undefined> {
    const config = this.loadConfig();
    const router = await DbRouter.open(config);
    try {
      await router.systemHandle().migrate("system");
      if (config.database.projects.placement === "shared") {
        await router.systemHandle().migrate("project");
      }
      const rows = await router
        .system()
        .select({
          id: projects.id,
          slug: projects.slug,
          databaseUrl: projects.databaseUrl,
        })
        .from(projects);
      for (const row of rows) {
        await router.provision({
          id: row.id,
          slug: row.slug,
          database_url: row.databaseUrl,
        });
      }
      this.context.stdout.write(
        `migrations applied (system + ${rows.length} project(s))\n`,
      );
      return 0;
    } finally {
      await router.close();
    }
  }
}

const cli = new Cli({
  binaryLabel: "todou server",
  binaryName: "todou-server",
  binaryVersion: "0.1.0",
});

cli.register(ServeCommand);
cli.register(MigrateCommand);
cli.register(Builtins.HelpCommand);
cli.register(Builtins.VersionCommand);
cli.runExit(process.argv.slice(2));
