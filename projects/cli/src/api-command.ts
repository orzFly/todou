import { TodouClient } from "@todou/shared";
import { type BaseContext, Command, Option } from "clipanion";
import { type CliConfig, loadCliConfig } from "./config.ts";
import {
  gitRemoteUrl,
  type ResolvedContext,
  resolveContext,
} from "./context.ts";
import { CliError, reportError } from "./errors.ts";

export type CliContext = BaseContext & {
  cwd: string;
  /** Test seam; production leaves it unset and TodouClient uses global fetch. */
  fetchImpl?: typeof fetch;
};

/** Base for every command that talks to a server: context, client, --json. */
export abstract class ApiCommand extends Command<CliContext> {
  serverFlag = Option.String("--server", {
    description: "Server origin, e.g. https://todou.example",
  });
  profile = Option.String("--profile", {
    description: 'Named token profile ("default" = the default token)',
  });
  json = Option.Boolean("--json", false, {
    description: "Print the raw API response as JSON",
  });

  protected config!: CliConfig;
  protected ctx!: ResolvedContext;

  protected abstract run(client: TodouClient): Promise<void>;

  /** Overridden by ProjectCommand; the base has no -p flag. */
  protected projectFlag(): string | undefined {
    return undefined;
  }

  async execute(): Promise<number | undefined> {
    try {
      this.config = loadCliConfig(this.context.env);
      this.ctx = resolveContext({
        flags: {
          server: this.serverFlag,
          project: this.projectFlag(),
          profile: this.profile,
        },
        env: this.context.env,
        config: this.config,
        remoteUrl: gitRemoteUrl(this.context.cwd),
      });
      if (!this.ctx.server) {
        throw new CliError(
          "no server configured",
          "pass --server <origin>, set TODOU_SERVER, or run `todou login <origin>`",
        );
      }
      if (!this.ctx.token) {
        throw new CliError(
          `not logged in to ${this.ctx.server}`,
          `run \`todou login ${this.ctx.server}\` or set TODOU_TOKEN`,
        );
      }
      await this.run(
        new TodouClient({
          baseUrl: this.ctx.server,
          token: this.ctx.token,
          fetch: this.context.fetchImpl,
        }),
      );
      return 0;
    } catch (error) {
      return this.report(error);
    }
  }

  protected report(error: unknown): number {
    return reportError(error, this.context.stderr, this.ctx?.server);
  }

  /** stdout carries data only: the raw JSON under --json, prose otherwise. */
  protected output(data: unknown, human: () => string): void {
    const text = this.json ? JSON.stringify(data, null, 2) : human();
    this.context.stdout.write(`${text}\n`);
  }

  protected note(line: string): void {
    this.context.stderr.write(`${line}\n`);
  }
}

/** Base for commands scoped to a project (adds -p and its guard). */
export abstract class ProjectCommand extends ApiCommand {
  project = Option.String("-p,--project", {
    description: "Project slug",
  });

  protected override projectFlag(): string | undefined {
    return this.project;
  }

  protected requireProject(): string {
    if (!this.ctx.project) {
      throw new CliError(
        "no project selected",
        "pass -p/--project <slug>, set TODOU_PROJECT, or bind this repository with `todou project link <slug>`",
      );
    }
    return this.ctx.project;
  }
}
