import type { HidePolicy, TimelineComment, TodouClient } from "@todou/shared";
import { formatRef, isHidden, MovedError } from "@todou/shared";
import { Command, Option } from "clipanion";
import { ProjectCommand } from "../api-command.ts";
import { readBody } from "../body.ts";
import { CliError } from "../errors.ts";
import {
  elision,
  makePainter,
  personName,
  plural,
  summarize,
} from "../format.ts";
import { applyHidePolicy, hideSummary } from "../hide.ts";
import { parseCommentId, parseIssueRef, parsePositiveInt } from "../parse.ts";
import { confirm } from "../prompt.ts";
import { readQuestionsInput } from "../questions.ts";
import { refFormat, withIssueRef } from "../refs.ts";
import {
  fetchRefPrefix,
  fetchRefSpelling,
  resolveAssignees,
} from "../resolve.ts";
import {
  commentRef,
  drainTimeline,
  groupHiddenRuns,
  HIDDEN_HINT,
  renderHiddenRun,
  renderTimelineItem,
  type TimelineUnit,
  unitItems,
} from "../timeline.ts";
import {
  assertWriteCursorFlags,
  collectWriteCursor,
  emitWriteResult,
} from "../write-cursor.ts";

/** Size and opening of a body, counted in code points like `summarize`. */
function bodyShape(body: string): string {
  const count = Array.from(body).length;
  return `${count} ${plural(count, "char")}: ${summarize(body, 60)}`;
}

function isTTY(stream: unknown): boolean {
  return Boolean((stream as { isTTY?: boolean })?.isTTY);
}

/**
 * The comment a whole permalink points at, fragment included — a full URL
 * or the root-relative address a stored reference carries (T-266).
 */
function permalinkCommentId(ref: string): number | undefined {
  if (!/^(https?:\/\/|\/)/i.test(ref)) return undefined;
  try {
    return parseIssueRef(ref, "issue number").commentId;
  } catch {
    return undefined;
  }
}

export class CommentAddCommand extends ProjectCommand {
  static paths = [
    ["comment", "add"],
    ["issue", "comment"],
  ];
  static usage = Command.Usage({
    description: "Comment on an issue, optionally asking questions",
    details: `
      \`<number>\` also accepts \`<project>/<number>\` or a full issue URL;
      \`issue comment\` is an alias of \`comment add\`.

      \`--questions\` attaches a questions component (T-19): a JSON array of
      \`{question, options: [{label, description?}], multiple?, key?,
      header?}\`, all text fields markdown. Validation is strict — unknown
      fields fail with their path named. Readers answer on the issue page
      (or \`todou question answer\`); block on the reply with
      \`todou question wait <issue> <commentId>\`.

      At most one of \`--body-file\`/\`--questions\` may be \`-\` — stdin is a
      single stream; process substitution (\`<(…)\`) covers the pair.

      The new comment answers with the cursor to wait for a reply from:
      every timeline entry created after it is delivered by
      \`issue watch --since <cursor>\` (and \`question wait\` needs no
      cursor at all — it checks the answer state before it blocks). It is
      printed as the last line, sits in \`--json\` as \`cursor\`, and
      \`--print-cursor\` puts it alone on stdout with the summary moved to
      stderr, for \`cursor=$(todou comment add …  --print-cursor)\`. A
      cursor taken *after* the write instead leaves a window in which the
      answer being waited for can land unseen.

      \`--since <cursor>\` says where the writer last looked. The comment
      is posted regardless; afterwards the entries between that cursor and
      now — other people's only, as watches count them — are listed on
      stderr (or as \`missed\` under \`--json\`), and the reported cursor is
      the given one echoed back, so anything shown here is delivered again
      by a watch resuming from it. \`--print-cursor\` conflicts with
      \`--json\`; both want stdout.
    `,
    examples: [
      [
        "Ask a question alongside the comment body, one call (bash/zsh)",
        // Continuations sit at column 0 on purpose: an indented heredoc
        // terminator does not terminate, so anything else fails when pasted.
        "todou comment add 19 --json --body-file <(cat <<'EOF'\n…context…\nEOF\n) --questions <(cat <<'EOF2'\n[…]\nEOF2\n)",
      ],
      [
        "Comment, then watch for the reply with no gap in between",
        'cursor=$(todou comment add 19 --body "ping" --print-cursor) && todou issue watch 19 --since "$cursor" --forever',
      ],
    ],
  });

