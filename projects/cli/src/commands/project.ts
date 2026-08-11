import type { TodouClient } from "@todou/shared";
import { Command, Option } from "clipanion";
import { ApiCommand, type CliContext } from "../api-command.ts";
import { loadCliConfig, saveCliConfig } from "../config.ts";
import { gitRemoteUrl } from "../context.ts";
import { CliError } from "../errors.ts";
import { table } from "../format.ts";

export class ProjectListCommand extends ApiCommand {
  static paths = [["project", "list"]];
  static usage = Command.Usage({ description: "List visible projects" });

  protected async run(client: TodouClient): Promise<void> {
    const projects = await client.listProjects();
    this.output(projects, () =>
      table(projects.map((p) => [p.slug, p.name, p.description])),
    );
  }
}

export class ProjectLinkCommand extends ApiCommand {
  static paths = [["project", "link"]];
  static usage = Command.Usage({
    description: "Bind this repository's git remote to a server/project",
    details:
      "The binding lives in ~/.config/todou/config.toml, not in the repository.",
  });

  slug = Option.String({ required: true });

  protected async run(client: TodouClient): Promise<void> {
    const remote = this.ctx.remoteUrl;
    if (!remote) {
      throw new CliError(
        "no usable git remote here",
        "run inside a repository with an origin (or single) remote",
      );
    }
    const server = this.ctx.server as string;
    // Fail on typos now rather than on the first bound command later.
    await client.getProject(this.slug);

    const config = loadCliConfig(this.context.env);
    config.bindings = config.bindings.filter((b) => b.remote !== remote);
    config.bindings.push({ remote, server, project: this.slug });
    saveCliConfig(config, this.context.env);
    this.note(`linked ${remote} → ${server} · ${this.slug}`);
  }
}

/** Purely local: works logged-out, so it skips ApiCommand entirely. */
export class ProjectUnlinkCommand extends Command<CliContext> {
  static paths = [["project", "unlink"]];
  static usage = Command.Usage({
    description: "Remove this repository's server/project binding",
  });

  async execute(): Promise<number | undefined> {
    const remote = gitRemoteUrl(this.context.cwd);
    if (!remote) {
      this.context.stderr.write("error: no usable git remote here\n");
      return 1;
    }
    const config = loadCliConfig(this.context.env);
    const remaining = config.bindings.filter((b) => b.remote !== remote);
    if (remaining.length === config.bindings.length) {
      this.context.stderr.write(`error: no binding for ${remote}\n`);
      return 1;
    }
    config.bindings = remaining;
    saveCliConfig(config, this.context.env);
    this.context.stderr.write(`unlinked ${remote}\n`);
    return 0;
  }
}
