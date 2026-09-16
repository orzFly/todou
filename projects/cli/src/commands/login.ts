import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import {
  AGENT_CONTEXT_HEADER,
  formatCliAuthCode,
  TodouClient,
  TodouError,
} from "@todou/shared";
import { Command, Option } from "clipanion";
import type { CliContext } from "../api-command.ts";
import { systemClock } from "../clock.ts";
import {
  configPath,
  loadCliConfigSet,
  normalizeServer,
  saveCliConfig,
  tildePath,
} from "../config.ts";
import { CliError, reportError } from "../errors.ts";
import { detectAgentContext } from "../harness/index.ts";
import {
  openBrowser,
  pollForApproval,
  promptHidden,
  waitForCallback,
} from "../login-flow.ts";
import { fetchWebOrigin } from "../resolve.ts";
import {
  buildAliasTable,
  buildNameTable,
  resolveServerInput,
  unknownServerError,
} from "../server-alias.ts";

export class LoginCommand extends Command<CliContext> {
  static paths = [["login"]];
  static usage = Command.Usage({
    description: "Log in to a todou server and store a token",
    details:
      "Opens the browser to authorize the CLI; the token lands in ~/.config/todou/config.toml. Use --no-browser when the browser is on another machine: the CLI prints a one-time code and waits for you to authorize it there. Use --manual to paste a token instead.",
    examples: [
      [
        "Authorize this machine in a browser",
        "todou login https://todou.example",
      ],
      [
        "Store a separate token for an agent to pick up",
        "todou login https://todou.example --profile claude-code",
      ],
    ],
  });

  server = Option.String({ required: false });
  profile = Option.String("--profile", {
    description: "Store the token under this profile name instead of default",
  });
  manual = Option.Boolean("--manual", false, {
    description: "Paste a token instead of using the browser",
  });
  noBrowser = Option.Boolean("--no-browser", false, {
    description:
      "Authorize from a browser on any other machine (no local callback)",
  });

  async execute(): Promise<number | undefined> {
    try {
      const env = this.context.env;
      // Judged on the merged view, written to `config.toml` alone: a
      // fragment's profiles must not be flattened into the write target.
      const { config, own, files } = loadCliConfigSet(env);
      const names = buildNameTable(config);
      const aliases = buildAliasTable(config);
      const given = this.server ?? config.default_server;
      if (!given) {
        throw new CliError(
          "no server given",
          "usage: todou login <origin>, e.g. todou login https://todou.example",
        );
      }
      // A token belongs on the entry the CLI will actually use. The address
      // a person logs in at may be an alias of it (T-311) — the public
      // hostname, say, while requests go to the proxy — or a name (T-366).
      const resolved = resolveServerInput(given, { names, aliases });
      if (resolved.viaName === undefined && resolved.from === undefined) {
        if (!/^https?:\/\//.test(resolved.server)) {
          throw unknownServerError(given, names);
        }
      }
      const origin = normalizeServer(resolved.server);
      if (this.profile === "default") {
        throw new CliError(
          '"default" is reserved for the default token',
          "omit --profile to store the default token",
        );
      }

      const anon = new TodouClient({
        baseUrl: origin,
        fetch: this.context.fetchImpl,
      });
      /**
       * The pages below are opened by a person, whose browser need not be
       * able to reach the address the CLI talks to — that is the whole point
       * of --no-browser (T-295). Started here rather than at each print site
       * so the device flow's create call covers it, and after the checks
       * above so a rejected argument leaves no request behind.
       *
       * Bounded, unlike the other caller of `fetchWebOrigin`, which runs
       * after a request has already failed and so knows the server answers.
       * Here it is the command's first contact, and on two of the three paths
       * nothing was sent before it at all: a server that accepts the
       * connection and then goes quiet would hold back the link, and the
       * browser, with the flow's own 300s deadline not yet started. Five
       * seconds is far above this hop's real RTT.
       */
      const clock = this.context.clock ?? systemClock;
      const bound = new AbortController();
      const webOrigin = Promise.race([
        fetchWebOrigin(anon, origin),
        clock.sleep(5000, bound.signal).then(() => origin),
      ]);
      // Whichever won: an uncancelled timer keeps the process alive for the
      // rest of its five seconds after the command has printed its result.
      void webOrigin.finally(() => bound.abort());

      const token = this.manual
        ? await this.manualToken(webOrigin)
        : this.noBrowser
          ? await this.deviceToken(anon, webOrigin)
          : await this.browserToken(webOrigin);

      // Verify before persisting so a mis-paste fails loudly, not later.
      const agentContext = detectAgentContext(this.context.env);
      const client = new TodouClient({
        baseUrl: origin,
        token,
        headers: agentContext
          ? { [AGENT_CONTEXT_HEADER]: JSON.stringify(agentContext) }
          : undefined,
        fetch: this.context.fetchImpl,
      });
      const me = await client.me();

      const entry = own.servers[origin] ?? { tokens: {} };
      if (this.profile) {
        entry.tokens = { ...entry.tokens, [this.profile]: token };
      } else {
        entry.token = token;
      }
      own.servers[origin] = entry;
      own.default_server = origin;
      saveCliConfig(own, env);
      this.context.stderr.write(
        `logged in to ${origin} as ${me.login}${
          this.profile ? ` (profile "${this.profile}")` : ""
        }\n`,
      );
      // A fragment holding the default token for this server keeps doing so
      // in the file, but stops being what a command uses — worth one line
      // so nobody wonders which of the two is live.
      const fragmentToken =
        this.profile === undefined ? config.servers[origin]?.token : undefined;
      if (fragmentToken !== undefined && fragmentToken !== token) {
        const fragment = [...files]
          .reverse()
          .find(
            (f) =>
              (
                f.doc.servers as Record<string, { token?: string }> | undefined
              )?.[origin]?.token === fragmentToken,
          );
        if (fragment && fragment.path !== configPath(env)) {
          this.context.stderr.write(
            `note: ${fragment.path} also stores a default token for ${origin}; ${tildePath(configPath(env), env)} wins from now on\n`,
          );
        }
      }
      return 0;
    } catch (error) {
      return reportError(error, this.context.stderr, this.server);
    }
  }

