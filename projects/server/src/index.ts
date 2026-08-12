import { serve } from "@hono/node-server";
import { Builtins, Cli, Command, Option } from "clipanion";
import { createApp } from "./app.ts";
import { bootstrap } from "./bootstrap.ts";
import { loadConfig, resolveS3Settings } from "./config.ts";
import { DbRouter } from "./db/router.ts";
import { projects } from "./db/system-schema.ts";
import { startHousekeeping } from "./services/housekeeping.ts";
import {
  copyMissing,
  enumerateBlobKeys,
  gcPendingUploads,
} from "./services/storage-admin.ts";
import { FsStorage } from "./storage/fs.ts";
import { S3Storage } from "./storage/s3.ts";

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

class StorageMigrateCommand extends ConfiguredCommand {
  static paths = [["storage", "migrate"]];

  static usage = Command.Usage({
    description:
      "Copy attachment and avatar blobs between the fs and s3 backends",
    details:
      "Copies every blob the databases know about (avatars + all project " +
      "attachments) to the target backend. Idempotent: keys whose target " +
      "size already matches are skipped, so an interrupted run can simply " +
      "be re-run. The source is never deleted; rolling back is running " +
      "the copy in the other direction and flipping storage.backend.",
  });

  to = Option.String("--to", {
    required: true,
    description: 'Target backend: "s3" (fs → s3) or "fs" (s3 → fs)',
  });

  dryRun = Option.Boolean("--dry-run", false, {
    description: "List what would be copied without writing",
  });

  async execute(): Promise<number | undefined> {
    if (this.to !== "s3" && this.to !== "fs") {
      this.context.stderr.write('--to must be "s3" or "fs"\n');
      return 1;
    }
    const config = this.loadConfig();
    const fsEnd = new FsStorage(config.storage.path);
    // Resolve the s3 end regardless of which backend currently serves.
    const credentials = config.s3Credentials ?? resolveS3Settings(config);
    const s3End = new S3Storage(config.storage.s3, credentials);
    await s3End.checkBucket();
    const [src, dst] =
      this.to === "s3" ? [fsEnd, s3End] : ([s3End, fsEnd] as const);

    const router = await DbRouter.open(config);
    try {
      const keys = await enumerateBlobKeys(router);
      const report = await copyMissing(src, dst, keys, {
        dryRun: this.dryRun,
        log: (line) => this.context.stdout.write(`${line}\n`),
      });
      this.context.stdout.write(
        `${this.dryRun ? "[dry-run] " : ""}--to ${this.to}: ` +
          `${report.copied} copied, ${report.skipped} skipped, ` +
          `${report.failed} failed (${keys.length} total)\n`,
      );
      return report.failed > 0 ? 1 : 0;
    } finally {
      await router.close();
    }
  }
}

class StorageGcCommand extends ConfiguredCommand {
  static paths = [["storage", "gc"]];

  static usage = Command.Usage({
    description: "Reap expired direct uploads that were never completed",
    details:
      "Walks pending_uploads rows past expiry (plus --min-age hours of " +
      "margin), deletes the orphaned objects of uncompleted rows, and " +
      "drops the rows. Driven entirely by the database — the bucket is " +
      "never listed.",
  });

  dryRun = Option.Boolean("--dry-run", false, {
    description: "List what would be reaped without deleting",
  });

  minAge = Option.String("--min-age", "24", {
    description: "Hours past expiry before a pending upload is reaped",
  });

  async execute(): Promise<number | undefined> {
    const minAgeHours = Number(this.minAge);
    if (!Number.isFinite(minAgeHours) || minAgeHours < 0) {
      this.context.stderr.write("--min-age must be a non-negative number\n");
      return 1;
    }
    const config = this.loadConfig();
    if (config.storage.backend !== "s3" || !config.s3Credentials) {
      this.context.stdout.write(
        "storage.backend is not s3; no direct uploads to gc\n",
      );
      return 0;
    }
    const storage = new S3Storage(config.storage.s3, config.s3Credentials);
    const router = await DbRouter.open(config);
    try {
      const report = await gcPendingUploads(router, storage, {
        dryRun: this.dryRun,
        minAgeHours,
        log: (line) => this.context.stdout.write(`${line}\n`),
      });
      this.context.stdout.write(
        this.dryRun
          ? `[dry-run] would reap ${report.wouldDelete} pending upload(s)\n`
          : `reaped ${report.droppedRows} pending upload(s), ` +
              `deleted ${report.deletedObjects} orphan object(s)\n`,
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
cli.register(StorageMigrateCommand);
cli.register(StorageGcCommand);
cli.register(Builtins.HelpCommand);
cli.register(Builtins.VersionCommand);
cli.runExit(process.argv.slice(2));
