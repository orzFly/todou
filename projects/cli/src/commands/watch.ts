import type { ActivityItem, TodouClient } from "@todou/shared";
import { TimelineFilterType } from "@todou/shared";
import { Command, Option } from "clipanion";
import { ProjectCommand } from "../api-command.ts";
import { makePainter } from "../format.ts";
import { parseSeconds } from "../parse.ts";
import { normalizeTypes, runWatchLoop } from "../watch-loop.ts";
import { renderTimelineItem } from "./issue.ts";

export class WatchCommand extends ProjectCommand {
  static paths = [["watch"]];
  static usage = Command.Usage({
    description: "Wait for activity by others anywhere in a project",
    details: `
      Like \`issue watch\`, but across every issue of the project: prints
      timeline entries (each tagged with its issue number) that appear after
      \`--since <cursor>\`. Entries by the current user are skipped unless
      \`--any-actor\` is set — the default answers "did anyone else do
      anything?". Cursors are interchangeable with \`issue view\`/\`issue
      watch\` cursors of the same project.

      Exit codes: 0 = new entries were printed, 3 = nothing new (timeout or
      empty poll), 1 = error. \`--json\` emits \`{ items, next_cursor }\`
      where each item carries \`issue_number\`; feed next_cursor back into
      \`--since\` to never miss or repeat an entry.

      \`--debounce N\` batches a burst into one wake-up: after the first new
      entry, keep collecting for a fixed N seconds (measured from that first
      entry, never extended), then return everything at once. \`--timeout\`
      only bounds the quiet phase, so a watch that catches news right before
      the deadline still gets its full window; \`--poll\` ignores
      \`--debounce\`. Off by default — first news returns immediately.
    `,
    examples: [
      [
        "Block until anyone else touches any issue",
        "todou watch -p todou --timeout 300",
      ],
      [
        "One-shot poll for foreign comments since a cursor",
        'todou watch --poll --since "$CURSOR" --type comment',
      ],
      ["Bootstrap a cursor at now", "todou watch --poll --json"],
      [
        "Sentinel: one wake-up per burst of edits",
        "todou watch -p todou --timeout 3300 --debounce 45 --json",
      ],
    ],
  });

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
      "Batch entries for this many seconds after the first one (default: return immediately)",
  });
  types = Option.String("--type", {
    description: `Comma-separated filter: ${TimelineFilterType.options.join(", ")}`,
  });
  anyActor = Option.Boolean("--any-actor", false, {
    description: "Include the current user's own entries too",
  });

  protected async run(client: TodouClient): Promise<number> {
    const project = this.requireProject();
    const types =
      this.types === undefined ? undefined : normalizeTypes(this.types);
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
    const excludeActor = this.anyActor ? undefined : (await client.me()).id;

    const baseline =
      this.since ??
      (await client.getActivity(project, { last: true, limit: 1 }))
        .next_cursor ??
      undefined;
    const paint = makePainter(this.context.stdout, this.context.env);

    return runWatchLoop<ActivityItem>({
      poll: this.poll,
      timeoutSec,
      intervalSec,
      debounceSec,
      baseline,
      drain: (after) =>
        drainActivity(client, project, { after, types, excludeActor }),
      onItems: (items, cursor) =>
        this.output({ items, next_cursor: cursor ?? null }, () =>
          [
            ...items.map(
              (item) =>
                `${paint("bold", `#${item.issue_number}`)} ${renderTimelineItem(item, paint)}`,
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
}

/** Forward-drains the project activity stream (same shape as drainTimeline). */
async function drainActivity(
  client: TodouClient,
  project: string,
  opts: { after?: string; types?: string; excludeActor?: number },
): Promise<{ items: ActivityItem[]; cursor: string | undefined }> {
  const items: ActivityItem[] = [];
  let cursor = opts.after;
  let after = opts.after;
  do {
    const page = await client.getActivity(project, {
      after,
      types: opts.types,
      exclude_actor: opts.excludeActor,
      limit: 100,
    });
    items.push(...page.items);
    after = page.next_cursor ?? undefined;
    if (after !== undefined) cursor = after;
  } while (after);
  return { items, cursor };
}
