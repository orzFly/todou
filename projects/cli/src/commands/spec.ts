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
import {
  SPEC_MAX_FILE_CHARS,
  SPEC_MAX_FILES,
  SpecPushInput,
} from "@todou/shared";
import { Command, Option } from "clipanion";
import { z } from "zod";
import { ProjectCommand } from "../api-command.ts";
import { readBody } from "../body.ts";
import { CliError } from "../errors.ts";

const WRONG_DIR_HINT =
  "if that path is not part of your spec, this push ran from the wrong " +
  "directory — <dir> must be the spec directory itself, not a repository root";

/**
 * Every .md under `root`, recursively, as spec-relative posix paths. Dot
 * entries are skipped (the server rejects dotfile segments anyway); other
 * non-markdown files are collected so the caller can say what it ignored.
 *
 * `pushLimits` enforces the SpecPushInput caps while walking: a stray push
 * from a repository root must fail on the file that breaks a cap, not
 * buffer the whole source tree first. Pull's extras listing stays
 * uncapped — any number of local files is legal there. Entries are walked
 * in name order so which file gets blamed is stable for a given tree.
 */
function collectMarkdown(
  root: string,
  opts: { pushLimits: boolean },
): { files: SpecFileInput[]; skipped: string[] } {
  const files: SpecFileInput[] = [];
  const skipped: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (cause) {
      throw new CliError(`cannot read directory ${dir}: ${String(cause)}`);
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), path);
      } else if (entry.isFile()) {
        if (!/\.md$/i.test(entry.name)) {
          skipped.push(path);
          continue;
        }
        if (opts.pushLimits && files.length >= SPEC_MAX_FILES) {
          throw new CliError(
            `more than ${SPEC_MAX_FILES} markdown files under ${root} — ` +
              `collection stopped at ${path}`,
            WRONG_DIR_HINT,
          );
        }
        const body = readFileSync(join(dir, entry.name), "utf8");
        if (opts.pushLimits && body.length > SPEC_MAX_FILE_CHARS) {
          throw new CliError(
            `${path} is over the spec file cap ` +
              `(${body.length} > ${SPEC_MAX_FILE_CHARS} characters)`,
            WRONG_DIR_HINT,
          );
        }
        files.push({ path, body });
      }
    }
  };
  walk(root, "");
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
    const { files, skipped } = collectMarkdown(this.dir, { pushLimits: true });
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
    const extras = collectMarkdown(this.dir, {
      pushLimits: false,
    }).files.filter((f) => !specPaths.has(f.path));
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

/**
 * One end of an anchor, `line` or `line.column` (T-142). The compact form
 * keeps the CLI's own `path:5-7` grammar rather than the web's `L5:12–34`:
 * this string is what agents grep and paste back.
 */
function at(line: number, col: number | null | undefined): string {
  // A server older than T-142 sends no column key at all, not a null.
  return col === null || col === undefined ? `${line}` : `${line}.${col}`;
}

export class SpecCommentsCommand extends ProjectCommand {
  static paths = [["spec", "comments"]];
  static usage = Command.Usage({
    description: "List inline spec comments with anchors and resolution",
    details:
      "Anchors are remapped onto the current version; a comment whose " +
      "anchored lines changed since (or whose file is gone) shows as " +
      "outdated. Agents addressing a review typically loop over " +
      "`--unresolved --json` and `spec resolve` each item once addressed.",
    examples: [
      [
        "Unresolved comments as JSON",
        "$0 spec comments 23 --unresolved --json",
      ],
    ],
  });

  number = Option.String({ required: true });
  unresolved = Option.Boolean("--unresolved", false, {
    description: "Only comments not yet resolved",
  });
  file = Option.String("--file", {
    description: "Only comments anchored to this path",
  });

