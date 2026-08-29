import { statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectUpdateInput, TodouClient } from "@todou/shared";
import { Command, Option } from "clipanion";
import { stringify } from "smol-toml";
import { ApiCommand, type CliContext, ProjectCommand } from "../api-command.ts";
import { loadCliConfig, saveCliConfig } from "../config.ts";
import { gitRemoteUrl, gitToplevel } from "../context.ts";
import {
  DIR_CONFIG_NAMES,
  discoverDirConfig,
  displayPath,
} from "../dir-config.ts";
import { CliError, reportError } from "../errors.ts";
import { table } from "../format.ts";

function statOrNull(path: string) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/**
 * Where a directory config for `cwd` belongs: the repository root when
 * inside one — "link" binds the whole unit, and the discovery walk stops
 * at the root, so a file deeper down would cover only a corner of it —
 * and cwd itself otherwise.
 */
function linkTarget(cwd: string): string {
  return gitToplevel(cwd) ?? cwd;
}

const [CONFIG_VARIANT, PLAIN_VARIANT] = DIR_CONFIG_NAMES;

/**
 * The file link writes inside `dir`: an existing config first — writing
 * the preferred name beside an existing .todou.toml would shadow it — then
 * the .config/ variant when that directory already exists.
 */
function dirConfigFileIn(dir: string): string {
  const preferred = join(dir, CONFIG_VARIANT);
  const plain = join(dir, PLAIN_VARIANT);
  if (statOrNull(preferred)?.isFile()) return preferred;
  if (statOrNull(plain)?.isFile()) return plain;
  return statOrNull(join(dir, ".config"))?.isDirectory() ? preferred : plain;
}

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

export class ProjectEditCommand extends ProjectCommand {
  static paths = [["project", "edit"]];
  static usage = Command.Usage({
    description: "Rename a project or change its description",
    details:
      "The slug positional is optional: without it the project comes from " +
      "-p/--project, TODOU_PROJECT, or this directory's link. --slug moves " +
      "the project to a new address; the old one keeps redirecting until " +
      "another project takes it over, but bindings on other machines are " +
      "worth updating with `todou project link`.",
  });

  slug = Option.String({ required: false });
  name = Option.String("--name", { description: "New display name" });
  description = Option.String("--description", {
    description: 'New description ("" clears it)',
  });
  newSlug = Option.String("--slug", {
    description: "New slug (the project's address in URLs and bindings)",
  });
  reclaim = Option.Boolean("--reclaim", false, {
    description: "Take a slug that still redirects to another project",
  });

  protected async run(client: TodouClient): Promise<void> {
    const slug = this.targetProject();

    const input: ProjectUpdateInput = {};
    if (this.name !== undefined) input.name = this.name;
    if (this.description !== undefined) input.description = this.description;
    if (this.newSlug !== undefined) input.slug = this.newSlug;
    if (this.reclaim) input.reclaim = true;
    if (
      input.name === undefined &&
      input.description === undefined &&
      input.slug === undefined
    ) {
      throw new CliError(
        "nothing to change",
        "pass --name, --description or --slug",
      );
    }

    const project = await client.updateProject(slug, input).catch((error) => {
      if ((error as { code?: string }).code === "slug_reserved") {
        throw new CliError(
          (error as Error).message,
          "re-run with --reclaim to take it over — that project's existing " +
            "links, including attachment URLs in its old comments, will " +
            "point here afterwards",
        );
      }
      throw error;
    });
    this.output(project, () =>
      project.slug === slug
        ? `updated project ${project.slug} — ${project.name}`
        : `renamed ${slug} → ${project.slug}\n` +
          `"${slug}" keeps redirecting here; other machines bound to it ` +
          `still work — run \`todou project link ${project.slug}\` on each ` +
          "when convenient",
    );
  }

  /** The positional is as explicit as -p; only a contradiction is an error. */
  private targetProject(): string {
    if (this.slug === undefined) return this.requireProject();
    if (this.project !== undefined && this.project !== this.slug) {
      throw new CliError(
        `"${this.slug}" and -p/--project "${this.project}" name different projects`,
        "drop one of them — they must agree",
      );
    }
    return this.slug;
  }
}

export class ProjectLinkCommand extends ApiCommand {
  static paths = [["project", "link"]];
  static usage = Command.Usage({
    description: "Bind this repository or directory to a server/project",
    details:
      "With a usable git remote the binding lives in ~/.config/todou/config.toml. " +
      "Without one (or with --local) a directory config is written instead — " +
      ".config/todou.toml or .todou.toml at the repository root, or at the current " +
      "directory outside a repository. Commands discover it by walking upward, " +
      "stopping at repository roots, $HOME, and filesystem boundaries.",
  });

  slug = Option.String({ required: true });
  local = Option.Boolean("--local", false, {
    description: "Write a directory config even when a git remote exists",
  });
  global = Option.Boolean("--global", false, {
    description: "Write the remote-keyed user-config binding",
  });

