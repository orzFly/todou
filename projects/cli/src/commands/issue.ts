import type {
  Issue,
  IssueListItem,
  IssueUpdateInput,
  TimelineEvent,
  TimelineItem,
  TodouClient,
} from "@todou/shared";
import {
  formatRef,
  SpecPushedPayload,
  SpecReviewPayload,
  TimelineFilterType,
} from "@todou/shared";
import { Command, Option } from "clipanion";
import { ProjectCommand } from "../api-command.ts";
import { readBody } from "../body.ts";
import { CliError } from "../errors.ts";
import { makePainter, type Painter, relativeTime, table } from "../format.ts";
import { drainPaged } from "../paginate.ts";
import {
  parseChoice,
  parsePositiveInt,
  parseSeconds,
  splitCommaList,
} from "../parse.ts";
import {
  decodeAnswerEvent,
  renderAnswerRecords,
  renderQuestions,
} from "../questions.ts";
import {
  ensureLabels,
  fetchRefPrefix,
  resolveAssignees,
  resolveClosedStatus,
  resolveLabels,
  resolveStatus,
  shellArg,
} from "../resolve.ts";
import {
  normalizeTypes,
  type RetryOptions,
  resolveSelfFilter,
  retryTransient,
  runWatchLoop,
  type SelfFilter,
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
    details:
      "gh's spellings work too: `-l/--label`, `-a/--assignee`, `-L/--limit`, `-S/--search`, and `-s/--state open|closed|all`. Label flags are repeatable and comma-splittable (`--label 'area:cli,kind:bug'`), and match **any** of the named labels.",
  });

  status = Option.String("--status", { description: "Filter by status name" });
  state = Option.String("-s,--state", {
    description: "open | closed | all (gh's spelling of --open/--closed)",
  });
  open = Option.Boolean("--open", false, {
    description: "Only open-category statuses",
  });
  closed = Option.Boolean("--closed", false, {
    description: "Only closed-category statuses",
  });
  labels = Option.Array("-l,--label,--labels", [], {
    description: "Filter by label name (repeatable; matches any)",
  });
  assignee = Option.String("-a,--assignee", {
    description: "Filter by assignee login (or `me`/`@me`)",
  });
  query = Option.String("-q,-S,--query,--search", {
    description: "Full-text filter",
  });
  limit = Option.String("-L,--limit", { description: "Page size (1–100)" });
  sort = Option.String("--sort", "created", {
    description: "created | updated | number",
  });
  order = Option.String("--order", "desc", { description: "asc | desc" });
  unread = Option.Boolean("--unread", false, {
    description: "Only issues with unread activity by other users",
  });

  protected async run(client: TodouClient): Promise<void> {
    const project = this.requireProject();
    const pickers = [this.status, this.state, this.open, this.closed].filter(
      Boolean,
    ).length;
    if (pickers > 1) {
      throw new CliError(
        "--status, --state, --open, and --closed are mutually exclusive",
        "pick one — e.g. `--state open` alone, or `--status 'In Progress'` alone",
      );
    }
    const state =
      this.state === undefined
        ? undefined
        : parseChoice(
            this.state.toLowerCase(),
            ["open", "closed", "all"],
            "--state",
          );

    const status = this.status
      ? [(await resolveStatus(client, project, this.status)).id]
      : undefined;
    const labelNames = splitCommaList(this.labels);
    const label =
      labelNames.length > 0
        ? (await resolveLabels(client, project, labelNames)).map((l) => l.id)
        : undefined;
    const assignee = this.assignee
      ? (await resolveAssignees(client, project, [this.assignee]))[0]
      : undefined;

    const page = await client.listIssues(project, {
      status,
      label,
      assignee,
      category:
        this.open || state === "open"
          ? "open"
          : this.closed || state === "closed"
            ? "closed"
            : undefined,
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

      One's own entries are skipped, the same way \`todou watch\` skips
      them: "one's own" means this agent session, so sibling agents sharing
      a machine account stay visible, and entries carrying no agent session
      (the web UI, a shell without a harness) are judged by account.
      \`--any-actor\` keeps everything; \`--exclude-actor\` replaces the
      default with one named account.

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
  anyActor = Option.Boolean("--any-actor", false, {
    description: "Include one's own entries too",
  });

  protected async run(client: TodouClient): Promise<number> {
    const { project, number } = this.resolveIssueRef(this.number);
    const retry = watchRetryOptions(
      this.poll,
      (line) => this.note(line),
      this.clock,
    );
    const types =
      this.types === undefined ? undefined : normalizeTypes(this.types);
    const self = await this.resolveFilter(client, project, retry);
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
    const refPrefix = this.json ? null : await fetchRefPrefix(client, project);

    return runWatchLoop<TimelineItem>({
      poll: this.poll,
      timeoutSec,
      intervalSec,
      debounceSec,
      baseline,
      retry,
      clock: this.clock,
      drain: (after) =>
        drainTimeline(client, project, number, { after, types, ...self }),
      onItems: (items, cursor) =>
        this.output({ items, next_cursor: cursor ?? null }, () =>
          [
            ...items.map((item) =>
              renderTimelineItem(item, paint, {
                issueNumber: number,
                refPrefix,
              }),
            ),
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

  /**
   * Whose entries to drop. The default is the self-filter `todou watch`
   * uses — the two commands answered "who is me?" differently until T-121,
   * which is how an agent ended up woken by its own comment. An explicit
   * --exclude-actor names an account instead, and cannot be combined with
   * --any-actor: one asks to drop entries, the other to keep them all.
   */
  private async resolveFilter(
    client: TodouClient,
    project: string,
    retry: RetryOptions,
  ): Promise<SelfFilter> {
    const named = this.excludeActor;
    if (named !== undefined) {
      if (this.anyActor) {
        throw new CliError(
          "--any-actor conflicts with --exclude-actor",
          "pass one or the other",
        );
      }
      const [excludeActor] = await retryTransient(
        () => resolveAssignees(client, project, [named]),
        retry,
      );
      return { excludeActor };
    }
    return this.anyActor
      ? {}
      : resolveSelfFilter(client, this.agentContext, retry);
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
  static usage = Command.Usage({
    description: "Create an issue",
    details:
      "gh's short flags work too (`-t`, `-b`, `-F`, `-l`, `-a`). A `--label` the project does not have yet is created on the spot, with a color derived from its name.",
  });

  title = Option.String("-t,--title", { required: true });
  body = Option.String("-b,--body");
  bodyFile = Option.String("-F,--body-file", {
    description: "Body from a file, or - for stdin",
  });
  labels = Option.Array("-l,--label,--labels", [], {
    description: "Repeatable and comma-splittable; unknown names are created",
  });
  assignees = Option.Array("-a,--assignee,--assignees", []);
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
      label_ids: (
        await ensureLabels(client, project, splitCommaList(this.labels), (l) =>
          this.note(l),
        )
      ).map((l) => l.id),
      assignee_ids: await resolveAssignees(
        client,
        project,
        splitCommaList(this.assignees),
      ),
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
    details: `
      \`<number>\` also accepts \`<project>/<number>\` or a full issue URL.

      Two ways to write labels, and they cannot be mixed:
      \`--add-label\`/\`--remove-label\` edit the set in place (gh's flags),
      while \`--label\`/\`--labels\` **replace** it wholesale — anything not
      named is dropped, and the dropped names are printed. Both spellings
      are repeatable and comma-splittable, and any label the project does
      not have yet is created on the spot.
    `,
    examples: [
      [
        "Add one label, keep the rest",
        "todou issue edit 3 --add-label 'area:cli'",
      ],
      [
        "Make these the only labels",
        "todou issue edit 3 --labels 'area:cli,kind:bug'",
      ],
    ],
  });

  number = Option.String({ required: true });
  title = Option.String("-t,--title");
  body = Option.String("-b,--body");
  bodyFile = Option.String("-F,--body-file");
  status = Option.String("--status");
  setLabels = Option.Array("-l,--label,--labels", [], {
    description: "Replace the whole label set with these",
  });
  addLabels = Option.Array("--add-label,--add-labels", []);
  removeLabels = Option.Array("--remove-label,--remove-labels", []);
  addAssignees = Option.Array("--add-assignee,--add-assignees", []);
  removeAssignees = Option.Array("--remove-assignee,--remove-assignees", []);

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

    const labelIds = await this.resolveLabelEdit(client, project, number);
    if (labelIds !== undefined) input.label_ids = labelIds;

    // Assignee edits are read-modify-write: the API takes whole lists.
    const addAssignees = splitCommaList(this.addAssignees);
    const removeAssignees = splitCommaList(this.removeAssignees);
    if (addAssignees.length > 0 || removeAssignees.length > 0) {
      const current = (await client.getIssue(project, number)).assignees.map(
        (a) => a.id,
      );
      const add = await resolveAssignees(client, project, addAssignees);
      const remove = new Set(
        await resolveAssignees(client, project, removeAssignees),
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

  /**
   * The issue's new label set, or undefined when no label flag was passed.
   * Both styles are read-modify-write — the API only takes whole lists —
   * but they answer different questions, so mixing them is refused rather
   * than resolved in some order the caller would have to guess (T-135).
   */
  private async resolveLabelEdit(
    client: TodouClient,
    project: string,
    number: number,
  ): Promise<number[] | undefined> {
    const set = splitCommaList(this.setLabels);
    const add = splitCommaList(this.addLabels);
    const remove = splitCommaList(this.removeLabels);
    const note = (line: string) => this.note(line);

    if (set.length > 0 && (add.length > 0 || remove.length > 0)) {
      throw new CliError(
        "--label/--labels replaces the whole label set; --add-label/--remove-label edit it",
        "pass one style or the other, not both",
      );
    }
    if (set.length > 0) {
      const current = (await client.getIssue(project, number)).labels;
      const desired = await ensureLabels(client, project, set, note);
      const kept = new Set(desired.map((l) => l.id));
      const dropped = current.filter((l) => !kept.has(l.id));
      if (dropped.length > 0) {
        // The flag is one agents reach for meaning "add" (T-135), so the
        // one chance to catch a mistaken wipe is the moment it happens.
        this.note(
          `--label/--labels replaces the whole label set — removed ${dropped
            .map((l) => l.name)
            .join(", ")}`,
        );
        this.note(
          `to add without replacing: todou issue edit ${this.number} -p ${project} ` +
            `--add-label ${shellArg(dropped[0]?.name ?? "<name>")}`,
        );
      }
      return desired.map((l) => l.id);
    }
    if (add.length === 0 && remove.length === 0) return undefined;

    const current = (await client.getIssue(project, number)).labels.map(
      (l) => l.id,
    );
    const added = (await ensureLabels(client, project, add, note)).map(
      (l) => l.id,
    );
    // Removals stay strict: inventing a label just to drop it is a no-op
    // that hides the typo behind it.
    const removed = new Set(
      (await resolveLabels(client, project, remove)).map((l) => l.id),
    );
    return [...new Set([...current, ...added])].filter(
      (id) => !removed.has(id),
    );
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
  comment = Option.String("-c,--comment", {
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
  opts: { after?: string; types?: string } & SelfFilter = {},
): Promise<{ items: TimelineItem[]; cursor: string | undefined }> {
  return drainPaged("timeline", opts.after, (after) =>
    client.getTimeline(project, number, {
      after,
      types: opts.types,
      exclude_actor: opts.excludeActor,
      exclude_agent_session: opts.excludeAgentSession,
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
      lines.push(
        renderTimelineItem(item, paint, {
          issueNumber: issue.number,
          refPrefix,
        }),
      );
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

/** Where the item is being shown from, for refs and command hints. */
type TimelineRenderContext = {
  issueNumber: number;
  refPrefix: string | null;
};

export function renderTimelineItem(
  item: TimelineItem,
  paint: Painter,
  ctx: TimelineRenderContext,
): string {
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
            `(answer: web, or \`todou question answer ${ctx.issueNumber} ${item.id}\`)`,
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
  const detail = eventDetail(item, ctx);
  return paint(
    "dim",
    `${item.actor.login} ${item.event_type}${detail ? ` (${detail})` : ""} ${when}`,
  );
}

/**
 * The parenthetical after an event's type: what actually changed, plus a
 * follow-up command for spec events. Payloads are untyped over the wire,
 * so a shape this code does not recognize falls back to the scalar dump
 * instead of crashing on a newer server.
 */
function eventDetail(event: TimelineEvent, ctx: TimelineRenderContext): string {
  const payload = event.payload;
  switch (event.event_type) {
    case "closed":
    case "reopened":
    case "status_changed": {
      if (payload.from === undefined && payload.to === undefined) {
        return scalarDetail(payload);
      }
      return `${nested(payload.from, "name")} → ${nested(payload.to, "name")}`;
    }
    case "label_added":
    case "label_removed":
      return nested(payload.label, "name");
    case "assigned":
    case "unassigned":
      return `@${nested(payload.user, "login")}`;
    case "referenced":
      return typeof payload.by_issue === "number"
        ? `by ${formatRef(ctx.refPrefix, payload.by_issue)}`
        : scalarDetail(payload);
    case "attachment_added":
      return payload.attachment === undefined
        ? scalarDetail(payload)
        : nested(payload.attachment, "filename");
    case "spec_pushed": {
      const spec = SpecPushedPayload.safeParse(payload);
      if (!spec.success) return scalarDetail(payload);
      const files = (
        [
          [spec.data.added.length, "added"],
          [spec.data.changed.length, "changed"],
          [spec.data.removed.length, "removed"],
        ] as const
      )
        .filter(([n]) => n > 0)
        .map(([n, word]) => `${n} ${word}`)
        .join(", ");
      const message =
        spec.data.message === null ? "" : ` — ${spec.data.message}`;
      return `v${spec.data.version}${files ? `: ${files}` : ""}${message} · ${specPullHint(ctx, spec.data.version)}`;
    }
    case "spec_review": {
      const review = SpecReviewPayload.safeParse(payload);
      if (!review.success) return scalarDetail(payload);
      const { version, verdict, annotation_count } = review.data;
      const outcome = verdict === "approve" ? "approved" : "changes requested";
      const notes =
        annotation_count > 0 ? `, ${annotation_count} annotation(s)` : "";
      const hint =
        verdict === "approve"
          ? specPullHint(ctx, version)
          : `use \`todou spec comments ${ctx.issueNumber} --unresolved\` to view`;
      return `v${version} ${outcome}${notes} · ${hint}`;
    }
    case "spec_comments_resolved": {
      if (!Array.isArray(payload.comment_ids)) return scalarDetail(payload);
      const paths = Array.isArray(payload.paths)
        ? payload.paths.filter((p): p is string => typeof p === "string")
        : [];
      const where = paths.length > 0 ? ` on ${paths.join(", ")}` : "";
      return `${payload.comment_ids.length} annotation(s)${where}`;
    }
    default:
      return scalarDetail(payload);
  }
}

/**
 * Pinned to the entry's own version — the current version may already be
 * newer than the one this event talks about. `<empty-dir>` (rather than
 * `<dir>`) steers the reader away from a directory with existing files:
 * pull overwrites same-named files and keeps foreign .md files unless
 * --prune deletes them, and a hint should not suggest either hazard.
 */
function specPullHint(ctx: TimelineRenderContext, version: number): string {
  return `use \`todou spec pull ${ctx.issueNumber} --version ${version} <empty-dir>\` to view`;
}

/** A string field off a nested payload object; "?" mirrors the web's fallback. */
function nested(v: unknown, key: "name" | "login" | "filename"): string {
  return typeof v === "object" && v !== null && key in v
    ? String((v as Record<string, unknown>)[key])
    : "?";
}

function scalarDetail(payload: Record<string, unknown>): string {
  return Object.entries(payload)
    .filter(([, v]) => typeof v === "string" || typeof v === "number")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
}