  protected async run(client: TodouClient): Promise<void> {
    const { project, number } = this.resolveIssueRef(this.number);
    const all = await client.getSpecComments(project, number);
    const items = all.items.filter(
      (item) =>
        (!this.unresolved || item.resolved === null) &&
        (this.file === undefined || item.anchor.path === this.file),
    );
    const data = { current_version: all.current_version, items };
    this.output(data, () => {
      if (items.length === 0) return "no matching spec comments";
      const lines: string[] = [
        `${items.length} comment(s) · spec v${all.current_version}`,
      ];
      for (const item of items) {
        const anchor =
          item.anchor.line_start === null || item.anchor.line_end === null
            ? `${item.anchor.path} (file)`
            : `${item.anchor.path}:${at(item.anchor.line_start, item.anchor.col_start)}-${at(item.anchor.line_end, item.anchor.col_end)}`;
        const flags = [
          item.resolved === null
            ? "unresolved"
            : `resolved by ${item.resolved.by.login}`,
          ...(item.outdated ? ["outdated"] : []),
        ].join(", ");
        lines.push(
          `#${item.comment_id} ${anchor} (v${item.anchor.version}) by ${item.author.login} · ${flags}`,
        );
        for (const quoted of item.anchor.quote.split("\n")) {
          lines.push(`  > ${quoted}`);
        }
        for (const bodyLine of item.body.trimEnd().split("\n")) {
          lines.push(`  ${bodyLine}`);
        }
      }
      return lines.join("\n");
    });
  }
}

export class SpecResolveCommand extends ProjectCommand {
  static paths = [["spec", "resolve"]];
  static usage = Command.Usage({
    description: "Resolve inline spec comments (one-way)",
    details:
      "Marks every given comment id resolved in one shot — a single " +
      "`spec_comments_resolved` timeline event, however many ids. " +
      "Resolution cannot be undone; a disputed resolve is answered with a " +
      "new comment on the next review round.",
    examples: [["Resolve two comments", "$0 spec resolve 23 412 415"]],
  });

  number = Option.String({ required: true });
  commentIds = Option.Rest({ required: 1 });

  protected async run(client: TodouClient): Promise<void> {
    const { project, number } = this.resolveIssueRef(this.number);
    const ids = this.commentIds.map((raw) => {
      const id = Number(raw.replace(/^#/, ""));
      if (!Number.isInteger(id) || id <= 0) {
        throw new CliError(`"${raw}" is not a comment id`);
      }
      return id;
    });
    const result = await client.resolveSpecComments(project, number, ids);
    this.output(result, () => `resolved ${result.resolved.length} comment(s)`);
  }
}

export class SpecReviewCommand extends ProjectCommand {
  static paths = [["spec", "review"]];
  static usage = Command.Usage({
    description: "Submit a review verdict from the command line",
    details:
      "Exactly one of `--approve` / `--request-changes` is required; the " +
      "optional body becomes a summary comment. Inline comments are a web " +
      "affordance — the CLI submits verdict and summary only. `--version` " +
      "defaults to the current version; either way the server rejects a " +
      "verdict on anything but the latest (and the pusher of that version " +
      "reviewing it).",
    examples: [
      [
        "Request changes with a note",
        '$0 spec review 23 --request-changes --body "rework §2"',
      ],
    ],
  });

  number = Option.String({ required: true });
  approve = Option.Boolean("--approve", false, {
    description: "Verdict: approve",
  });
  requestChanges = Option.Boolean("--request-changes", false, {
    description: "Verdict: request changes",
  });
  body = Option.String("--body", {
    description: "Summary comment (markdown)",
  });
  bodyFile = Option.String("--body-file", {
    description: "Summary from a file, or - for stdin",
  });
  version = Option.String("--version", {
    description: "Version being reviewed (default: current)",
  });

  protected async run(client: TodouClient): Promise<void> {
    const { project, number } = this.resolveIssueRef(this.number);
    if (this.approve === this.requestChanges) {
      throw new CliError(
        "pick exactly one verdict",
        "pass --approve or --request-changes",
      );
    }
    let body: string | undefined;
    if (this.body !== undefined || this.bodyFile !== undefined) {
      body = await readBody({
        body: this.body,
        bodyFile: this.bodyFile,
        stdin: this.context.stdin,
        isTTY: false,
        env: this.context.env,
      });
    }
    const version =
      this.version === undefined
        ? (await client.getSpec(project, number)).current_version
        : Number(this.version);
    const result = await client.submitSpecReview(project, number, {
      version,
      verdict: this.approve ? "approve" : "request_changes",
      ...(body === undefined ? {} : { body }),
      comments: [],
    });
    this.output(
      result,
      () =>
        `${result.verdict === "approve" ? "approved" : "requested changes on"} spec v${result.version}`,
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