  /** The token's name in the browser and in token lists afterwards. */
  private tokenName(): string {
    const name = `cli @ ${hostname()}${
      this.profile ? ` (${this.profile})` : ""
    }`;
    return name.slice(0, 100);
  }

  private timeoutMs(): number {
    return Number(this.context.env.TODOU_LOGIN_TIMEOUT_MS ?? "") || 300_000;
  }

  private async browserToken(webOrigin: Promise<string>): Promise<string> {
    const state = randomBytes(16).toString("hex");
    const base = await webOrigin;
    return waitForCallback({
      state,
      timeoutMs: this.timeoutMs(),
      onListening: (port) => {
        const url = new URL(`${base}/cli-auth`);
        url.searchParams.set("port", String(port));
        url.searchParams.set("state", state);
        url.searchParams.set("name", this.tokenName());
        this.context.stderr.write(
          `Authorize the CLI in your browser:\n  ${url}\n`,
        );
        (this.context.openBrowser ?? openBrowser)(url.toString());
        this.context.stderr.write(
          "Waiting for the browser… (Ctrl-C aborts; --manual pastes a token)\n",
        );
      },
    });
  }

  /**
   * Nothing listens locally here: the browser talks only to the server, so
   * it may live on another machine entirely. The code printed below is what
   * ties the page the user opens to this terminal — it is shown on both
   * ends precisely so they can be compared before authorizing.
   */
  private async deviceToken(
    client: TodouClient,
    webOrigin: Promise<string>,
  ): Promise<string> {
    let request: Awaited<ReturnType<typeof client.createCliAuthRequest>>;
    try {
      request = await client.createCliAuthRequest({ name: this.tokenName() });
    } catch (error) {
      if (
        error instanceof TodouError &&
        (error.status === 404 || error.status === 405)
      ) {
        throw new CliError(
          "this server does not support --no-browser login",
          "upgrade the server, or paste a token with --manual",
        );
      }
      throw error;
    }

    const code = formatCliAuthCode(request.code);
    const url = new URL(`${await webOrigin}/cli-auth`);
    url.searchParams.set("code", code);
    this.context.stderr.write(
      `First, copy your one-time code: ${code}\n` +
        `Then open this page on any machine and authorize:\n  ${url}\n` +
        "Waiting for approval… (Ctrl-C aborts; --manual pastes a token instead)\n",
    );

    return pollForApproval({
      client,
      requestId: request.id,
      pollSecret: request.poll_secret,
      intervalMs: request.interval * 1000,
      timeoutMs: this.timeoutMs(),
      clock: this.context.clock,
    });
  }

  private async manualToken(webOrigin: Promise<string>): Promise<string> {
    this.context.stderr.write(
      `Create a token under ${await webOrigin}/settings/tokens, then paste it.\n`,
    );
    const token = await promptHidden(
      this.context.stdin,
      this.context.stderr,
      "token: ",
    );
    if (!token) throw new CliError("no token given");
    return token;
  }
}