  number = Option.String({ required: true });
  body = Option.String("--body");
  bodyFile = Option.String("--body-file", {
    description: "Body from a file, or - for stdin",
  });
  allowBodyPath = Option.Boolean("--allow-body-path", false, {
    description: "Post a --body that is a path as literal text",
  });
  questions = Option.String("--questions", {
    description: "Questions as a JSON array from a file, or - for stdin",
  });
  printCursor = Option.Boolean("--print-cursor", false, {
    description:
      "Print the waiting-start cursor alone on stdout, summary to stderr",
  });
  since = Option.String("--since", {
    description:
      "Report what landed since this cursor (echoed back as the cursor)",
  });

  protected async run(client: TodouClient): Promise<void> {
    assertWriteCursorFlags(this);
    const { project, number } = await this.resolveIssueRef(client, this.number);
    if (this.bodyFile === "-" && this.questions === "-") {
      throw new CliError("--body-file and --questions cannot both read stdin");
    }
    const body = await readBody({
      body: this.body,
      bodyFile: this.bodyFile,
      stdin: this.context.stdin,
      isTTY: isTTY(this.context.stdin),
      env: this.context.env,
      cwd: this.context.cwd,
      allowBodyPath: this.allowBodyPath,
      note: (line) => this.note(line),
    });
    const component =
      this.questions === undefined
        ? undefined
        : await readQuestionsInput(this.questions, this.context.stdin);
    const comment = await client.createComment(
      project,
      number,
      body,
      component,
    );
    const refPrefix = await fetchRefPrefix(client, project);
    const posted = withIssueRef(
      { ...comment, issue_number: number },
      refPrefix,
    );
    const outcome = await collectWriteCursor({
      client,
      project,
      number,
      served: comment.cursor,
      since: this.since,
      session: this.sessionSource(),
      note: (line) => this.note(line),
      clock: this.clock,
    });
    emitWriteResult(
      {
        json: this.json,
        printCursor: this.printCursor,
        paint: makePainter(this.context.stdout, this.context.env),
        issueNumber: number,
        write: (text) => this.context.stdout.write(`${text}\n`),
        note: (line) => this.note(line),
      },
      outcome,
      posted,
      () =>
        component === undefined
          ? // The id is the permalink anchor and `comment edit`'s argument;
            // without it here the only way to learn it was a second `--json` call.
            // The body's size and first line ride along because a body that
            // went wrong — a mistyped flag, an empty heredoc — otherwise has
            // no echo at all, and the writer is the one person who can still
            // tell (T-198).
            `${commentRef(comment.id)} on ${posted.issue_ref}` +
            ` · ${bodyShape(body)}`
          : `asked ${component.questions.length} question(s) on ${posted.issue_ref} — ` +
            `wait for answers with \`todou question wait ${number} ${comment.id}\``,
    );
  }
}

export class CommentListCommand extends ProjectCommand {
  static paths = [["comment", "list"]];
  static usage = Command.Usage({
    description: "List an issue's comments in full, each with its id",
    details: `
      \`<number>\` also accepts \`<project>/<number>\` or a full issue URL.

      The comment half of the timeline, printed whole: **bodies are never
      truncated**, and every block is headed \`#comment-<id> ·\` — the one
      spelling \`comment view/edit/delete\` takes and the web links to, so
      it pastes straight back. The other half is \`issue events\`.

      \`--author\`, \`-q\` and \`--last\` narrow the set after the timeline
      is drained, so they compose freely. Unlike \`issue view\`, this
      **does not advance the read marker**: a filtered slice is not the
      card.

      Runs of hidden comments collapse into one dim placeholder line each,
      carrying the count and the id range. \`--include-hidden\` prints them
      in full instead; \`--only-hidden\` lists just those, also in full.
      **\`-q\` cannot see into a hidden comment**: matching happens on the
      body this client was given, and a hidden one arrives empty — pass
      \`--include-hidden\` alongside it, or use \`todou search\`, which
      searches across hidden comments and marks them.

      \`--json\` emits one document — \`{comments, next_cursor,
      ref_format}\` — and \`next_cursor\` is the cursor \`issue watch
      --since\` takes.
    `,
    examples: [
      ["Everything said on the card", "$0 comment list 16"],
      ["The last thing I said", "$0 comment list 16 --author @me --last 1"],
      ["Find where a decision was made", "$0 comment list 16 -q 'migration'"],
      ["Read what was hidden", "$0 comment list 16 --only-hidden"],
    ],
  });

