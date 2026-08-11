import type {
  Issue,
  IssueListItem,
  IssueUpdateInput,
  TimelineItem,
  TodouClient,
} from "@todou/shared";
import { Command, Option } from "clipanion";
import { ProjectCommand } from "../api-command.ts";
import { readBody } from "../body.ts";
import { CliError } from "../errors.ts";
import { makePainter, type Painter, relativeTime, table } from "../format.ts";
import { parseChoice, parsePositiveInt } from "../parse.ts";
import {
  resolveAssignees,
  resolveClosedStatus,
  resolveLabels,
  resolveStatus,
} from "../resolve.ts";

function issueRow(issue: IssueListItem): string[] {
  return [
    `#${issue.number}`,
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

    this.output(page, () => {
      if (page.items.length === 0) return "no issues";
      const body = table(page.items.map(issueRow));
      return page.next_cursor
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
    const timeline = await fullTimeline(client, project, number);
    const paint = makePainter(this.context.stdout, this.context.env);
    this.output({ issue, timeline }, () => renderIssue(issue, timeline, paint));
  }
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
    this.output(issue, () => `#${issue.number} created: ${issue.title}`);
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
    this.output(issue, () => `#${issue.number} updated`);
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
    this.output(issue, () => `#${issue.number} closed (${target.name})`);
  }
}

function isTTY(stream: unknown): boolean {
  return Boolean((stream as { isTTY?: boolean })?.isTTY);
}

/** The whole stream, following next_cursor; --json gets items only. */
export async function fullTimeline(
  client: TodouClient,
  project: string,
  number: number,
): Promise<TimelineItem[]> {
  const items: TimelineItem[] = [];
  let after: string | undefined;
  do {
    const page = await client.getTimeline(project, number, {
      after,
      limit: 100,
    });
    items.push(...page.items);
    after = page.next_cursor ?? undefined;
  } while (after);
  return items;
}

function renderIssue(
  issue: Issue,
  timeline: TimelineItem[],
  paint: Painter,
): string {
  const lines: string[] = [];
  lines.push(`${paint("bold", `#${issue.number} ${issue.title}`)}`);
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
  if (issue.body.trim() !== "") {
    lines.push("", issue.body.trimEnd());
  }
  if (timeline.length > 0) {
    lines.push("", paint("dim", "── timeline ──"));
    for (const item of timeline) {
      lines.push(renderTimelineItem(item, paint));
    }
  }
  return lines.join("\n");
}

function renderTimelineItem(item: TimelineItem, paint: Painter): string {
  const when = relativeTime(item.created_at);
  if (item.type === "comment") {
    const body = item.body
      .trimEnd()
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
    const edited = item.edited_at ? " (edited)" : "";
    return `${paint("cyan", item.author.login)} commented${edited} ${when}:\n${body}`;
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