  protected async run(client: TodouClient): Promise<void> {
    if (this.local && this.global) {
      throw new CliError("--local and --global contradict each other");
    }
    const remote = this.ctx.remoteUrl;
    const useLocal = this.local || (!this.global && !remote);
    if (!useLocal && !remote) {
      throw new CliError(
        "--global needs a git remote to key the binding",
        "run inside a repository with an origin (or single) remote, or drop --global",
      );
    }
    const server = this.ctx.server as string;
    // Fail on typos now rather than on the first bound command later. The
    // response also settles the spelling: linking by a retired slug should
    // write the one the project answers to today, not the one that was typed.
    const slug = (await client.getProject(this.slug)).slug;

    if (!useLocal) {
      const config = loadCliConfig(this.context.env);
      config.bindings = config.bindings.filter((b) => b.remote !== remote);
      config.bindings.push({
        remote: remote as string,
        server,
        project: slug,
      });
      saveCliConfig(config, this.context.env);
      this.note(`linked ${remote} → ${server} · ${slug}`);
      return;
    }

    const cwd = this.context.cwd;
    const file = dirConfigFileIn(linkTarget(cwd));
    // A full rewrite: the only legal keys are these two, so anything else
    // in the file was already being ignored on read.
    writeFileSync(file, `${stringify({ server, project: slug })}\n`);
    this.note(`linked ${displayPath(file, cwd)} → ${server} · ${slug}`);
    this.note(
      "note: this file is not auto-gitignored and carries the server origin — commit or ignore it deliberately",
    );
    // If the walk would not hand this very file back, "link succeeded but
    // commands go elsewhere" is undebuggable — say who wins instead.
    let winner: ReturnType<typeof discoverDirConfig> = null;
    try {
      winner = discoverDirConfig(cwd, this.context.env);
    } catch {
      // A nearer, broken file shadows it; the next command names the path.
    }
    if (winner?.path !== file) {
      this.note(
        winner
          ? `note: ${displayPath(winner.path, cwd)} is nearer and takes precedence here`
          : "note: this location is never searched, so the file has no effect here",
      );
    }
  }
}

/** Purely local: works logged-out, so it skips ApiCommand entirely. */
export class ProjectUnlinkCommand extends Command<CliContext> {
  static paths = [["project", "unlink"]];
  static usage = Command.Usage({
    description: "Remove this directory's server/project link",
    details:
      "Deletes the directory config at the repository root (or the current " +
      "directory outside one), falling back to the remote-keyed binding. " +
      "--local/--global restrict it to one side.",
  });

  local = Option.Boolean("--local", false, {
    description: "Remove only the directory config",
  });
  global = Option.Boolean("--global", false, {
    description: "Remove only the remote-keyed user-config binding",
  });

  async execute(): Promise<number | undefined> {
    try {
      return this.unlink();
    } catch (error) {
      return reportError(error, this.context.stderr);
    }
  }

  private unlink(): number {
    if (this.local && this.global) {
      throw new CliError("--local and --global contradict each other");
    }
    const cwd = this.context.cwd;
    const target = linkTarget(cwd);

    if (!this.global) {
      // Deleted by existence, never parsed — a broken file must stay
      // removable, because it blocks every context-resolving command.
      const files = DIR_CONFIG_NAMES.map((name) => join(target, name)).filter(
        (path) => statOrNull(path)?.isFile(),
      );
      const file = files[0];
      if (file !== undefined) {
        unlinkSync(file);
        this.context.stderr.write(`unlinked ${displayPath(file, cwd)}\n`);
        const rest = files[1];
        if (rest !== undefined) {
          this.context.stderr.write(
            `note: ${displayPath(rest, cwd)} remains and takes effect now\n`,
          );
        }
        return 0;
      }
      // A file elsewhere governs this directory; removing the binding
      // would change nothing, so point at the file instead of deleting it
      // — reaching outside the target is more than one CLI call should do.
      const governing = discoverDirConfig(cwd, this.context.env);
      if (governing !== null) {
        throw new CliError(
          `the directory config in effect here is ${displayPath(governing.path, cwd)}`,
          "unlink only removes the one at the repository root (or cwd outside a repository) — delete that file directly if you mean it",
        );
      }
      if (this.local) {
        throw new CliError(`no directory config at ${target}`);
      }
    }

    const remote = gitRemoteUrl(cwd);
    const checked = `checked ${CONFIG_VARIANT} and ${PLAIN_VARIANT} at ${target}, and the user-config bindings`;
    if (!remote) {
      throw new CliError(
        this.global ? "no usable git remote here" : "nothing to unlink here",
        this.global
          ? "run inside a repository with an origin (or single) remote"
          : checked,
      );
    }
    const config = loadCliConfig(this.context.env);
    const remaining = config.bindings.filter((b) => b.remote !== remote);
    if (remaining.length === config.bindings.length) {
      throw new CliError(
        `no binding for ${remote}`,
        this.global ? undefined : checked,
      );
    }
    config.bindings = remaining;
    saveCliConfig(config, this.context.env);
    this.context.stderr.write(`unlinked ${remote}\n`);
    return 0;
  }
}