  number = Option.String({ required: true });
  author = Option.String("--author", {
    description: "Only comments by this login (or `me`/`@me`)",
  });
  query = Option.String("-q,--query", {
    description: "Only comments whose body contains this text",
  });
  last = Option.String("--last", {
    description: "Keep only the newest N comments",
  });
  includeHidden = Option.Boolean("--include-hidden", false, {
    description: "Print hidden comments in full instead of a placeholder",
  });
  onlyHidden = Option.Boolean("--only-hidden", false, {
    description: "Only the hidden comments, in full",
  });

  protected async run(client: TodouClient): Promise<void> {
    const { project, number } = await this.resolveIssueRef(client, this.number);
    const last =
      this.last === undefined
        ? undefined
        : parsePositiveInt(this.last, "--last");
    const author =
      this.author === undefined
        ? undefined
        : (await resolveAssignees(client, project, [this.author]))[0];
    const needle = this.query?.toLowerCase();

    // `--only-hidden` is `--include-hidden` plus a filter, not a second
    // code path: the bodies it exists to show have to be asked for.
    const wantsBodies = this.includeHidden || this.onlyHidden;
    // One unfiltered drain, then filter here: the server's `types` filter
    // has no author or full-text axis, and the timeline is bounded anyway.
    const { items, cursor } = await drainTimeline(client, project, number, {
      includeHidden: wantsBodies,
    });
    const matched = items.filter(
      (item): item is TimelineComment =>
        item.type === "comment" &&
        (!this.onlyHidden || isHidden(item)) &&
        (author === undefined || item.author.id === author) &&
        (needle === undefined || item.body.toLowerCase().includes(needle)),
    );
    const units = wantsBodies
      ? matched.map((comment) => comment as TimelineUnit)
      : groupHiddenRuns(matched);
    const kept = last === undefined ? units : units.slice(-last);
    const comments = kept.flatMap(unitItems) as TimelineComment[];
    const omitted = units.length - kept.length;

    const spelling = await fetchRefSpelling(client, project);
    const refPrefix = spelling.refPrefix;
    const paint = makePainter(this.context.stdout, this.context.env);
    const hinted = kept.some((unit) => unit.type === "hidden_run");
    this.output(
      {
        comments,
        next_cursor: cursor ?? null,
        ref_format: refFormat(refPrefix),
      },
      () =>
        [
          ...(comments.length === 0
            ? [
                items.some((i) => i.type === "comment")
                  ? "no comments match"
                  : "no comments",
              ]
            : []),
          ...(omitted > 0 ? [paint("dim", elision(omitted, "comment"))] : []),
          ...kept.map((unit) =>
            unit.type === "hidden_run"
              ? renderHiddenRun(unit, paint)
              : renderTimelineItem(unit, paint, {
                  issueNumber: number,
                  ...spelling,
                }),
          ),
          ...(cursor === undefined
            ? []
            : [
                paint(
                  "dim",
                  `cursor: ${cursor} (issue watch --since <cursor>)`,
                ),
              ]),
          ...(hinted ? [paint("dim", HIDDEN_HINT)] : []),
        ].join("\n\n"),
    );
    // No markIssueRead: the same reasoning as `issue view --brief` — what
    // was never shown was never read (T-183).
  }
}

export class CommentViewCommand extends ProjectCommand {
  static paths = [["comment", "view"]];
  static usage = Command.Usage({
    description: "Show one comment in full, by id",
    details: `
      The id comes from \`comment list\`, from what \`comment add\` echoed,
      or from a \`#comment-<id>\` permalink — which pastes in whole, so a
      link copied off the web page needs no taking apart:
      \`todou comment view <server>/projects/<proj>/issues/16#comment-123\`.

      \`--json\` is the comment object itself, \`issue_number\` and
      \`issue_ref\` alongside — the shape \`comment add\` echoes. This is
      the one place a script should reach for it: reading a body by id is
      what \`--json | jq -r .body\` is for.
    `,
    examples: [
      ["Read one comment", "$0 comment view 16 123"],
      [
        "Feed a body to a script",
        "$0 comment view 16 123 --json | jq -r .body",
      ],
    ],
  });

