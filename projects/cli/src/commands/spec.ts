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
  formatRef,
  SPEC_MAX_FILE_CHARS,
  SPEC_MAX_FILES,
  SpecPushInput,
} from "@todou/shared";
import { Command, Option } from "clipanion";
import { z } from "zod";
import { readAnnotationsInput, resolveAnnotations } from "../annotations.ts";
import { ProjectCommand } from "../api-command.ts";
import { readBody } from "../body.ts";
import { CliError } from "../errors.ts";
import { makePainter, personName, plural, table } from "../format.ts";
import { drainPaged } from "../paginate.ts";
import { parseChoice, parseCommentId, parseSeconds } from "../parse.ts";
import { refFormat, withRef } from "../refs.ts";
import { fetchRefPrefix } from "../resolve.ts";
import { waitForSpecReview } from "../spec-wait.ts";
import { commentRef } from "../timeline.ts";
import { watchTimeoutSec } from "../watch-loop.ts";
import {
  assertWriteCursorFlags,
  collectWriteCursor,
  emitWriteResult,
} from "../write-cursor.ts";

/**
 * How a review verdict is worded wherever a person reads one. Shared so
 * the list, the status command and the card header cannot drift apart on
 * what `changes_requested` is called.
 */
export function specVerdict(
  status: "unreviewed" | "approved" | "changes_requested" | null,
): string {
  return {
    unreviewed: "awaiting review",
    approved: "approved",
    changes_requested: "changes requested",
  }[status ?? "unreviewed"];
}

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
    details: `
      Collects every .md under \`<dir>\` (recursively) and syncs the whole
      set as one new version: files absent from the directory are removed
      from the spec. \`<dir>\` is deliberately required — a stray push from
      a repository root must not become the spec. No difference → no new
      version. \`--if-version N\` fails with a conflict unless the current
      version is N (optimistic lock for concurrent agents).

      The push answers with the cursor to wait for the verdict from: every
      timeline entry created after it is delivered by
      \`issue watch --since <cursor>\`, the push's own event excluded. It
      is printed as the last line, sits in \`--json\` as \`cursor\`, and
      \`--print-cursor\` puts it alone on stdout with the summary moved to
      stderr — that last form is the two-line review gate:

      \`\`\`
      cursor=$(todou spec push 23 ./spec -p <proj> --message "v2" --print-cursor)
      todou issue watch 23 -p <proj> --since "$cursor" --debounce 60 --forever
      \`\`\`

      Waiting on a cursor taken *after* the push is the race this removes:
      a verdict landing in between is already in the past when the wait
      begins, and the wait never ends.

      \`--wait\` makes that whole gate one command: the push blocks from its
      own cursor until the spec has been judged, and prints how it was —
      \`approved\`, \`changes requested\` with the annotation count, or
      \`feedback\` when somebody else wrote on the card without judging
      yet. Exit 0 carries all three; only a fatal error exits 1. Everything
      \`spec wait\` documents about the wait applies unchanged, including
      that a killed wait is re-entered with \`spec wait <n> --since
      <cursor>\` — the position is the single \`cursor:\` line printed,
      which under \`--wait\` is the wait's rather than the push's.
      \`--debounce\`, \`--timeout\` and \`--interval\` tune it and mean
      nothing without it. \`--print-cursor\` conflicts: it exists to hand
      the cursor to a second command, which is the thing \`--wait\`
      replaces.

      \`--since <cursor>\` says where the pusher last looked. The push runs
      regardless; afterwards the entries between that cursor and now —
      other people's only, as watches count them — are listed on stderr
      (or as \`missed\` under \`--json\`), and the reported cursor is the
      given one echoed back, so anything shown here is delivered again by
      a watch resuming from it. \`--print-cursor\` conflicts with
      \`--json\`; both want stdout.

      \`--json\` prints the usual indented document — except under
      \`--wait\`, where the push is no longer the whole answer: the output
      becomes NDJSON, one compact record per line, opening with
      \`{"type":"push",…}\` and closing with the wait's
      \`{"type":"outcome",…}\`.
    `,
    examples: [
      [
        "Push the spec set of issue 23",
        "$0 spec push 23 ./specs/spec-feature --message 'address review'",
      ],
      [
        "Push and wait for the verdict, in one command",
        "$0 spec push 23 ./spec --message 'plan v2' --wait",
      ],
      [
        "The same gate as two commands, for a caller that wants the cursor",
        'cursor=$($0 spec push 23 ./spec --print-cursor) && $0 issue watch 23 --since "$cursor" --debounce 60 --forever',
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
  printCursor = Option.Boolean("--print-cursor", false, {
    description:
      "Print the waiting-start cursor alone on stdout, summary to stderr",
  });
  since = Option.String("--since", {
    description:
      "Report what landed since this cursor (echoed back as the cursor)",
  });
  wait = Option.Boolean("--wait", false, {
    description: "Block until the spec is judged, then print the outcome",
  });
  debounce = Option.String("--debounce", {
    description:
      "With --wait: batch a burst for this many seconds (default 60)",
  });
  timeout = Option.String("--timeout", {
    description: "With --wait: seconds between heartbeats (default 600)",
  });
  interval = Option.String("--interval", {
    description: "With --wait: seconds between server polls (default 2)",
  });

  protected async run(client: TodouClient): Promise<number | void> {
    assertWriteCursorFlags(this);
    const waitFlags = specWaitFlags(this, this.wait);
    const { project, number } = await this.resolveIssueRef(client, this.number);
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
    const outcome = await collectWriteCursor({
      client,
      project,
      number,
      served: result.cursor,
      since: this.since,
      agentContext: this.agentContext,
      note: (line) => this.note(line),
      clock: this.clock,
    });
    const paint = makePainter(this.context.stdout, this.context.env);
    emitWriteResult(
      {
        json: this.json,
        printCursor: this.printCursor,
        paint,
        // Only the missed lines spell a ref, so a push with nothing to
        // report spends no round-trip learning how.
        refPrefix: outcome.missed?.length
          ? await fetchRefPrefix(client, project)
          : null,
        issueNumber: number,
        write: (text) => this.context.stdout.write(`${text}\n`),
        note: (line) => this.note(line),
        // The wait that follows prints the position to resume from, and its
        // own is the one worth having.
        ...(this.wait ? { compact: { type: "push" }, cursorHint: null } : {}),
      },
      outcome,
      result,
      () =>
        result.unchanged
          ? `no changes — spec stays at v${result.version}`
          : [
              `spec v${result.version} pushed: ${result.added.length} added, ` +
                `${result.changed.length} changed, ${result.removed.length} removed`,
              ...changeLines(result),
            ].join("\n"),
    );
    if (!this.wait) return;
    // An unchanged push is the case that makes waiting from the state, not
    // from the event, load-bearing: no new version means the verdict on the
    // old one may already be in, and the wait has to return it rather than
    // block for a review that has happened.
    return await waitForSpecReview({
      client,
      project,
      number,
      from: outcome.cursor,
      agentContext: this.agentContext,
      ...waitFlags,
      paint,
      clock: this.clock,
      note: (line) => this.note(line),
      emitBatch: (records, human) => this.outputBatch(records, human),
    });
  }
}

/**
 * The wait's timing flags, parsed the same way for both entry points.
 * `waiting` is false on a push without `--wait`, where these name nothing at
 * all: accepting them silently would leave the caller believing it had
 * tuned a wait that never ran.
 */
function specWaitFlags(
  flags: {
    debounce: string | undefined;
    timeout: string | undefined;
    interval: string | undefined;
  },
  waiting: boolean,
): { debounceSec: number; timeoutSec: number; intervalSec: number } {
  if (!waiting) {
    const stray = (
      [
        ["--debounce", flags.debounce],
        ["--timeout", flags.timeout],
        ["--interval", flags.interval],
      ] as const
    ).find(([, value]) => value !== undefined);
    if (stray) {
      throw new CliError(
        `${stray[0]} only means something with --wait`,
        "add --wait to block until the spec is judged, or drop the flag",
      );
    }
  }
  return {
    // A review submission is one transaction, so the window is not there to
    // catch a torn review: it is there for the plain comment a reviewer
    // tends to write just before or after the verdict.
    debounceSec:
      flags.debounce === undefined
        ? 60
        : parseSeconds(flags.debounce, "--debounce", { zero: true }),
    timeoutSec: watchTimeoutSec(flags.timeout, { poll: false, forever: true }),
    intervalSec:
      flags.interval === undefined
        ? 2
        : parseSeconds(flags.interval, "--interval"),
  };
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
    const { project, number } = await this.resolveIssueRef(client, this.number);
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
    const { project, number } = await this.resolveIssueRef(client, this.number);
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
            : `resolved by ${personName(item.resolved.by)}`,
          ...(item.outdated ? ["outdated"] : []),
        ].join(", ");
        lines.push(
          `${commentRef(item.comment_id)} ${anchor} (v${item.anchor.version}) by ${personName(item.author)} · ${flags}`,
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
    const { project, number } = await this.resolveIssueRef(client, this.number);
    const ids = this.commentIds.map((raw) => parseCommentId(raw));
    const result = await client.resolveSpecComments(project, number, ids);
    this.output(result, () => `resolved ${result.resolved.length} comment(s)`);
  }
}

