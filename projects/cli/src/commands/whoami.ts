import type { TodouClient } from "@todou/shared";
import { Command } from "clipanion";
import { ApiCommand } from "../api-command.ts";

export class WhoamiCommand extends ApiCommand {
  static paths = [["whoami"]];
  static usage = Command.Usage({
    description: "Show the signed-in identity and server",
  });

  protected async run(client: TodouClient): Promise<void> {
    const me = await client.me();
    switch (this.ctx.tokenSource) {
      case "auto-claude-code":
        this.note('token: profile "claude-code" (auto via CLAUDECODE)');
        break;
      case "flag-profile":
      case "env-profile":
        this.note(`token: profile "${this.ctx.tokenProfile}"`);
        break;
      case "env-token":
        this.note("token: TODOU_TOKEN");
        break;
      default:
        break;
    }
    this.output(
      me,
      () =>
        `${me.login} (${me.display_name}) · ${me.kind} @ ${this.ctx.server}`,
    );
  }
}