  number = Option.String({ required: true });
  commentId = Option.String({ required: false });

  protected async run(client: TodouClient): Promise<void> {
    const { project, number } = await this.resolveIssueRef(client, this.number);
    const commentId = this.resolveCommentId();
    const found = await this.fetchComment(client, project, number, commentId);
    const spelling = await fetchRefSpelling(client, found.project);
    const paint = makePainter(this.context.stdout, this.context.env);
    const moved =
      found.movedFrom === undefined
        ? ""
        : `${paint(
            "dim",
            `moved from ${found.movedFrom.project}/${found.movedFrom.number}` +
              `#comment-${found.movedFrom.commentId}`,
          )}\n`;
    this.output(
      withIssueRef(
        { ...found.comment, issue_number: found.number },
        spelling.refPrefix,
      ),
      () =>
        moved +
        renderTimelineItem(found.comment, paint, {
          issueNumber: found.number,
          ...spelling,
        }),
    );
  }

  /**
   * The comment, read from wherever it lives now.
   *
   * A permalink is written down and followed later, so an address the card
   * has since left must keep answering — the same call `issue view` makes
   * (T-231). Without this the CLI stopped on the 301 while the web page the
   * link came from followed it silently.
   */
  private async fetchComment(
    client: TodouClient,
    project: string,
    number: number,
    commentId: number,
  ): Promise<{
    project: string;
    number: number;
    comment: Awaited<ReturnType<TodouClient["getComment"]>>;
    movedFrom?: { project: string; number: number; commentId: number };
  }> {
    try {
      const comment = await client.getComment(project, number, commentId);
      return { project, number, comment };
    } catch (error) {
      if (!(error instanceof MovedError)) throw error;
      const to = error.movedTo;
      // A comment redirect carries the new id; an issue redirect does not,
      // and the id it was asked for belongs to the project it left.
      if (to.comment_id === undefined) {
        throw new CliError(
          `${commentRef(commentId)} is on ${project}/${number}, which moved to ${to.slug}/${to.number}`,
          `the ids are the old project's; read it there: todou comment list ${to.slug}/${to.number}`,
        );
      }
      const comment = await client.getComment(
        to.slug,
        to.number,
        to.comment_id,
      );
      return {
        project: to.slug,
        number: to.number,
        comment,
        movedFrom: { project, number, commentId },
      };
    }
  }

  /** The id argument, or the one a pasted permalink already carries. */
  private resolveCommentId(): number {
    if (this.commentId !== undefined) return parseCommentId(this.commentId);
    const anchored = permalinkCommentId(this.number);
    if (anchored !== undefined) return anchored;
    throw new CliError(
      `"${this.number}" names an issue but no comment`,
      `pass the id as a second argument (\`todou comment view ${this.number} 123\`), ` +
        "or paste the permalink whole, `#comment-<id>` fragment included",
    );
  }
}

export class CommentEditCommand extends ProjectCommand {
  static paths = [["comment", "edit"]];
  static usage = Command.Usage({
    description: "Edit a comment's body (author or project admin)",
    details:
      "`<number>` also accepts `<project>/<number>` or a full issue URL.",
  });

  number = Option.String({ required: true });
  commentId = Option.String({ required: true });
  body = Option.String("--body");
  bodyFile = Option.String("--body-file", {
    description: "Body from a file, or - for stdin",
  });
  allowBodyPath = Option.Boolean("--allow-body-path", false, {
    description: "Post a --body that is a path as literal text",
  });

  protected async run(client: TodouClient): Promise<void> {
    const { project, number } = await this.resolveIssueRef(client, this.number);
    const commentId = parseCommentId(this.commentId);
    const body = await readBody({
      body: this.body,
      bodyFile: this.bodyFile,
      stdin: this.context.stdin,
      isTTY: isTTY(this.context.stdin),
      env: this.context.env,
      cwd: this.context.cwd,
      allowBodyPath: this.allowBodyPath,
      note: (line) => this.note(line),
    });
    const comment = await client.updateComment(
      project,
      number,
      commentId,
      body,
    );
    const refPrefix = await fetchRefPrefix(client, project);
    const edited = withIssueRef(
      { ...comment, issue_number: number },
      refPrefix,
    );
    this.output(
      edited,
      () => `edited ${commentRef(commentId)} on ${edited.issue_ref}`,
    );
  }
}

