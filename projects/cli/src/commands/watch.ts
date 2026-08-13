import type {
  ActivityItem,
  CrossActivityItem,
  TodouClient,
} from "@todou/shared";
import { formatRef, TimelineFilterType, TodouError } from "@todou/shared";
import { Command, Option } from "clipanion";
import { ProjectCommand } from "../api-command.ts";
import { CliError } from "../errors.ts";
import { makePainter } from "../format.ts";
import { drainPaged } from "../paginate.ts";
import { parseSeconds } from "../parse.ts";
import { fetchRefPrefix } from "../resolve.ts";
import {
  normalizeTypes,
  retryTransient,
  runWatchLoop,
  watchRetryOptions,
} from "../watch-loop.ts";
import { renderTimelineItem } from "./issue.ts";

export class WatchCommand extends ProjectCommand {
  static paths = [["watch"]];
  static usage = Command.Usage({
    description: "Wait for activity by others across one or more projects",
    details: `
      Like \`issue watch\`, but across every issue of one or more
      projects: prints timeline entries (each tagged with its issue
      number) that appear after \`--since <cursor>\`. \`-p a,b\` watches a
      comma-separated project list as one merged, time-ordered stream;
      \`--all-projects\` watches every project the token can read,
      re-enumerated as it runs, so projects created mid-watch join the
      stream (conflicts with -p). Entries by the current user are skipped
      unless \`--any-actor\` is set — the default answers "did anyone
      else do anything?".

      Cursors of a single-project watch are interchangeable with \`issue
      view\`/\`issue watch\` cursors of the same project, unchanged. A
      multi-project watch prints a composite cursor instead — an opaque
      envelope holding one position per project. Feed it back to a
      multi-project \`--since\` to resume every project exactly; projects
      it lacks start at the envelope's newest position. A plain
      single-project cursor is also accepted by a multi-project
      \`--since\`, as the common starting position for every watched
      project — so an \`issue view\` cursor can bootstrap a multi-project
      watch. The reverse does not hold: a composite cursor fed to a
      single-project watch (or \`issue watch\`) is rejected by the server
      as a malformed cursor. Multi-project mode needs a server with
      \`GET /activity\` (T-93); against an older server it fails with a
      clear error while single-project mode keeps working.

      Exit codes: 0 = new entries were printed (in any watched project),
      3 = nothing new (timeout or empty poll), 1 = error, 4 = gave up on
      a network outage (see below). \`--json\` emits
      \`{ items, next_cursor }\` where each item carries \`issue_number\`
      and \`project\` (its slug); feed next_cursor back into \`--since\`
      to never miss or repeat an entry.

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
        "Block until anyone else touches any issue",
        "todou watch -p todou --timeout 300",
      ],
      [
        "Watch two projects as one stream",
        "todou watch -p frontend,backend --timeout 300",
      ],
      [
        "Everything the token can see, one-shot",
        "todou watch --all-projects --poll --json",
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
      "Batch entries until this many seconds after the newest one happened (default: return immediately)",
  });
  types = Option.String("--type", {
    description: `Comma-separated filter: ${TimelineFilterType.options.join(", ")}`,
  });
  anyActor = Option.Boolean("--any-actor", false, {
    description: "Include the current user's own entries too",
  });
  allProjects = Option.Boolean("--all-projects", false, {
    description: "Watch every accessible project (conflicts with -p)",
  });

  protected async run(client: TodouClient): Promise<number> {
    const slugs = this.resolveSlugs();
    const retry = watchRetryOptions(this.poll, (line) => this.note(line));
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
    const excludeActor = this.anyActor
      ? undefined
      : (await retryTransient(() => client.me(), retry)).id;
    const paint = makePainter(this.context.stdout, this.context.env);

    if (slugs !== null && slugs.length === 1) {
      // Single-project mode: the published v0.1.0 contract — a plain
      // server cursor, interchangeable with `issue view`/`issue watch` —
      // stays untouched. (A composite --since lands on the server
      // verbatim and is rejected as malformed, loudly.) The only
      // addition is the `project` field on JSON items.
      const project = slugs[0] as string;
      const baseline =
        this.since ??
        (
          await retryTransient(
            () => client.getActivity(project, { last: true, limit: 1 }),
            retry,
          )
        ).next_cursor ??
        undefined;
      const refPrefix = this.json
        ? null
        : await fetchRefPrefix(client, project);

      return runWatchLoop<ActivityItem>({
        poll: this.poll,
        timeoutSec,
        intervalSec,
        debounceSec,
        baseline,
        retry,
        drain: (after) =>
          drainActivity(client, project, { after, types, excludeActor }),
        onItems: (items, cursor) =>
          this.output(
            {
              items: items.map((item) => ({ ...item, project })),
              next_cursor: cursor ?? null,
            },
            () =>
              [
                ...items.map(
                  (item) =>
                    `${paint("bold", formatRef(refPrefix, item.issue_number))} ${renderTimelineItem(
                      item,
                      paint,
                      { issueNumber: item.issue_number, refPrefix },
                    )}`,
                ),
                paint("dim", `cursor: ${cursor}`),
              ].join("\n"),
          ),
        onEmpty: (cursor) => this.emitEmpty(cursor, timeoutSec, paint),
      });
    }

    // Multi-project mode: a thin client over GET /activity — the server
    // fans out per project and owns the composite-cursor semantics, so
    // --since and next_cursor pass through opaquely.
    const projects = slugs?.join(",");
    const prefixes = new Map<string, string | null>();
    if (!this.json && slugs !== null) {
      for (const slug of slugs) {
        prefixes.set(slug, await fetchRefPrefix(client, slug));
      }
    }
    // Under --all-projects the watch set lives server-side, so ref
    // prefixes are fetched as slugs first appear in the stream. This runs
    // inside the drain (async context); fetchRefPrefix never throws, so
    // it cannot eat into the retry budget.
    const ensurePrefixes = async (items: CrossActivityItem[]) => {
      if (this.json) return;
      for (const item of items) {
        if (!prefixes.has(item.project)) {
          prefixes.set(
            item.project,
            await fetchRefPrefix(client, item.project),
          );
        }
      }
    };
    // A prefix-less project would spell its refs as an ambiguous "#N", so
    // the fallback spelling carries the slug; both forms resolve back as
    // issue refs on the command line.
    const spell = (item: CrossActivityItem): string => {
      const prefix = prefixes.get(item.project) ?? null;
      return prefix === null
        ? `${item.project}/${item.issue_number}`
        : formatRef(prefix, item.issue_number);
    };

    const baseline =
      this.since ??
      (
        await retryTransient(
          () =>
            client
              .getCrossActivity({ projects, last: true, limit: 1 })
              .catch(rethrow404AsHint),
          retry,
        )
      ).next_cursor ??
      undefined;

    return runWatchLoop<CrossActivityItem>({
      poll: this.poll,
      timeoutSec,
      intervalSec,
      debounceSec,
      baseline,
      retry,
      drain: async (after) => {
        const page = await drainCrossActivity(client, projects, {
          after,
          types,
          excludeActor,
        });
        await ensurePrefixes(page.items);
        return page;
      },
      onItems: (items, cursor) =>
        this.output({ items, next_cursor: cursor ?? null }, () =>
          [
            ...items.map(
              (item) =>
                `${paint("bold", spell(item))} ${renderTimelineItem(
                  item,
                  paint,
                  {
                    issueNumber: item.issue_number,
                    refPrefix: prefixes.get(item.project) ?? null,
                  },
                )}`,
            ),
            paint("dim", `cursor: ${cursor}`),
          ].join("\n"),
        ),
      onEmpty: (cursor) => this.emitEmpty(cursor, timeoutSec, paint),
    });
  }

  /**
   * The watch set: a comma-separated -p (or TODOU_PROJECT) list, or null
   * for --all-projects, where enumeration is the server's job — done per
   * request, so a long watch picks up projects created after it started.
   */
  private resolveSlugs(): string[] | null {
    if (this.allProjects) {
      if (this.project !== undefined) {
        throw new CliError(
          "--all-projects conflicts with -p/--project",
          "pass an explicit project list or the flag, not both",
        );
      }
      return null;
    }
    const slugs = [
      ...new Set(
        this.requireProject()
          .split(",")
          .map((slug) => slug.trim())
          .filter((slug) => slug !== ""),
      ),
    ];
    if (slugs.length === 0) {
      throw new CliError("-p/--project names no project");
    }
    return slugs;
  }

  private emitEmpty(
    cursor: string | undefined,
    timeoutSec: number,
    paint: ReturnType<typeof makePainter>,
  ): void {
    this.output({ items: [], next_cursor: cursor ?? null }, () =>
      [
        this.poll ? "no new activity" : `no new activity within ${timeoutSec}s`,
        ...(cursor === undefined ? [] : [paint("dim", `cursor: ${cursor}`)]),
      ].join("\n"),
    );
  }
}

/**
 * A 404 in multi-project mode is ambiguous: an unknown project in the
 * list, or a server that predates GET /activity entirely. Name both — a
 * sentinel migrating early must learn it needs a server deploy, not a
 * different cursor.
 */
function rethrow404AsHint(error: unknown): never {
  if (error instanceof TodouError && error.status === 404) {
    throw new CliError(
      error.message === "404"
        ? "GET /activity is not available on this server"
        : error.message,
      "a listed project does not exist, or the server predates multi-project watch (T-93) — single-project watch works either way",
    );
  }
  throw error;
}

/** Forward-drains the project activity stream (same shape as drainTimeline). */
async function drainActivity(
  client: TodouClient,
  project: string,
  opts: { after?: string; types?: string; excludeActor?: number },
): Promise<{ items: ActivityItem[]; cursor: string | undefined }> {
  return drainPaged("activity", opts.after, (after) =>
    client.getActivity(project, {
      after,
      types: opts.types,
      exclude_actor: opts.excludeActor,
      limit: 100,
    }),
  );
}

/** Forward-drains GET /activity across the watch set (undefined = all). */
async function drainCrossActivity(
  client: TodouClient,
  projects: string | undefined,
  opts: { after?: string; types?: string; excludeActor?: number },
): Promise<{ items: CrossActivityItem[]; cursor: string | undefined }> {
  return drainPaged("activity", opts.after, (after) =>
    client
      .getCrossActivity({
        projects,
        after,
        types: opts.types,
        exclude_actor: opts.excludeActor,
        limit: 100,
      })
      .catch(rethrow404AsHint),
  );
}
