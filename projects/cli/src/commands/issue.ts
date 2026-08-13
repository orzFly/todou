import type {
  Issue,
  IssueListItem,
  IssueUpdateInput,
  TimelineItem,
  TodouClient,
} from "@todou/shared";
import { formatRef, TimelineFilterType } from "@todou/shared";
import { Command, Option } from "clipanion";
import { ProjectCommand } from "../api-command.ts";
import { readBody } from "../body.ts";
import { CliError } from "../errors.ts";
import { makePainter, type Painter, relativeTime, table } from "../format.ts";
import { drainPaged } from "../paginate.ts";
import { parseChoice, parsePositiveInt, parseSeconds } from "../parse.ts";
import {
  decodeAnswerEvent,
  renderAnswerRecords,
  renderQuestions,
} from "../questions.ts";
import {
  fetchRefPrefix,
  resolveAssignees,
  resolveClosedStatus,
  resolveLabels,
  resolveStatus,
} from "../resolve.ts";
import {
  normalizeTypes,
  retryTransient,
  runWatchLoop,
  watchRetryOptions,
} from "../watch-loop.ts";

function issueRow(issue: IssueListItem, refPrefix: string | null): string[] {
  // Old servers omit both fields entirely; undefined reads as "not unread"
  // and the marker degrades to the plain dot (T-77). The count is exact —
  // terminal columns self-size, so the web's 99+ cap buys nothing here.
  const count = issue.unread_comments ?? 0;
  return [
    issue.unread ? (count > 0 ? `● (+${count})` : "●") : "",
    formatRef(refPrefix, issue.number),
    issue.title,
    issue.status.name,
    issue.labels.map((l) => l.name).join(","),
    issue.assignees.map((a) => a.login).join(","),
    relativeTime(issue.updated_at),
  ];
}

export class IssueListCommand extends ProjectCommand {
  static paths = [["issue", "list"]];
  static usage = Command.Usage({
    description: "List issues with filters",
  });

  status = Option.String("--status", { description: "Filter by status name" });
  open = Option.Boolean("--open", false, {
    description: "Only open-category statuses",
  });
  closed = Option.Boolean("--closed", false, {
    description: "Only closed-category statuses",
  });
  labels = Option.Array("--label", [], { description: "Filter by label name" });
  assignee = Option.String("--assignee", {
    description: "Filter by assignee login (or `me`)",
  });
  query = Option.String("-q,--query", { description: "Full-text filter" });
  limit = Option.String("--limit", { description: "Page size (1–100)" });
  sort = Option.String("--sort", "created", {
    description: "created | updated | number",
  });
  order = Option.String("--order", "desc", { description: "asc | desc" });
  unread = Option.Boolean("--unread", false, {
    description: "Only issues with unread activity by other users",
  });

  protected async run(client: TodouClient): Promise<void> {
    const project = this.requireProject();
    const pickers = [this.status, this.open, this.closed].filter(
      Boolean,
    ).length;
    if (pickers > 1) {
      throw new CliError(
        "--status, --open, and --closed are mutually exclusive",
      );
    }

    const status = this.status
      ? [(await resolveStatus(client, project, this.status)).id]
      : undefined;
    const label =
      this.labels.length > 0
        ? (await resolveLabels(client, project, this.labels)).map((l) => l.id)
        : undefined;
    const assignee = this.assignee
      ? (await resolveAssignees(client, project, [this.assignee]))[0]
      : undefined;

    const page = await client.listIssues(project, {
      status,
      label,
      assignee,
      category: this.open ? "open" : this.closed ? "closed" : undefined,
      q: this.query,
      sort: parseChoice(this.sort, ["created", "updated", "number"], "--sort"),
      order: parseChoice(this.order, ["asc", "desc"], "--order"),
      limit: this.limit ? parsePositiveInt(this.limit, "--limit") : undefined,
    });

    const shown = this.unread
      ? { ...page, items: page.items.filter((i) => i.unread) }
      : page;

    const refPrefix = this.json ? null : await fetchRefPrefix(client, project);
    this.output(shown, () => {
      if (shown.items.length === 0) {
        return this.unread ? "no unread issues" : "no issues";
      }
      const body = table(shown.items.map((i) => issueRow(i, refPrefix)));
      return shown.next_cursor
        ? `${body}\n… more available (raise --limit)`
        : body;
    });
  }
}