export class SpecReviewCommand extends ProjectCommand {
  static paths = [["spec", "review"]];
  static usage = Command.Usage({
    description: "Submit a review from the command line",
    details: `
      Exactly one of \`--approve\` / \`--request-changes\` / \`--comment\`
      is required, and \`--body\`/\`--body-file\` becomes a summary
      comment. \`--version\` defaults to the current version; either way
      the server rejects a review of anything but the latest.

      \`--comment\` is a review that **judges nothing**: it records the
      summary and the annotations and leaves the version awaiting a
      verdict. It is also the one form the account that pushed the version
      may submit — \`--approve\` and \`--request-changes\` from that
      account are refused, so agents cannot sign off their own spec. A
      \`--comment\` with neither a summary nor an annotation is refused
      too, having said nothing.

      \`--annotations <file|->\` stages inline comments, and works with any
      of the three verdicts — refusing a spec while pointing at the lines
      is the normal case. The file is a JSON array; each entry needs
      \`path\` and \`body\`, and points with exactly one of:

      - \`quote\` — the text being annotated, verbatim. It is located
        locally and must match the file exactly once, which also derives
        the columns, so the web highlights the sentence rather than the
        whole line. Two matches or none is an error before anything is
        written; a line number that slipped a paragraph would not be.
      - \`line_start\` + \`line_end\`, 1-based and inclusive, optionally
        with \`col_start\` + \`col_end\`.
      - neither, which anchors the whole file.

      Annotations always anchor to the version being reviewed. At most one
      of \`--body-file\`/\`--annotations\` may be \`-\`: stdin is a single
      stream.
    `,
    examples: [
      [
        "Request changes with a note",
        '$0 spec review 23 --request-changes --body "rework §2"',
      ],
      [
        "Read the spec, then annotate it without judging",
        '$0 spec pull 23 ./spec && $0 spec review 23 --comment --annotations ann.json --body "three spots"',
      ],
      [
        "One annotation, anchored by the text it quotes",
        `printf '%s' '[{"path":"design.md","quote":"one read-time count","body":"why not a column?"}]' | $0 spec review 23 --comment --annotations -`,
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
  comment = Option.Boolean("--comment", false, {
    description: "No verdict: annotate and comment, still awaiting review",
  });
  body = Option.String("--body", {
    description: "Summary comment (markdown)",
  });
  bodyFile = Option.String("--body-file", {
    description: "Summary from a file, or - for stdin",
  });
  annotations = Option.String("--annotations", {
    description: "Inline comments as a JSON array from a file, or - for stdin",
  });
  allowBodyPath = Option.Boolean("--allow-body-path", false, {
    description: "Post a --body that is a path as literal text",
  });
  version = Option.String("--version", {
    description: "Version being reviewed (default: current)",
  });

  protected async run(client: TodouClient): Promise<void> {
    const { project, number } = await this.resolveIssueRef(client, this.number);
    const picked = (
      [
        ["approve", this.approve],
        ["request_changes", this.requestChanges],
        ["comment", this.comment],
      ] as const
    ).filter(([, on]) => on);
    if (picked.length !== 1) {
      throw new CliError(
        "pick exactly one verdict",
        "pass --approve, --request-changes or --comment",
      );
    }
    const verdict = picked[0]?.[0] ?? "comment";
    if (this.bodyFile === "-" && this.annotations === "-") {
      throw new CliError(
        "--body-file and --annotations cannot both read stdin",
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
        cwd: this.context.cwd,
        allowBodyPath: this.allowBodyPath,
        note: (line) => this.note(line),
      });
    }
    // Read and validate before resolving the version, so a malformed file
    // costs no round trip — and before the POST, so it cannot half-submit.
    const staged =
      this.annotations === undefined
        ? []
        : await readAnnotationsInput(this.annotations, this.context.stdin);
    if (verdict === "comment" && body === undefined && staged.length === 0) {
      throw new CliError(
        "--comment says nothing without a summary or an annotation",
        "add --body/--body-file, --annotations, or a verdict",
      );
    }
    const version =
      this.version === undefined
        ? (await client.getSpec(project, number)).current_version
        : Number(this.version);
    const comments =
      staged.length === 0
        ? []
        : resolveAnnotations(
            staged,
            (await client.getSpecFiles(project, number, version)).files,
            version,
          );
    const result = await client.submitSpecReview(project, number, {
      version,
      verdict,
      ...(body === undefined ? {} : { body }),
      comments,
    });
    this.output(result, () => {
      const what = {
        approve: "approved",
        request_changes: "requested changes on",
        comment: "commented on",
      }[result.verdict];
      const n = comments.length;
      const annotated = n === 0 ? "" : ` (${n} ${plural(n, "annotation")})`;
      return `${what} spec v${result.version}${annotated}`;
    });
  }
}

export class SpecListCommand extends ProjectCommand {
  static paths = [["spec", "list"]];
  static usage = Command.Usage({
    description: "Every card in the project that carries a spec",
    details: `
      One table: ref, title, the card's status, the spec's version, the
      verdict on that version, and how many inline annotations are still
      unresolved. Newest activity first, so what an orchestration round
      wants to look at is at the top.

      **Closed cards are left out by default** — a shipped spec is
      history, not work in progress. \`--state closed\` or \`--state all\`
      is the way back to it, for an audit.

      This answers "which cards have specs at all", which is what you have
      to know before \`spec status <n>\` can tell you about one of them in
      depth. \`--json\` emits \`{items, ref_format}\`, the issue list rows
      as they come, filtered.
    `,
    examples: [
      ["Specs in flight", "$0 spec list -p <proj>"],
      ["Including shipped ones", "$0 spec list -p <proj> --state all"],
    ],
  });

  state = Option.String("-s,--state", "open", {
    description: "open | closed | all (default: open)",
  });

  protected async run(client: TodouClient): Promise<void> {
    const project = this.requireProject();
    const state = parseChoice(
      this.state.toLowerCase(),
      ["open", "closed", "all"],
      "--state",
    );

    // `spec_version` rides on every list row already (T-23's denormalized
    // fields), so the whole table is a client-side filter over pages the
    // server can serve today. A `has_spec` query parameter would be the
    // first server change this command needs, and at one or two pages of
    // open cards it would buy nothing.
    const { items } = await drainPaged("issue", undefined, (cursor) =>
      client.listIssues(project, {
        category: state === "all" ? undefined : state,
        sort: "updated",
        order: "desc",
        limit: 100,
        cursor,
      }),
    );
    const specs = items.filter((item) => item.spec_version !== null);

    const refPrefix = await fetchRefPrefix(client, project);
    this.output(
      {
        items: specs.map((item) => withRef(item, refPrefix)),
        ref_format: refFormat(refPrefix),
      },
      () => {
        const paint = makePainter(this.context.stdout, this.context.env);
        if (specs.length === 0) {
          return state === "open"
            ? `no specs\n${paint("dim", "--state all also looks at closed cards")}`
            : "no specs";
        }
        const body = table(
          specs.map((item) => [
            formatRef(refPrefix, item.number),
            item.title,
            item.status.name,
            `v${item.spec_version}`,
            specVerdict(item.spec_review_status),
            // Zero is the quiet case and reads as a column of noughts;
            // the point of the column is the cards that need attention.
            item.spec_unresolved_comments > 0
              ? `${item.spec_unresolved_comments} unresolved`
              : "",
          ]),
        );
        const n = specs.length;
        return `${body}\n${paint("dim", `${n} ${plural(n, "spec")}`)}`;
      },
    );
  }
}

export class SpecWaitCommand extends ProjectCommand {
  static paths = [["spec", "wait"]];
  static usage = Command.Usage({
    description: "Block until the spec is judged, then print the outcome",
    details: `
      The waiting half of the review loop, as one call. \`spec push --wait\`
      runs the same wait right after pushing; this command is how a wait
      that was killed — or a session taking a card over — gets back into it.

      It reads the spec's state **before** blocking, because a wait only
      ever wakes for the future: a verdict that is already in is returned
      rather than waited for. After that it watches the whole issue, with no
      type filter, so a plain comment wakes it as surely as a verdict does,
      and judges each wake-up by re-reading the state — never by reading the
      event stream.

      Three ways out, all of them exit 0, all of them ending on the outcome
      line:

      - \`approved\` — the current version carries an approve verdict. Any
        annotation still unresolved is named on the same line; it is a nit to
        fix while implementing, not a revision round.
      - \`changes requested\` — a request-changes verdict, or annotations
        outstanding on an unreviewed version, which is what a revision
        pushed without \`spec resolve\` looks like. Address them, resolve
        them, push again.
      - \`feedback\` — somebody else wrote on the card without judging it.
        Their entries print above the outcome, in \`issue watch\`'s format;
        fold them into the documents and resume the wait. A
        \`--comment\` review lands here too, and the annotations it left are
        not read-once: \`spec comments <n> --unresolved\` lists them and
        \`spec resolve\` closes them, exactly as after a verdict.

      Only a fatal error exits 1. Timeouts and outages are absorbed the way
      \`--forever\` absorbs them, and the wait reacts to the server's change
      feed where there is one, so a verdict does not sit unnoticed for a
      poll interval. \`--timeout\` is therefore the heartbeat interval
      (default 600s), written to stderr; \`--debounce\` batches a burst
      (default 60s, \`0\` returns on the first entry).

      **Where it starts matters.** Without \`--since\` the wait starts where
      the current version was pushed, not at "now": a re-entry from "now"
      would silently drop whatever was said while nobody was waiting, and
      only the verdict survives that as state. Pass \`--since\` to resume
      from a cursor you already hold — the one the last wake-up printed, or
      the push's own — and nothing is replayed twice that matters.

      This agent session's own activity never returns the command; the rest
      of the account's does. The filter used to be the whole account, which
      was safe while every review carried a verdict the pusher's account was
      barred from giving — a \`--comment\` review is not barred, and a
      sibling agent sharing the machine account is exactly who writes one.
      So a plain comment from another session of the same account (an
      orchestrator's note included) now wakes this wait, at the cost of one
      turn.
    `,
    examples: [
      ["Wait for the verdict on a card's spec", "$0 spec wait 23"],
      [
        "Re-enter a killed wait from the cursor it printed",
        '$0 spec wait 23 --since "$cursor"',
      ],
    ],
  });

  number = Option.String({ required: true });
  since = Option.String("--since", {
    description:
      "Resume from this cursor (default: where the version was pushed)",
  });
  debounce = Option.String("--debounce", {
    description: "Batch a burst for this many seconds (default 60, 0 = off)",
  });
  timeout = Option.String("--timeout", {
    description: "Seconds between heartbeats (default 600)",
  });
  interval = Option.String("--interval", {
    description: "Seconds between server polls (default 2)",
  });

  protected async run(client: TodouClient): Promise<number> {
    assertWriteCursorFlags({
      json: this.json,
      printCursor: false,
      since: this.since,
    });
    const { project, number } = await this.resolveIssueRef(client, this.number);
    return await waitForSpecReview({
      client,
      project,
      number,
      from: this.since,
      agentContext: this.agentContext,
      ...specWaitFlags(this, true),
      paint: makePainter(this.context.stdout, this.context.env),
      clock: this.clock,
      note: (line) => this.note(line),
      emitBatch: (records, human) => this.outputBatch(records, human),
    });
  }
}

export class SpecStatusCommand extends ProjectCommand {
  static paths = [["spec", "status"]];
  static usage = Command.Usage({
    description: "Spec overview: version, review state, files",
    details:
      "Errors when the issue has no spec. Under `--json` the full version " +
      "list rides along. A wait for the verdict is `spec wait <n>` (or " +
      "`spec push --wait`), which judges by reading this same state; " +
      "polling this command in place of that wait has no wake path.",
  });

  number = Option.String({ required: true });

  protected async run(client: TodouClient): Promise<void> {
    const { project, number } = await this.resolveIssueRef(client, this.number);
    const info = await client.getSpec(project, number);
    this.output(info, () => {
      const status = specVerdict(info.review_status);
      const lines = [
        `spec v${info.current_version} · ${status} · ${info.unresolved_comments} unresolved comment(s)`,
        ...info.files.map((f) => `  ${f.path} (${f.size} bytes)`),
        "versions:",
        ...info.versions.map((v) => {
          const note = v.message === null ? "" : ` — ${v.message}`;
          return `  v${v.number} by ${personName(v.author)} at ${v.created_at}${note}`;
        }),
      ];
      return lines.join("\n");
    });
  }
}
