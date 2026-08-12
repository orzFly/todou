import {
  type Dirent,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { SpecFileInput, TodouClient } from "@todou/shared";
import { SpecPushInput } from "@todou/shared";
import { Command, Option } from "clipanion";
import { z } from "zod";
import { ProjectCommand } from "../api-command.ts";
import { CliError } from "../errors.ts";

/**
 * Every .md under `dir`, recursively, as spec-relative posix paths. Dot
 * entries are skipped (the server rejects dotfile segments anyway); other
 * non-markdown files are collected so the caller can say what it ignored.
 */
function collectMarkdown(
  dir: string,
  prefix = "",
): { files: SpecFileInput[]; skipped: string[] } {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (cause) {
    throw new CliError(`cannot read directory ${dir}: ${String(cause)}`);
  }
  const files: SpecFileInput[] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      const nested = collectMarkdown(join(dir, entry.name), path);
      files.push(...nested.files);
      skipped.push(...nested.skipped);
    } else if (entry.isFile()) {
      if (/\.md$/i.test(entry.name)) {
        files.push({ path, body: readFileSync(join(dir, entry.name), "utf8") });
      } else {
        skipped.push(path);
      }
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files, skipped };
}

const changeLines = (result: {
  added: string[];
  changed: string[];
  removed: string[];
}): string[] => [
  ...result.added.map((p) => `  + ${p}`),
  ...result.changed.map((p) => `  ~ ${p}`),
  ...result.removed.map((p) => `  - ${p}`),
];

export class SpecPushCommand extends ProjectCommand {
  static paths = [["spec", "push"]];
  static usage = Command.Usage({
    description: "Replace an issue's spec with a directory of markdown",
    details:
      "Collects every .md under `<dir>` (recursively) and syncs the whole " +
      "set as one new version: files absent from the directory are removed " +
      "from the spec. `<dir>` is deliberately required — a stray push from " +
      "a repository root must not become the spec. No difference → no new " +
      "version. `--if-version N` fails with a conflict unless the current " +
      "version is N (optimistic lock for concurrent agents).",
    examples: [
      [
        "Push the spec set of issue 23",
        "$0 spec push 23 ./specs/spec-feature --message 'address review'",
      ],
    ],
  });

  number = Option.String({ required: true });
  dir = Option.String({ required: true });
  message = Option.String("--message", {
    description: "Version note shown in the timeline and version list",
  });
  ifVersion = Option.String("--if-version", {
    description: "Fail unless the current version matches",
  });

  protected async run(client: TodouClient): Promise<void> {
    const { project, number } = this.resolveIssueRef(this.number);
    const { files, skipped } = collectMarkdown(this.dir);
    const input = SpecPushInput.safeParse({
      files,
      message: this.message,
      if_version:
        this.ifVersion === undefined ? undefined : Number(this.ifVersion),
    });
    if (!input.success) {
      throw new CliError(
        `invalid spec push:\n${z.prettifyError(input.error)}`,
        `collected ${files.length} .md file(s) under ${this.dir}`,
      );
    }
    for (const path of skipped) this.note(`skipped (not .md): ${path}`);

    const result = await client.pushSpec(project, number, input.data);
    this.output(result, () =>
      result.unchanged
        ? `no changes — spec stays at v${result.version}`
        : [
            `spec v${result.version} pushed: ${result.added.length} added, ` +
              `${result.changed.length} changed, ${result.removed.length} removed`,
            ...changeLines(result),
          ].join("\n"),
    );
  }
}

export class SpecPullCommand extends ProjectCommand {
  static paths = [["spec", "pull"]];
  static usage = Command.Usage({
    description: "Download an issue's spec into a directory",
    details:
      "Writes every file of the requested version (default: current) into " +
      "`<dir>`, overwriting what is there. Local .md files the spec does " +
      "not contain are listed but kept; pass `--prune` to delete them so " +
      "the directory mirrors the spec exactly.",
    examples: [["Pull the current spec of issue 23", "$0 spec pull 23 ./spec"]],
  });

  number = Option.String({ required: true });
  dir = Option.String({ required: true });
  version = Option.String("--version", {
    description: "Pull this version instead of the current one",
  });
  prune = Option.Boolean("--prune", false, {
    description: "Delete local .md files that are not part of the spec",
  });

  protected async run(client: TodouClient): Promise<void> {
    const { project, number } = this.resolveIssueRef(this.number);
    const spec = await client.getSpecFiles(
      project,
      number,
      this.version === undefined ? undefined : Number(this.version),
    );

    mkdirSync(this.dir, { recursive: true });
    for (const file of spec.files) {
      const target = join(this.dir, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.body);
    }

    const specPaths = new Set(spec.files.map((f) => f.path));
    const extras = collectMarkdown(this.dir).files.filter(
      (f) => !specPaths.has(f.path),
    );
    for (const extra of extras) {
      if (this.prune) {
        unlinkSync(join(this.dir, extra.path));
        this.note(`pruned ${extra.path}`);
      } else {
        this.note(
          `kept local file not in spec: ${extra.path} (--prune deletes)`,
        );
      }
    }

    this.output(spec, () =>
      [
        `pulled spec v${spec.version} (${spec.files.length} files) into ${this.dir}`,
        ...spec.files.map((f) => `  ${f.path}`),
      ].join("\n"),
    );
  }
}

export class SpecStatusCommand extends ProjectCommand {
  static paths = [["spec", "status"]];
  static usage = Command.Usage({
    description: "Spec overview: version, review state, files",
    details:
      "Errors when the issue has no spec. Under `--json` the full version " +
      "list rides along; agents watching for a verdict should prefer " +
      "`todou issue watch <n> --type spec_review`.",
  });

  number = Option.String({ required: true });

  protected async run(client: TodouClient): Promise<void> {
    const { project, number } = this.resolveIssueRef(this.number);
    const info = await client.getSpec(project, number);
    this.output(info, () => {
      const status = {
        unreviewed: "awaiting review",
        approved: "approved",
        changes_requested: "changes requested",
      }[info.review_status];
      const lines = [
        `spec v${info.current_version} · ${status} · ${info.unresolved_comments} unresolved comment(s)`,
        ...info.files.map((f) => `  ${f.path} (${f.size} bytes)`),
        "versions:",
        ...info.versions.map((v) => {
          const note = v.message === null ? "" : ` — ${v.message}`;
          return `  v${v.number} by ${v.author.login} at ${v.created_at}${note}`;
        }),
      ];
      return lines.join("\n");
    });
  }
}