export class IssueViewCommand extends ProjectCommand {
  static paths = [
    ["issue", "view"],
    ["issue", "show"],
  ];
  static usage = Command.Usage({
    description: "Show an issue with its full timeline",
    details:
      "`<number>` also accepts `<project>/<number>` (like `todou/16`) or a full issue URL; `issue show` is an alias of `issue view`.",
  });

  number = Option.String({ required: true });

  protected async run(client: TodouClient): Promise<void> {
    const { project, number } = this.resolveIssueRef(this.number);
    const issue = await client.getIssue(project, number);
    const { items: timeline, cursor } = await drainTimeline(
      client,
      project,
      number,
    );
    const paint = makePainter(this.context.stdout, this.context.env);
    const refPrefix = this.json ? null : await fetchRefPrefix(client, project);
    this.output({ issue, timeline, next_cursor: cursor ?? null }, () =>
      renderIssue(issue, timeline, cursor, paint, refPrefix),
    );
    // Viewing advances the server-side read position (T-46), pinned to the
    // newest entry actually shown so anything landing after the fetch stays
    // unread. After the output on purpose, and best-effort: an old server
    // (404) or a network blip must never fail the view itself.
    const tail = timeline.at(-1)?.created_at;
    try {
      await client.markIssueRead(
        project,
        number,
        tail === undefined ? {} : { up_to: tail },
      );
    } catch {
      // Markers refresh on the next successful view.
    }
  }
}

export class IssueWatchCommand extends ProjectCommand {
  static paths = [["issue", "watch"]];
  static usage = Command.Usage({
    description: "Wait for new timeline activity on an issue",
    details: `
      Prints timeline entries that appear after \`--since <cursor>\` (cursors
      come from \`issue view --json\`, this command's own output, or a prior
      watch). Without \`--since\`, watching starts at "now" and history is
      skipped.

      Blocks until something new arrives or \`--timeout\` elapses; \`--poll\`
      checks once and returns immediately. Exit codes are loop-friendly:
      0 = new entries were printed, 3 = nothing new (timeout or empty poll),
      1 = error, 4 = gave up on a network outage (see below). \`--json\`
      emits \`{ items, next_cursor }\`; feed next_cursor back into
      \`--since\` to never miss or repeat an entry.

      Transient failures (connection refused/reset, timeouts, 5xx) are
      retried with exponential backoff and jitter: a blocking watch keeps
      retrying for at least ~2 minutes (14 consecutive failures — enough
      to ride out a slow deploy restart); \`--poll\` fails fast after 3.
      Exhausting the budget exits 4 — unlike 1, just rerun with the same
      \`--since\` cursor and nothing is missed or repeated.

      \`--debounce N\` batches a burst into one wake-up: keep collecting
      until N seconds after the newest entry of the first batch *happened*
      (its \`created_at\`, never extended), then return everything at once.
      Live entries get the full window; a resume whose \`--since\` back-fills
      old history is already past it and returns immediately. \`--timeout\`
      only bounds the quiet phase, so a watch that catches news right before
      the deadline still gets its full window; \`--poll\` ignores
      \`--debounce\`. Off by default — first news returns immediately.
    `,
    examples: [
      [
        "Wait up to 5 minutes for anything new",
        "todou issue watch 33 --timeout 300",
      ],
      [
        "One-shot poll for new comments since a cursor",
        'todou issue watch 33 --poll --since "$CURSOR" --type comment',
      ],
      ["Bootstrap a cursor at now", "todou issue watch 33 --poll --json"],
      [
        "Batch a burst of edits into one wake-up",
        "todou issue watch 33 --timeout 3300 --debounce 45 --json",
      ],
    ],
  });

