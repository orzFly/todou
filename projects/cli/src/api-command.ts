import {
  AGENT_CONTEXT_HEADER,
  type AgentContext,
  type MovedTo,
  PROJECT_NOT_FOUND,
  TodouClient,
  TodouError,
} from "@todou/shared";
import { type BaseContext, Command, Option } from "clipanion";
import { type Clock, systemClock } from "./clock.ts";
import { type CliConfig, configPath, loadCliConfig } from "./config.ts";
import {
  gitRemoteUrl,
  type ResolvedContext,
  resolveContext,
} from "./context.ts";
import { discoverDirConfig } from "./dir-config.ts";
import { CliError, NoAccessError, reportError } from "./errors.ts";
import { type GrantAccessKind, grantAccessLines } from "./grant-access.ts";
import { detectAgentContext, liveSessionIdReader } from "./harness/index.ts";
import type { ProcessTreeIo } from "./harness/process-tree.ts";
import type { LiveSession } from "./harness/types.ts";
import {
  checkQualifiedPrefix,
  type LadderResult,
  resolvePrefixedRef,
} from "./locator.ts";
import { parseIssueRef } from "./parse.ts";
import type { openPeerPush } from "./peer-push.ts";
import type { RefFormat } from "./refs.ts";
import {
  declaredPublicOrigin,
  fetchAccessHint,
  fetchReferenceConfig,
  fetchReferenceDirectory,
  fetchResolvedRef,
  fetchWebOrigin,
} from "./resolve.ts";
import {
  type AliasRow,
  buildAliasTable,
  buildNameTable,
  coveringBase,
  localizeIssueUrl,
  unknownServerError,
} from "./server-alias.ts";
import { openWatchLifetime, type WatchLifetime } from "./watch-lifetime.ts";
import type { SessionSource } from "./watch-loop.ts";

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

/**
 * Which project a failure says this account cannot reach, and in what way
 * (T-280). Pure, and the only place the three trigger conditions are written
 * down.
 *
 * The 404 takes all three of status, code and message, because
 * `issue not found` is the same status and code one path segment deeper — the
 * message is what tells them apart, which is why it is a shared constant.
 */
