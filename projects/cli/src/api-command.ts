import {
  AGENT_CONTEXT_HEADER,
  type AgentContext,
  TodouClient,
} from "@todou/shared";
import { type BaseContext, Command, Option } from "clipanion";
import { type Clock, systemClock } from "./clock.ts";
import { type CliConfig, loadCliConfig } from "./config.ts";
import {
  gitRemoteUrl,
  type ResolvedContext,
  resolveContext,
} from "./context.ts";
import { discoverDirConfig } from "./dir-config.ts";
import { CliError, reportError } from "./errors.ts";
import { detectAgentContext } from "./harness/index.ts";
import { parseIssueRef } from "./parse.ts";
import type { RefFormat } from "./refs.ts";

export type CursorRecord = {
  type: "cursor";
  next_cursor: string | null;
  ref_format?: RefFormat;
};

/**
 * The record every NDJSON batch ends with: where to resume, and — where
 * one project owns the stream — how it spells its refs. Being a record of
 * its own rather than a field on each item is what keeps cursor minting
 * server-side: cursors are cut per page, not per entry (T-175).
 */
export function cursorRecord(
  cursor: string | undefined,
  format?: RefFormat,
): CursorRecord {
  return {
    type: "cursor",
    next_cursor: cursor ?? null,
    ...(format === undefined ? {} : { ref_format: format }),
  };
}

export type CliContext = BaseContext & {
  cwd: string;
  /** Test seam; production leaves it unset and TodouClient uses global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam; production leaves it unset and time is the wall clock. */
  clock?: Clock;
  /** Test seam; production leaves it unset and spawns the real browser. */
  openBrowser?: (url: string) => void;
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
  protected agentContext: AgentContext | null = null;

  /** May return a non-zero exit code for "no error, but nothing happened". */
  // biome-ignore lint/suspicious/noConfusingVoidType: `undefined` would force every void-returning command to change its signature
  protected abstract run(client: TodouClient): Promise<number | void>;

  /** Overridden by ProjectCommand; the base has no -p flag. */
  protected projectFlag(): string | undefined {
    return undefined;
  }

  protected get clock(): Clock {
    return this.context.clock ?? systemClock;
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
        dirConfig: discoverDirConfig(this.context.cwd, this.context.env),
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
      this.agentContext = detectAgentContext(this.context.env);
      const announced = new Set<string>();
      const code = await this.run(
        new TodouClient({
          baseUrl: this.ctx.server,
          token: this.ctx.token,
          headers: this.agentContext
            ? { [AGENT_CONTEXT_HEADER]: JSON.stringify(this.agentContext) }
            : undefined,
          fetch: this.context.fetchImpl,
          onCanonicalSlug: (canonical) => {
            if (announced.has(canonical)) return;
            announced.add(canonical);
            // Deliberately not rewriting .todou.toml / config.toml: the
            // binding may well be committed to the repository, and that is
            // the user's file to change.
            this.note(
              `note: project "${this.ctx.project ?? "?"}" is now ` +
                `"${canonical}" — run \`todou project link ${canonical}\` ` +
                "to update this machine",
            );
          },
        }),
      );
      return typeof code === "number" ? code : 0;
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

  /**
   * A batch of records: NDJSON under --json, the prose otherwise. One
   * compact record per line makes a file a consumer appends to parseable
   * line by line, with no document boundaries to hunt for (T-175) — so an
   * empty batch prints nothing at all rather than a blank line, which is
   * the one thing `jq` could not swallow.
   */
  protected outputBatch(records: unknown[], human: () => string): void {
    if (!this.json) {
      this.context.stdout.write(`${human()}\n`);
      return;
    }
    if (records.length === 0) return;
    this.context.stdout.write(
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
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
        "pass -p/--project <slug>, set TODOU_PROJECT, run `todou project link <slug>`, or add a .todou.toml",
      );
    }
    return this.ctx.project;
  }

  /**
   * Resolves a `<number>` positional that may carry its own project
   * (`todou/16`, `#16`, or an issue URL). An inline project is as explicit
   * as -p, so it silently overrides TODOU_PROJECT and the git binding;
   * only a contradicting -p flag is an error.
   */
  protected resolveIssueRef(raw: string): { project: string; number: number } {
    const ref = parseIssueRef(raw, "issue number");
    if (ref.origin !== undefined && this.ctx.server !== undefined) {
      const active = new URL(this.ctx.server).origin;
      if (ref.origin !== active) {
        throw new CliError(
          `"${raw}" points at ${ref.origin}, but the active server is ${active}`,
          "pass --server to switch servers, or reference the issue as <project>/<number>",
        );
      }
    }
    if (ref.project === undefined) {
      return { project: this.requireProject(), number: ref.number };
    }
    if (this.project !== undefined && this.project !== ref.project) {
      throw new CliError(
        `"${raw}" says project "${ref.project}" but -p/--project says "${this.project}"`,
        "drop one of them — they must agree",
      );
    }
    return { project: ref.project, number: ref.number };
  }
}