  number = Option.String({ required: true });
  since = Option.String("--since", {
    description: "Only entries after this cursor (default: now)",
  });
  poll = Option.Boolean("--poll", false, {
    description: "Check once and exit instead of blocking",
  });
  timeout = Option.String("--timeout", {
    description: "Give up after this many seconds (default 60)",
  });
  interval = Option.String("--interval", {
    description: "Seconds between server polls (default 2)",
  });
  debounce = Option.String("--debounce", {
    description:
      "Batch entries until this many seconds after the newest one happened (default: return immediately)",
  });
  types = Option.String("--type", {
    description: `Comma-separated filter: ${TimelineFilterType.options.join(", ")}`,
  });
  excludeActor = Option.String("--exclude-actor", {
    description: 'Ignore entries by this login ("me" = the current token)',
  });

  protected async run(client: TodouClient): Promise<number> {
    const { project, number } = this.resolveIssueRef(this.number);
    const retry = watchRetryOptions(this.poll, (line) => this.note(line));
    const types =
      this.types === undefined ? undefined : normalizeTypes(this.types);
    const excludeActorFlag = this.excludeActor;
    const excludeActor =
      excludeActorFlag === undefined
        ? undefined
        : (
            await retryTransient(
              () => resolveAssignees(client, project, [excludeActorFlag]),
              retry,
            )
          )[0];
    const timeoutSec =
      this.timeout === undefined ? 60 : parseSeconds(this.timeout, "--timeout");
    const intervalSec =
      this.interval === undefined
        ? 2
        : parseSeconds(this.interval, "--interval");
    const debounceSec =
      this.debounce === undefined
        ? undefined
        : parseSeconds(this.debounce, "--debounce");

    // Baseline before the loop: the newest entry regardless of filter, so
    // "from now" never replays history. Also 404s early on a bad number.
    const baseline =
      this.since ??
      (await retryTransient(
        () => tailCursor(client, project, number),
        retry,
      )) ??
      undefined;
    const paint = makePainter(this.context.stdout, this.context.env);

    return runWatchLoop<TimelineItem>({
      poll: this.poll,
      timeoutSec,
      intervalSec,
      debounceSec,
      baseline,
      retry,
      drain: (after) =>
        drainTimeline(client, project, number, { after, types, excludeActor }),
      onItems: (items, cursor) =>
        this.output({ items, next_cursor: cursor ?? null }, () =>
          [
            ...items.map((item) => renderTimelineItem(item, paint)),
            paint("dim", `cursor: ${cursor}`),
          ].join("\n"),
        ),
      onEmpty: (cursor) =>
        this.output({ items: [], next_cursor: cursor ?? null }, () =>
          [
            this.poll
              ? "no new activity"
              : `no new activity within ${timeoutSec}s`,
            ...(cursor === undefined
              ? []
              : [paint("dim", `cursor: ${cursor}`)]),
          ].join("\n"),
        ),
    });
  }
}

/** Cursor of the newest timeline entry (undefined on an empty timeline). */
async function tailCursor(
  client: TodouClient,
  project: string,
  number: number,
): Promise<string | undefined> {
  const page = await client.getTimeline(project, number, {
    last: true,
    limit: 1,
  });
  return page.next_cursor ?? undefined;
}

export class IssueCreateCommand extends ProjectCommand {
  static paths = [["issue", "create"]];
  static usage = Command.Usage({ description: "Create an issue" });

  title = Option.String("--title", { required: true });
  body = Option.String("--body");
  bodyFile = Option.String("--body-file", {
    description: "Body from a file, or - for stdin",
  });
  labels = Option.Array("--label", []);
  assignees = Option.Array("--assignee", []);
  status = Option.String("--status");

  protected async run(client: TodouClient): Promise<void> {
    const project = this.requireProject();
    const body = await readBody({
      body: this.body,
      bodyFile: this.bodyFile,
      stdin: this.context.stdin,
      isTTY: isTTY(this.context.stdin),
      env: this.context.env,
    });
    const issue = await client.createIssue(project, {
      title: this.title,
      body,
      status_id: this.status
        ? (await resolveStatus(client, project, this.status)).id
        : undefined,
      label_ids: (await resolveLabels(client, project, this.labels)).map(
        (l) => l.id,
      ),
      assignee_ids: await resolveAssignees(client, project, this.assignees),
    });
    const refPrefix = this.json ? null : await fetchRefPrefix(client, project);
    this.output(
      issue,
      () => `${formatRef(refPrefix, issue.number)} created: ${issue.title}`,
    );
  }
}