function accessTargetOf(
  error: unknown,
): { target: string; kind: GrantAccessKind } | undefined {
  if (error instanceof NoAccessError) {
    return { target: error.target, kind: "unreadable" };
  }
  if (!(error instanceof TodouError)) return undefined;
  // Every project-scoped route is `/projects/{ref}/…`, so the ref the request
  // actually named is in its path — the error envelope names no subject.
  const target = /^\/projects\/([^/?#]+)/.exec(error.path ?? "")?.[1];
  if (target === undefined) return undefined;
  if (
    error.status === 404 &&
    error.code === "not_found" &&
    error.message === PROJECT_NOT_FOUND
  ) {
    return { target, kind: "unreadable" };
  }
  // The project reads fine here, so the wording may name it outright.
  if (error.status === 403) return { target, kind: "role" };
  return undefined;
}

export type CliContext = BaseContext & {
  cwd: string;
  /** Test seam; production leaves it unset and TodouClient uses global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam; production leaves it unset and time is the wall clock. */
  clock?: Clock;
  /** Test seam; production leaves it unset and spawns the real browser. */
  openBrowser?: (url: string) => void;
  /** Test seam; production leaves it unset and a real Unix socket is used. */
  openPeerPush?: typeof openPeerPush;
  /** Test seam; production leaves it unset and the real home is read. */
  home?: string;
  /** Test seam; production leaves it unset and the real /proc is walked. */
  processTree?: Partial<ProcessTreeIo>;
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
  /** Replaced in `execute` once the environment is known (T-289). */
  protected liveSession: () => LiveSession = () => ({});
  protected watchLifetime?: WatchLifetime;

  /** Only resident raw watches opt in; ordinary commands keep their lifetime. */
  protected bindWatchOwner(): boolean {
    return false;
  }

  /** Who this process is now: the id it holds live, else the one it began with. */
  protected ownSession(): string | undefined {
    return this.liveSession().id ?? this.agentContext?.session_id;
  }

  /** Both halves of that, for a holder long-lived enough to have to re-ask. */
  protected sessionSource(): SessionSource {
    return {
      live: this.liveSession,
      startup: this.agentContext?.session_id,
    };
  }

  /** Held for `report`, which asks the server two more things after a
   * failure; unset when the failure came before there was a client. */
  private client?: TodouClient;

  /** May return a non-zero exit code for "no error, but nothing happened". */
  // biome-ignore lint/suspicious/noConfusingVoidType: `undefined` would force every void-returning command to change its signature
  protected abstract run(client: TodouClient): Promise<number | void>;

  /** Overridden by ProjectCommand; the base has no -p flag. */
  protected projectFlag(): string | undefined {
    return undefined;
  }

  protected get clock(): Clock {
    return this.watchLifetime?.clock ?? this.context.clock ?? systemClock;
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
      // Raised here rather than in resolveContext so `config show`, a
      // plain Command, still prints the full report naming the input.
      if (this.ctx.serverUnknownName) {
        throw unknownServerError(this.ctx.server, buildNameTable(this.config));
      }
      if (!this.ctx.token) {
        // Both hints name `config show` because these two failures are
        // exactly when someone reaches for config.toml by hand, and a token
        // read out of that file is a leak with nothing left to buy (T-185).
        // The entry's name, when it has one, is how a person spells it —
        // and `todou login` takes names too (T-366).
        const said = this.nameOfServer(this.ctx.server) ?? this.ctx.server;
        throw new CliError(
          `not logged in to ${said}`,
          `run \`todou login ${said}\` or set TODOU_TOKEN; ` +
            "run `todou config show` to see what is configured",
        );
      }
      this.agentContext = detectAgentContext(
        this.context.env,
        this.context.home,
        undefined,
        this.context.processTree,
      );
      this.liveSession = liveSessionIdReader({
        env: this.context.env,
        home: this.context.home,
        io: this.context.processTree,
      });
      if (this.bindWatchOwner()) {
        this.watchLifetime = openWatchLifetime({
          env: this.context.env,
          io: this.context.processTree,
          clock: this.context.clock,
          note: (line) => this.note(line),
        });
      }
      const signal = this.watchLifetime?.signal;
      const fetchImpl = this.context.fetchImpl ?? globalThis.fetch;
      const announced = new Set<string>();
      this.client = new TodouClient({
        baseUrl: this.ctx.server,
        token: this.ctx.token,
        headers: this.agentContext
          ? { [AGENT_CONTEXT_HEADER]: JSON.stringify(this.agentContext) }
          : undefined,
        fetch:
          signal === undefined
            ? this.context.fetchImpl
            : (input, init) =>
                fetchImpl(input, {
                  ...init,
                  signal: init?.signal
                    ? AbortSignal.any([signal, init.signal])
                    : signal,
                }),
        onCanonicalSlug: (canonical, requested) => {
          // The header also fires for a project named by its id, which is
          // a spelling every route takes rather than one that has been
          // retired (T-266). Advising a re-link there would be telling
          // somebody to fix something that is not broken.
          if (requested !== null && /^\d+$/.test(requested)) return;
          if (announced.has(canonical)) return;
          announced.add(canonical);
          // Deliberately not rewriting .todou.toml / config.toml: the
          // binding may well be committed to the repository, and that is
          // the user's file to change.
          this.note(
            `note: project "${requested ?? this.ctx.project ?? "?"}" is now ` +
              `"${canonical}" — run \`todou project link ${canonical}\` ` +
              "to update this machine",
          );
        },
      });
      const code = await this.run(this.client);
      return typeof code === "number" ? code : 0;
    } catch (error) {
      if (this.watchLifetime?.signal.aborted) return 0;
      return await this.report(error);
    } finally {
      this.watchLifetime?.close();
    }
  }

  protected async report(error: unknown): Promise<number> {
    return reportError(
      error,
      this.context.stderr,
      this.ctx?.server,
      await this.#accessLines(error),
    );
  }

  /**
   * The access-link block, or nothing (T-280). Both reads happen only after
   * the command has already failed, so no successful run pays for them.
   *
   * Nothing is printed when the hint cannot be had: a link naming the wrong
   * account is worse than no link, and a server old enough to lack the
   * endpoint has no page to open either.
   */
  async #accessLines(error: unknown): Promise<string[] | undefined> {
    const client = this.client;
    const server = this.ctx?.server;
    if (client === undefined || server === undefined) return undefined;
    const asked = accessTargetOf(error);
    if (asked === undefined) return undefined;
    const who = await fetchAccessHint(client, asked.target);
    // Denied: this account was told once, by somebody who can see that
    // project, to stop asking. Saying so would be a channel of its own, so
    // the failure goes back to reading like any other (design.md §3).
    if (who === null || who.suppressed) return undefined;
    return grantAccessLines(
      await fetchWebOrigin(client, server),
      asked.target,
      who,
      asked.kind,
    );
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

  /** The entry's `name` for this origin, when it has one (T-366). */
  protected nameOfServer(origin: string): string | undefined {
    return this.config.servers[origin]?.name;
  }

  protected note(line: string): void {
    this.context.stderr.write(`${line}\n`);
  }
}

/** The parser's own wording for a URL that carries no issue route (T-311). */
function notAnIssueUrl(raw: string): CliError {
  return new CliError(
    `"${raw}" is not an issue URL`,
    "expected <server>/projects/<project>/issues/<number>",
  );
}

/**
 * A root-relative address with the query dropped and the fragment kept, so
 * the path parser reads exactly what it knows how to read.
 *
 * `parseIssueRef` matches the whole pathname, so a `?tracking=1` left on a
 * valid permalink would turn it into "not an issue URL". And the query
 * belongs to the page the link was copied from, not to the reference: two
 * people pasting the same card from two tabs with different parameters mean
 * the same card.
 */
function issueAddressOf(address: string): string {
  const query = address.indexOf("?");
  if (query === -1) return address;
  const fragment = address.indexOf("#", query);
  return (
    address.slice(0, query) + (fragment === -1 ? "" : address.slice(fragment))
  );
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
  ): Promise<{
    project: string;
    number: number;
    /**
     * Where the card is now, set only where the server resolved the prefix.
     * `project`/`number` above stay the address the ref spells, so the
     * request meets the same 301 or 409 the id form of it would.
     */
    at?: MovedTo;
    /** The ref as typed, for the `moved from` line `at` cannot spell. */
    asTyped?: string;
    /** The `#comment-<id>` a permalink carried, absent otherwise (T-311). */
    commentId?: number;
  }> {
    // A URL is localized first: the address a person copies out of the web
    // UI need not be the one the CLI talks to, and the mount prefix is in
    // the way of the route shape the parser looks for (T-311).
    const ref = parseIssueRef(
      /^https?:\/\//i.test(raw) ? await this.localizeRefUrl(client, raw) : raw,
      "issue number",
    );
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
      return {
        project: ref.project,
        number: ref.number,
        ...(ref.commentId === undefined ? {} : { commentId: ref.commentId }),
      };
    }
    if (ref.prefix === undefined) {
      return {
        project: this.requireProject(),
        number: ref.number,
        ...(ref.commentId === undefined ? {} : { commentId: ref.commentId }),
      };
    }
    const project = this.ctx.project;
    const config =
      project === undefined
        ? null
        : await fetchReferenceConfig(client, project);
    let resolved: LadderResult;
    /** Set only where the server resolved the ref; see the fence below. */
    let at: MovedTo | undefined;
    const own = resolvePrefixedRef(ref.prefix, raw, {
      project,
      config,
      directory: undefined,
    });
    if ("needsDirectory" in own) {
      const directory = await fetchReferenceDirectory(client);
      const listed = resolvePrefixedRef(ref.prefix, raw, {
        project,
        config,
        directory,
      });
      if ("needsResolve" in listed) {
        // The directory is trimmed to what this account may read, so "no
        // project uses this prefix" was only ever "none that I can see".
        // The server judges the same token against every project, and
        // answers only where the card it leads to is readable anyway (T-288).
        const answer = await fetchResolvedRef(client, raw);
        resolved = resolvePrefixedRef(ref.prefix, raw, {
          project,
          config,
          directory,
          resolved: answer,
        });
        at = answer?.at;
      } else resolved = listed;
    } else resolved = own;
    // What keeps `-p acme` a sandbox fence: a prefix that resolves
    // elsewhere refuses rather than overriding the flag, so a ref pasted
    // from another project cannot silently redirect a command at it.
    // Neither a first-rung hit nor the loose fallback can trip this — both
    // land on the current project, which the flag itself decided.
    //
    // Judged by where the card IS, not by which project the prefix names:
    // the two part company as soon as a card moves, and judging by the
    // prefix refused `CH-158 -p beta` for a card sitting in beta, with a
    // hint naming `beta/158` — a different card that really existed.
    const landed = at?.slug ?? resolved.project;
    if (this.project !== undefined && this.project !== landed) {
      // The project has to be spelled out: unlike `todou/16`, the one a
      // prefix names is not visible in what was typed, so without it the
      // reader cannot tell which side to change.
      throw new CliError(
        `"${raw}" resolves to project "${landed}" (prefix ${ref.prefix}), ` +
          `but -p/--project says "${this.project}"`,
        at === undefined
          ? `write "${this.project}/${ref.number}" for this project, or drop -p/--project`
          : `write "${at.slug}/${at.number}" for that card, or drop -p/--project`,
      );
    }
    return {
      project: resolved.project,
      number: ref.number,
      ...(at === undefined ? {} : { at, asTyped: raw }),
      ...(ref.commentId === undefined ? {} : { commentId: ref.commentId }),
    };
  }

  /**
   * A URL-form reference as the root-relative address the parser takes
   * (T-311). The active base and its configured aliases are tried first;
   * failing those, a URL whose origin the server itself declares as its own
   * is accepted, since there is nothing local left to match it against —
   * most reverse-proxy deployments need no configuration at all.
   *
   * The declared read is the one cost this can add, and it lands only on a
   * run that was already about to fail with "points at <origin>, but the
   * active server is <base>". `fetchVersion` memoizes per client, so a
   * command resolving several positionals asks once.
   *
   * Every returned address starts with `/`: a covered URL that names no
   * issue route — the base root, with or without a query, a fragment, or a
   * numeric one — is the caller's `is not an issue URL`, and refusing it
   * here rather than letting the parser word it is what keeps a bare
   * `#3` from being read as this project's card 3.
   */
  private async localizeRefUrl(
    client: TodouClient,
    raw: string,
  ): Promise<string> {
    const active = this.ctx.server;
    const table = buildAliasTable(this.config);
    let address: string | null = null;
    if (active !== undefined) {
      const bases = [
        active,
        ...table.filter((row) => row.server === active).map((row) => row.alias),
      ];
      address = localizeIssueUrl(raw, bases);
    }
    if (address === null) {
      const declared = await declaredPublicOrigin(client);
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        throw notAnIssueUrl(raw);
      }
      if (declared === undefined || parsed.origin !== declared) {
        throw await this.foreignRefError(raw, table);
      }
      // A declared origin is a bare origin, so the pathname is the whole
      // address; only the query has to go.
      address = `${parsed.pathname}${parsed.hash}`;
    }
    // The query goes and the fragment stays, then what is left has to be a
    // route: a covered URL naming none — the base root, with or without a
    // query, a `#comment-<id>` fragment, or a bare `#3` — is the caller's
    // `is not an issue URL`, and refusing it here is what keeps that last
    // spelling from being read as this project's card 3.
    const route = issueAddressOf(address);
    if (!route.startsWith("/")) throw notAnIssueUrl(raw);
    return route;
  }

  /**
   * Why a URL matched nothing. Two shapes, because the reader's next move
   * differs: a URL belonging to another *configured* server is one
   * `--server` away, while one on an address the CLI has never heard of is
   * a guess about the deployment, and what settles it is an `instead_of`
   * line named by file and by exact text.
   *
   * "Belongs to" is `coveringBase`, not origin equality: a base carries an
   * optional path prefix, so a URL under `http://b.test/todou` has origin
   * `http://b.test`, which equals no key in the file. Comparing origins
   * read that as an unknown address and advised adding
   * `instead_of = ["http://b.test"]` under the active entry — an alias
   * covering *every* path on that origin, which would have silently
   * rewritten the other deployment's links, and its `--server`, onto the
   * active one. The longest covering base is what both the localization and
   * this message name.
   *
   * The alias is hand-edited on purpose: there is no config-writing
   * command, and inventing one is a larger surface than aliases need. What
   * makes hand-editing safe is schema membership — `saveCliConfig` rewrites
   * the whole document from the parsed config, so a key zod does not know
   * would be dropped by the next `todou login`.
   */
  private async foreignRefError(
    raw: string,
    table: AliasRow[],
  ): Promise<CliError> {
    const bases = [
      ...Object.keys(this.config.servers),
      ...table.flatMap((row) => [row.alias, row.server]),
    ];
    const covered = coveringBase(raw, bases);
    if (covered !== null) {
      // One `--server` away — spelled the way a person spells it, which
      // is the entry's name when it has one (T-366).
      const said = this.nameOfServer(covered) ?? covered;
      return new CliError(
        `"${raw}" points at ${covered}, which is configured but not active`,
        `run it with --server ${said}`,
      );
    }
    const origin = new URL(raw).origin;
    const active = this.ctx.server ?? "(none configured)";
    const path = configPath(this.context.env);
    return new CliError(
      `"${raw}" points at ${origin}, but this CLI talks to ${active}`,
      `if they are the same deployment, add it under [servers."${active}"] in ${path}:\n` +
        `  instead_of = ["${origin}"]\n` +
        "otherwise pass --server to switch servers, or reference the issue as <project>/<number>",
    );
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
    /**
     * Parallel to `numbers`, and `undefined` for every ref whose own
     * spelling names its project. Not the same question as `spellings`:
     * this is the subset that has no address to fall back on, because a
     * prefix the server resolved names its holder by id.
     */
    asTyped: Array<string | undefined>;
  }> {
    let project: string | undefined;
    let owner: string | undefined;
    const numbers: number[] = [];
    const spellings: string[] = [];
    const asTyped: Array<string | undefined> = [];
    for (const raw of raws) {
      const ref = await this.resolveIssueRef(client, raw);
      if (project === undefined) {
        project = ref.project;
        owner = raw;
      } else if (ref.project !== project) {
        // The address each ref is ASKED FOR, not the one it lands at: this
        // one project is what the requests, the status vocabulary and the
        // `ref_format` are all read against. Two refs that land in the same
        // project by different routes still cannot share one of those.
        throw new CliError(
          `"${owner}" says project "${project}" but "${raw}" says "${ref.project}"`,
          ref.at === undefined
            ? "one call reads one project — split them into two"
            : `one call reads one project — write "${ref.at.slug}/${ref.at.number}", or split them into two`,
        );
      }
      if (numbers.includes(ref.number)) {
        this.note(`duplicate ${raw} ignored`);
        continue;
      }
      numbers.push(ref.number);
      spellings.push(raw);
      asTyped.push(ref.asTyped);
    }
    if (project === undefined) throw new CliError("no issue number given");
    return { project, numbers, spellings, asTyped };
  }
}
