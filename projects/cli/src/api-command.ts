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
import { checkQualifiedPrefix, resolvePrefixedRef } from "./locator.ts";
import { parseIssueRef } from "./parse.ts";
import type { RefFormat } from "./refs.ts";
import { fetchReferenceConfig, fetchReferenceDirectory } from "./resolve.ts";

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
          "pass --server <origin>, set TODOU_SERVER, or run `todou login <origin>`; " +
            "run `todou config show` to see what is configured",
        );
      }
      if (!this.ctx.token) {
        // Both hints name `config show` because these two failures are
        // exactly when someone reaches for config.toml by hand, and a token
        // read out of that file is a leak with nothing left to buy (T-185).
        throw new CliError(
          `not logged in to ${this.ctx.server}`,
          `run \`todou login ${this.ctx.server}\` or set TODOU_TOKEN; ` +
            "run `todou config show` to see what is configured",
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
   * (`todou/16`, `#16`, `T-16`, or an issue URL). An inline project is as
   * explicit as -p, so it silently overrides TODOU_PROJECT and the git
   * binding; only a contradicting -p flag is an error.
   *
   * A prefix names a project too, in a namespace shared across the
   * deployment (T-150), so `T-16` is resolved rather than read as "16 of
   * whatever is current" — which used to hand back a different card, exit 0.
   * Async for that reason: the two documents the ladder judges by are read
   * here, memoized per command, and not in the pure argument parser.
   */
  protected async resolveIssueRef(
    client: TodouClient,
    raw: string,
  ): Promise<{ project: string; number: number }> {
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
    if (ref.project !== undefined) {
      if (this.project !== undefined && this.project !== ref.project) {
        throw new CliError(
          `"${raw}" says project "${ref.project}" but -p/--project says "${this.project}"`,
          "drop one of them — they must agree",
        );
      }
      if (ref.prefix !== undefined) {
        checkQualifiedPrefix(
          ref.project,
          ref.prefix,
          raw,
          await fetchReferenceConfig(client, ref.project),
        );
      }
      return { project: ref.project, number: ref.number };
    }
    if (ref.prefix === undefined) {
      return { project: this.requireProject(), number: ref.number };
    }
    const project = this.ctx.project;
    const config =
      project === undefined
        ? null
        : await fetchReferenceConfig(client, project);
    const local = resolvePrefixedRef(ref.prefix, raw, {
      project,
      config,
      directory: undefined,
    });
    const resolved =
      "needsDirectory" in local
        ? resolvePrefixedRef(ref.prefix, raw, {
            project,
            config,
            directory: await fetchReferenceDirectory(client),
          })
        : local;
    // What keeps `-p dogfood` a sandbox fence: a prefix that resolves
    // elsewhere refuses rather than overriding the flag, so a ref pasted
    // from another project cannot silently redirect a command at it.
    // Neither a first-rung hit nor the loose fallback can trip this — both
    // land on the current project, which the flag itself decided.
    if (this.project !== undefined && this.project !== resolved.project) {
      // The project has to be spelled out: unlike `todou/16`, the one a
      // prefix names is not visible in what was typed, so without it the
      // reader cannot tell which side to change.
      throw new CliError(
        `"${raw}" resolves to project "${resolved.project}" (prefix ${ref.prefix}), ` +
          `but -p/--project says "${this.project}"`,
        `write "${this.project}/${ref.number}" for this project, or drop -p/--project`,
      );
    }
    return { project: resolved.project, number: ref.number };
  }

  /**
   * Several `<number>` positionals as one batch (T-184). Every spelling
   * `resolveIssueRef` takes is taken here too, one at a time.
   *
   * The batch must name a single project: `ref_format` and the status/label
   * vocabulary are per-project, so a mixed call would need a separate
   * environment per card and the output could no longer state either once.
   * A repeat is dropped rather than refused — the same card twice has no
   * use, so it is a slip in how the list was assembled, and the caller is
   * told rather than stopped.
   */
  protected async resolveIssueRefs(
    client: TodouClient,
    raws: string[],
  ): Promise<{
    project: string;
    /** Input order, first occurrence kept; parallel to `spellings`. */
    numbers: number[];
    /** How the caller wrote each kept number, for hints that paste back. */
    spellings: string[];
  }> {
    let project: string | undefined;
    let owner: string | undefined;
    const numbers: number[] = [];
    const spellings: string[] = [];
    for (const raw of raws) {
      const ref = await this.resolveIssueRef(client, raw);
      if (project === undefined) {
        project = ref.project;
        owner = raw;
      } else if (ref.project !== project) {
        throw new CliError(
          `"${owner}" says project "${project}" but "${raw}" says "${ref.project}"`,
          "one call reads one project — split them into two",
        );
      }
      if (numbers.includes(ref.number)) {
        this.note(`duplicate ${raw} ignored`);
        continue;
      }
      numbers.push(ref.number);
      spellings.push(raw);
    }
    if (project === undefined) throw new CliError("no issue number given");
    return { project, numbers, spellings };
  }
}
