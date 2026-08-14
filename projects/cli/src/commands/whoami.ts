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
      case "auto-harness":
        this.note(
          `token: profile "${this.ctx.tokenProfile}" (auto-detected harness)`,
        );
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
    // The deployment probe for new harness detectors: shows what a write
    // from this environment would report, without having to post one.
    if (this.agentContext) {
      // The model is the part most likely to be missing on a host the detector
      // was never run on, so the probe has to show it or it cannot catch a
      // silently degraded lookup (T-120).
      const detail = [
        this.agentContext.session_id &&
          `session ${this.agentContext.session_id}`,
        this.agentContext.model && `model ${this.agentContext.model}`,
      ].filter(Boolean);
      const suffix = detail.length ? ` (${detail.join(", ")})` : "";
      this.note(`detected harness: ${this.agentContext.agent}${suffix}`);
    }
    this.output(
      me,
      () =>
        `${me.login} (${me.display_name}) · ${me.kind} @ ${this.ctx.server}`,
    );
  }
}