export class IssueEditCommand extends ProjectCommand {
  static paths = [["issue", "edit"]];
  static usage = Command.Usage({
    description: "Edit an issue's fields, labels, or assignees",
    details:
      "`<number>` also accepts `<project>/<number>` or a full issue URL.",
  });

  number = Option.String({ required: true });
  title = Option.String("--title");
  body = Option.String("--body");
  bodyFile = Option.String("--body-file");
  status = Option.String("--status");
  addLabels = Option.Array("--add-label", []);
  removeLabels = Option.Array("--remove-label", []);
  addAssignees = Option.Array("--add-assignee", []);
  removeAssignees = Option.Array("--remove-assignee", []);

  protected async run(client: TodouClient): Promise<void> {
    const { project, number } = this.resolveIssueRef(this.number);
    const input: IssueUpdateInput = {};

    if (this.title !== undefined) input.title = this.title;
    if (this.body !== undefined || this.bodyFile !== undefined) {
      input.body = await readBody({
        body: this.body,
        bodyFile: this.bodyFile,
        stdin: this.context.stdin,
        isTTY: false,
        env: this.context.env,
      });
    }
    if (this.status !== undefined) {
      input.status_id = (await resolveStatus(client, project, this.status)).id;
    }

    // Label/assignee edits are read-modify-write: the API takes whole lists.
    if (this.addLabels.length > 0 || this.removeLabels.length > 0) {
      const current = (await client.getIssue(project, number)).labels.map(
        (l) => l.id,
      );
      const add = (await resolveLabels(client, project, this.addLabels)).map(
        (l) => l.id,
      );
      const remove = new Set(
        (await resolveLabels(client, project, this.removeLabels)).map(
          (l) => l.id,
        ),
      );
      input.label_ids = [...new Set([...current, ...add])].filter(
        (id) => !remove.has(id),
      );
    }
    if (this.addAssignees.length > 0 || this.removeAssignees.length > 0) {
      const current = (await client.getIssue(project, number)).assignees.map(
        (a) => a.id,
      );
      const add = await resolveAssignees(client, project, this.addAssignees);
      const remove = new Set(
        await resolveAssignees(client, project, this.removeAssignees),
      );
      input.assignee_ids = [...new Set([...current, ...add])].filter(
        (id) => !remove.has(id),
      );
    }

    if (Object.keys(input).length === 0) {
      throw new CliError("nothing to change", "pass at least one edit flag");
    }
    const issue = await client.updateIssue(project, number, input);
    const refPrefix = this.json ? null : await fetchRefPrefix(client, project);
    this.output(issue, () => `${formatRef(refPrefix, issue.number)} updated`);
  }
}

export class IssueCloseCommand extends ProjectCommand {
  static paths = [["issue", "close"]];
  static usage = Command.Usage({
    description: "Move an issue to a closed status",
    details:
      "`<number>` also accepts `<project>/<number>` or a full issue URL.",
  });

  number = Option.String({ required: true });
  status = Option.String("--status", {
    description: "A specific closed status (default: first by position)",
  });
  comment = Option.String("--comment", {
    description: "Leave a comment before closing",
  });

  protected async run(client: TodouClient): Promise<void> {
    const { project, number } = this.resolveIssueRef(this.number);
    const target = await resolveClosedStatus(client, project, this.status);
    if (this.comment !== undefined) {
      await client.createComment(project, number, this.comment);
    }
    const issue = await client.updateIssue(project, number, {
      status_id: target.id,
    });
    const refPrefix = this.json ? null : await fetchRefPrefix(client, project);
    this.output(
      issue,
      () => `${formatRef(refPrefix, issue.number)} closed (${target.name})`,
    );
  }
}

function isTTY(stream: unknown): boolean {
  return Boolean((stream as { isTTY?: boolean })?.isTTY);
}

/** Forward-drains one issue's timeline (cursor semantics: see drainPaged). */
export async function drainTimeline(
  client: TodouClient,
  project: string,
  number: number,
  opts: { after?: string; types?: string; excludeActor?: number } = {},
): Promise<{ items: TimelineItem[]; cursor: string | undefined }> {
  return drainPaged("timeline", opts.after, (after) =>
    client.getTimeline(project, number, {
      after,
      types: opts.types,
      exclude_actor: opts.excludeActor,
      limit: 100,
    }),
  );
}

