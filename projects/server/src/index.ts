import { serve } from "@hono/node-server";
import { Builtins, Cli, Command, Option } from "clipanion";
import { createApp } from "./app.ts";
import { bootstrap } from "./bootstrap.ts";
import { loadConfig } from "./config.ts";
import { DbRouter } from "./db/router.ts";
import { projects } from "./db/system-schema.ts";
import { startHousekeeping } from "./services/housekeeping.ts";

abstract class ConfiguredCommand extends Command {
  configPath = Option.String("--config", {
    description: "Path to todou.toml (default: ./todou.toml)",
  });

  loadConfig() {
    return loadConfig({ configPath: this.configPath });
  }
}

// In-flight requests get this long to finish after a stop signal before
// their connections are severed; clients retry/reconnect (#26, #41).
const DRAIN_GRACE_MS = 1_000;
// If shutdown wedges anyway (a stuck database close, an unforeseen open
// handle), exit by force well before systemd's stop timeout escalates to
// SIGKILL — that escalation is a ~90s outage per deploy (#56).
const FORCED_EXIT_MS = 5_000;

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
    const stopHousekeeping = startHousekeeping(context.router.system());

    await new Promise<void>((resolve) => {
      const beginShutdown = () => {
        this.context.stdout.write("shutting down…\n");
        stopHousekeeping();
        // SSE streams end at the app layer (they never finish on their
        // own, and close() waits for every open connection); their clients
        // are told to reconnect — to the restarted process — by the
        // stream ending.
        context.shutdown.abort();
        server.close(() => resolve());
        setTimeout(() => {
          if ("closeAllConnections" in server) server.closeAllConnections();
        }, DRAIN_GRACE_MS).unref();
        setTimeout(() => {
          this.context.stderr.write("shutdown stalled; forcing exit\n");
          process.exit(1);
        }, FORCED_EXIT_MS).unref();
      };
      process.once("SIGINT", beginShutdown);
      process.once("SIGTERM", beginShutdown);
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
