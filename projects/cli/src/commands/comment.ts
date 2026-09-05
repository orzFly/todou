import type { TimelineComment, TodouClient } from "@todou/shared";
import { MovedError } from "@todou/shared";
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
import { parseIssueRef, parsePositiveInt } from "../parse.ts";
import { confirm } from "../prompt.ts";
import { readQuestionsInput } from "../questions.ts";
import { refFormat, withIssueRef } from "../refs.ts";
import {
  fetchRefPrefix,
  fetchRefSpelling,
  resolveAssignees,
} from "../resolve.ts";
import { drainTimeline, renderTimelineItem } from "../timeline.ts";
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

/** A comment id, bare or as the web spells it in a permalink fragment. */
const COMMENT_ANCHOR = /^#?comment-(\d{1,9})$/;

/**
 * `#comment-123` is what a reader copies out of the address bar, so it has
 * to paste back in wherever the bare number goes (T-183).
 */
function parseCommentId(raw: string): number {
  return parsePositiveInt(COMMENT_ANCHOR.exec(raw)?.[1] ?? raw, "comment id");
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
      agentContext: this.agentContext,
      note: (line) => this.note(line),
      clock: this.clock,
    });
    emitWriteResult(
      {
        json: this.json,
        printCursor: this.printCursor,
        paint: makePainter(this.context.stdout, this.context.env),
        refPrefix,
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
            `comment ${comment.id} on ${posted.issue_ref} (#comment-${comment.id})` +
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
      truncated**, and every block is headed \`comment <id> ·\` — the id
      \`comment view/edit/delete\` takes and \`#comment-<id>\` links to.
      The other half is \`issue events\`.

      \`--author\`, \`-q\` and \`--last\` narrow the set after the timeline
      is drained, so they compose freely. Unlike \`issue view\`, this
      **does not advance the read marker**: a filtered slice is not the
      card.

      \`--json\` emits one document — \`{comments, next_cursor,
      ref_format}\` — and \`next_cursor\` is the cursor \`issue watch
      --since\` takes.
    `,
    examples: [
      ["Everything said on the card", "$0 comment list 16"],
      ["The last thing I said", "$0 comment list 16 --author @me --last 1"],
      ["Find where a decision was made", "$0 comment list 16 -q 'migration'"],
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

    // One unfiltered drain, then filter here: the server's `types` filter
    // has no author or full-text axis, and the timeline is bounded anyway.
    const { items, cursor } = await drainTimeline(client, project, number);
    const matched = items.filter(
      (item): item is TimelineComment =>
        item.type === "comment" &&
        (author === undefined || item.author.id === author) &&
        (needle === undefined || item.body.toLowerCase().includes(needle)),
    );
    const comments = last === undefined ? matched : matched.slice(-last);
    const omitted = matched.length - comments.length;

    const spelling = await fetchRefSpelling(client, project);
    const refPrefix = spelling.refPrefix;
    const paint = makePainter(this.context.stdout, this.context.env);
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
          ...comments.map((comment) =>
            renderTimelineItem(comment, paint, {
              issueNumber: number,
              ...spelling,
              showId: true,
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
          showId: true,
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
          `comment ${commentId} is on ${project}/${number}, which moved to ${to.slug}/${to.number}`,
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
      () => `edited comment ${commentId} on ${edited.issue_ref}`,
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
        `Delete comment ${commentId} by ${personName(comment.author)} on ` +
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
      () => `deleted comment ${commentId} on ${target.issue_ref}`,
    );
    return 0;
  }
}