function renderIssue(
  issue: Issue,
  timeline: TimelineItem[],
  cursor: string | undefined,
  paint: Painter,
  refPrefix: string | null,
): string {
  const lines: string[] = [];
  lines.push(
    `${paint("bold", `${formatRef(refPrefix, issue.number)} ${issue.title}`)}`,
  );
  lines.push(
    [
      `status: ${issue.status.name}`,
      issue.labels.length > 0
        ? `labels: ${issue.labels.map((l) => l.name).join(", ")}`
        : null,
      issue.assignees.length > 0
        ? `assignees: ${issue.assignees.map((a) => a.login).join(", ")}`
        : null,
    ]
      .filter(Boolean)
      .join(" · "),
  );
  lines.push(
    paint(
      "dim",
      `opened by ${issue.author.login} ${relativeTime(issue.created_at)} · updated ${relativeTime(issue.updated_at)}`,
    ),
  );
  if (issue.spec_version !== null) {
    const status = {
      unreviewed: "awaiting review",
      approved: "approved",
      changes_requested: "changes requested",
    }[issue.spec_review_status ?? "unreviewed"];
    const unresolved =
      issue.spec_unresolved_comments > 0
        ? ` · ${issue.spec_unresolved_comments} unresolved comment(s)`
        : "";
    lines.push(
      `spec: v${issue.spec_version} · ${status}${unresolved} (todou spec status/pull/comments)`,
    );
  }
  if (issue.body.trim() !== "") {
    lines.push("", issue.body.trimEnd());
  }
  if (timeline.length > 0) {
    lines.push("", paint("dim", "── timeline ──"));
    for (const item of timeline) {
      lines.push(renderTimelineItem(item, paint));
    }
  }
  if (cursor !== undefined) {
    lines.push(
      "",
      paint("dim", `cursor: ${cursor} (issue watch --since <cursor>)`),
    );
  }
  return lines.join("\n");
}

export function renderTimelineItem(item: TimelineItem, paint: Painter): string {
  const when = relativeTime(item.created_at);
  if (item.type === "comment") {
    const body = item.body
      .trimEnd()
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
    const edited = item.edited_at ? " (edited)" : "";
    const questions =
      item.component?.type === "questions"
        ? `\n${renderQuestions(item.component, paint).join("\n")}\n  ${paint(
            "dim",
            `(answer: web, or \`todou question answer <issue> ${item.id}\`)`,
          )}`
        : "";
    if (item.component?.type === "spec_comment") {
      const anchor = item.component.anchor;
      const lines =
        anchor.line_start === null
          ? "file"
          : anchor.line_end === anchor.line_start
            ? `L${anchor.line_start}`
            : `L${anchor.line_start}-${anchor.line_end}`;
      const resolved = item.resolved_at === null ? "unresolved" : "resolved";
      const quote = anchor.quote
        .split("\n")
        .map((line) => paint("dim", `  > ${line}`))
        .join("\n");
      return `${paint("cyan", item.author.login)} commented on ${anchor.path}:${lines} (v${anchor.version}, ${resolved})${edited} ${when}:\n${quote}\n${body}`;
    }
    return `${paint("cyan", item.author.login)} commented${edited} ${when}:\n${body}${questions}`;
  }
  const answered = item.type === "event" ? decodeAnswerEvent(item) : null;
  if (answered !== null) {
    return [
      `${paint("cyan", item.actor.login)} answered comment ${answered.comment_id} ${when}:`,
      ...renderAnswerRecords(answered.answers, paint),
    ].join("\n");
  }
  if (item.event_type === "title_changed") {
    return paint(
      "dim",
      `${item.actor.login} renamed "${String(item.payload.from)}" → "${String(item.payload.to)}" ${when}`,
    );
  }
  const detail = Object.entries(item.payload)
    .filter(([, v]) => typeof v === "string" || typeof v === "number")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
  return paint(
    "dim",
    `${item.actor.login} ${item.event_type}${detail ? ` (${detail})` : ""} ${when}`,
  );
}
