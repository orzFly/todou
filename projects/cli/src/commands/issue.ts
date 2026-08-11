import type {
  Issue,
  IssueListItem,
  TimelineItem,
  TodouClient,
} from "@todou/shared";
import { Command, Option } from "clipanion";
import { ProjectCommand } from "../api-command.ts";
import { CliError } from "../errors.ts";
import { makePainter, type Painter, relativeTime, table } from "../format.ts";
import { parseChoice, parsePositiveInt } from "../parse.ts";
import { resolveAssignees, resolveLabels, resolveStatus } from "../resolve.ts";

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
  static paths = [["issue", "view"]];
  static usage = Command.Usage({
    description: "Show an issue with its full timeline",
  });

  number = Option.String({ required: true });

  protected async run(client: TodouClient): Promise<void> {
    const project = this.requireProject();
    const number = parsePositiveInt(this.number, "issue number");
    const issue = await client.getIssue(project, number);
    const timeline = await fullTimeline(client, project, number);
    const paint = makePainter(this.context.stdout, this.context.env);
    this.output({ issue, timeline }, () => renderIssue(issue, timeline, paint));
  }
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
    return `${paint("cyan", item.author.login)} commented ${when}:\n${body}`;
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