export class CommentDeleteCommand extends ProjectCommand {
  static paths = [["comment", "delete"]];
  static usage = Command.Usage({
    description: "Delete a comment (author or project admin)",
    details:
      "For the comment that went to the wrong card, or the one whose body " +
      "should never have been posted. **Not reversible**: comments have no " +
      "trash the way issues do, and the edit history goes with the comment.\n\n" +
      "Prompts unless `-y/--yes` is given, and refuses to run unprompted " +
      "off a TTY. `<id>` also accepts the `#comment-<id>` spelling, and " +
      "`<number>` also accepts `<project>/<number>` or a full issue URL.",
    examples: [["Take back a misfired comment", "$0 comment delete 16 123 -y"]],
  });

  number = Option.String({ required: true });
  commentId = Option.String({ required: true });
  yes = Option.Boolean("-y,--yes", false, {
    description: "Skip the confirmation prompt",
  });

  protected async run(client: TodouClient): Promise<number> {
    const { project, number } = await this.resolveIssueRef(client, this.number);
    const commentId = parseCommentId(this.commentId);
    // Fetched before the delete, so a wrong id fails as a 404 rather than
    // as a prompt about a comment nobody can see, and so the confirmation
    // can quote what is about to go.
    const comment = await client.getComment(project, number, commentId);
    const target = withIssueRef(
      { ...comment, issue_number: number },
      await fetchRefPrefix(client, project),
    );

    if (!this.yes) {
      if (!isTTY(this.context.stdin)) {
        throw new CliError(
          "refusing to delete without a confirmation",
          `pass -y/--yes: todou comment delete ${this.number} ${this.commentId} -y`,
        );
      }
      const ok = await confirm(
        this.context.stdin,
        this.context.stderr,
        `Delete ${commentRef(commentId)} by ${personName(comment.author)} on ` +
          `${target.issue_ref}? "${summarize(comment.body, 80)}"`,
      );
      if (!ok) {
        this.note("cancelled");
        return 1;
      }
    }

    await client.deleteComment(project, number, commentId);
    this.output(
      { ...target, deleted: true },
      () => `deleted ${commentRef(commentId)} on ${target.issue_ref}`,
    );
    return 0;
  }
}

/**
 * The shared body of `comment hide` and `comment unhide`. One class rather
 * than two, because the two directions differ in a single boolean and a
 * selector that meant different things either way would be the bug (T-281).
 */
abstract class CommentHideBase extends ProjectCommand {
  /** True for `hide`, false for `unhide`. */
  protected abstract readonly hidden: boolean;

  number = Option.String({ required: true });
  ids = Option.Rest();
  to = Option.String("--to", {
    description: "Everything up to and including this comment id",
  });
  all = Option.Boolean("--all", false, {
    description: "Every comment on the card",
  });
  keepLast = Option.String("--keep-last", {
    description: "Leave the newest N comments alone (default 3)",
  });
  dryRun = Option.Boolean("--dry-run", false, {
    description: "Print what would be written, send nothing",
  });

  protected async run(client: TodouClient): Promise<number> {
    const { project, number } = await this.resolveIssueRef(client, this.number);
    const policy = this.policy();

    const outcome = await applyHidePolicy(client, project, number, policy, {
      hidden: this.hidden,
      dryRun: this.dryRun,
    });
    const issueRef = formatRef(await fetchRefPrefix(client, project), number);
    const paint = makePainter(this.context.stdout, this.context.env);
    const verb = this.hidden ? "hide" : "unhide";

    this.output(
      {
        issue_number: number,
        issue_ref: issueRef,
        hidden: this.hidden,
        dry_run: this.dryRun,
        [this.dryRun ? "would_write" : "written"]: outcome.written,
        skipped: outcome.skipped,
      },
      () =>
        this.dryRun
          ? [
              ...outcome.preview,
              paint("dim", "(dry run — nothing written)"),
            ].join("\n")
          : hideSummary(
              outcome,
              {
                hidden: this.hidden,
                issueRef,
                dryRunCommand: `todou comment ${verb} ${this.number} ${this.selectorArgs()} --dry-run`,
              },
              paint,
            ),
    );
    return 0;
  }

