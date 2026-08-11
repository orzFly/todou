import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { TodouClient } from "@todou/shared";
import { Command, Option } from "clipanion";
import type { CliContext } from "../api-command.ts";
import { loadCliConfig, normalizeServer, saveCliConfig } from "../config.ts";
import { CliError, reportError } from "../errors.ts";
import { openBrowser, promptHidden, waitForCallback } from "../login-flow.ts";

export class LoginCommand extends Command<CliContext> {
  static paths = [["login"]];
  static usage = Command.Usage({
    description: "Log in to a todou server and store a token",
    details:
      "Opens the browser to authorize the CLI; the token lands in ~/.config/todou/config.toml. Use --manual to paste a token instead (headless).",
    examples: [
      ["Log in to the dogfood server", "todou login https://todou.example"],
    ],
  });

  server = Option.String({ required: false });
  manual = Option.Boolean("--manual", false, {
    description: "Paste a token instead of using the browser",
  });
  noBrowser = Option.Boolean("--no-browser", false, {
    description: "Print the authorization URL without opening a browser",
  });

  async execute(): Promise<number | undefined> {
    try {
      const env = this.context.env;
      const config = loadCliConfig(env);
      const given = this.server ?? config.default_server;
      if (!given) {
        throw new CliError(
          "no server given",
          "usage: todou login <origin>, e.g. todou login https://todou.example",
        );
      }
      const origin = normalizeServer(given);
      if (!/^https?:\/\//.test(origin)) {
        throw new CliError(`server must be an http(s) origin, got "${origin}"`);
      }

      const token = this.manual
        ? await this.manualToken(origin)
        : await this.browserToken(origin);

      // Verify before persisting so a mis-paste fails loudly, not later.
      const client = new TodouClient({
        baseUrl: origin,
        token,
        fetch: this.context.fetchImpl,
      });
      const me = await client.me();

      config.servers[origin] = { token };
      config.default_server = origin;
      saveCliConfig(config, env);
      this.context.stderr.write(`logged in to ${origin} as ${me.login}\n`);
      return 0;
    } catch (error) {
      return reportError(error, this.context.stderr, this.server);
    }
  }

  private browserToken(origin: string): Promise<string> {
    const state = randomBytes(16).toString("hex");
    const timeoutMs =
      Number(this.context.env.TODOU_LOGIN_TIMEOUT_MS ?? "") || 300_000;
    return waitForCallback({
      state,
      timeoutMs,
      onListening: (port) => {
        const url = new URL(`${origin}/cli-auth`);
        url.searchParams.set("port", String(port));
        url.searchParams.set("state", state);
        url.searchParams.set("name", `cli @ ${hostname()}`);
        this.context.stderr.write(
          `Authorize the CLI in your browser:\n  ${url}\n`,
        );
        if (!this.noBrowser) openBrowser(url.toString());
        this.context.stderr.write(
          "Waiting for the browser… (Ctrl-C aborts; --manual pastes a token)\n",
        );
      },
    });
  }

  private async manualToken(origin: string): Promise<string> {
    this.context.stderr.write(
      `Create a token under ${origin}/settings/tokens, then paste it.\n`,
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