  /** Which selector was asked for; exactly one of the three. */
  private policy(): HidePolicy {
    const given = [
      this.ids.length > 0 ? "<id>…" : null,
      this.to === undefined ? null : "--to",
      this.all ? "--all" : null,
    ].filter((name): name is string => name !== null);
    if (given.length === 0) {
      throw new CliError(
        "nothing selected",
        "name the comment ids, or pass `--to <id>` or `--all`",
      );
    }
    if (given.length > 1) {
      throw new CliError(
        `${given.join(" and ")} select different things`,
        "pass one of them: ids name comments outright, `--to` takes " +
          "everything up to a watermark, `--all` takes the card",
      );
    }
    // Only meaningful while hiding: nothing needs holding back from being
    // read again, so `unhide` ignores it (see `selectHidable`).
    const keepLast =
      this.keepLast === undefined
        ? 3
        : parsePositiveInt(this.keepLast, "--keep-last", { zero: true });
    if (this.ids.length > 0) {
      return { by: "ids", ids: this.ids.map((id) => parseCommentId(id)) };
    }
    if (this.to !== undefined) {
      return {
        by: "up_to",
        comment_id: parseCommentId(this.to, "--to"),
        keep_last: keepLast,
      };
    }
    return { by: "all", keep_last: keepLast };
  }

  /** The selector as typed, so the `--dry-run` hint is copy-pasteable. */
  private selectorArgs(): string {
    if (this.ids.length > 0) return this.ids.join(" ");
    if (this.to !== undefined) return `--to ${this.to}`;
    return this.keepLast === undefined
      ? "--all"
      : `--all --keep-last ${this.keepLast}`;
  }
}

export class CommentHideCommand extends CommentHideBase {
  static paths = [["comment", "hide"]];
  static usage = Command.Usage({
    description: "Hide settled comments behind a counted placeholder",
    details: `
      For the card whose middle is exploration that has since reached a
      conclusion. Hidden comments keep their row in the timeline — the
      author, the timestamp and the id all stay — but a read that did not
      ask for them gets a placeholder line instead of the bodies. Nothing
      is deleted, and \`comment unhide\` puts any of it back.

      Hiding is card-level and visible to everyone; it is not a per-reader
      preference. It records no timeline event, does not move the card's
      \`updated_at\`, and does not mark anything read for anybody.

      Three selectors, one per invocation. Naming ids hides exactly those.
      \`--to <id>\` hides everything up to and including that comment.
      \`--all\` hides the card, less the newest \`--keep-last\` comments
      (3 by default, counted in comments and not in events).

      **The two selectors skip what is not settled yet**: a comment whose
      questions are unanswered, a spec annotation still unresolved, and the
      kept tail. Naming an id overrides all three — keeping one good
      comment in the middle, or putting away one answered question, is a
      decision the operator is allowed to make. \`--dry-run\` prints the
      picks and every skip with its reason, and sends nothing.
    `,
    examples: [
      ["Hide three comments by id", "$0 comment hide 16 3403 3405 3407"],
      ["Hide up to a watermark", "$0 comment hide 16 --to 3441"],
      [
        "Tidy the card, keep the tail",
        "$0 comment hide 16 --all --keep-last 3",
      ],
      ["See what that would do", "$0 comment hide 16 --all --dry-run"],
    ],
  });

  protected readonly hidden = true;
}

export class CommentUnhideCommand extends CommentHideBase {
  static paths = [["comment", "unhide"]];
  static usage = Command.Usage({
    description: "Put hidden comments back",
    details: `
      The other direction of \`comment hide\`, with the same selectors:
      ids, \`--to <id>\`, \`--all\`, and \`--dry-run\`. This is a first
      class entry rather than an undo — hiding the wrong run has to be
      reversible in one command.

      No exemptions apply here: \`--all\` picks exactly the comments that
      are hidden right now. \`--keep-last\` is accepted and ignored, since
      there is nothing to hold back from being readable again.
    `,
    examples: [
      ["Put one back", "$0 comment unhide 16 3403"],
      ["Put the whole card back", "$0 comment unhide 16 --all"],
    ],
  });

  protected readonly hidden = false;
}
