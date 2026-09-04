import type {
  Issue,
  IssueListItem,
  IssueUpdateInput,
  Label,
  MoveIssueResult,
  TimelineItem,
  TodouClient,
} from "@todou/shared";
import {
  formatRef,
  MovedError,
  TimelineFilterType,
  TodouError,
} from "@todou/shared";
import { Command, Option } from "clipanion";
import { cursorRecord, ProjectCommand } from "../api-command.ts";
import { readBody } from "../body.ts";
import { openChangeNudges } from "../change-nudges.ts";
import { CliError } from "../errors.ts";
import {
  elision,
  makePainter,
  type Painter,
  personName,
  relativeTime,
  table,
} from "../format.ts";
import {
  parseChoice,
  parsePositiveInt,
  parseSeconds,
  splitCommaList,
} from "../parse.ts";
import { confirm } from "../prompt.ts";
import { refFormat, withRef } from "../refs.ts";
import {
  ensureLabels,
  fetchRefPrefix,
  resolveAssignees,
  resolveClosedStatus,
  resolveLabels,
  resolveStatus,
  resolveStatuses,
  shellArg,
} from "../resolve.ts";
import {
  drainTimeline,
  renderActivityLine,
  renderTimelineItem,
  tailCursor,
} from "../timeline.ts";
import {
  normalizeTypes,
  quietNote,
  type RetryOptions,
  resolveSelfFilter,
  retryTransient,
  runWatchLoop,
  type SelfFilter,
  watchMode,
  watchRetryOptions,
  watchTimeoutSec,
} from "../watch-loop.ts";
import { specVerdict } from "./spec.ts";

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
    // Logins, not display names (T-149): comma-joined names containing
    // spaces read ambiguously, and this column is what gets pasted back
    // into `--assignee`.
    issue.assignees.map((a) => a.login).join(","),
    // In the trash the useful time is when the card went in — deleting
    // deliberately leaves updated_at alone, so it would show pre-deletion
    // activity here. Everywhere else deleted_at is null and nothing changes.
    relativeTime(issue.deleted_at ?? issue.updated_at),
  ];
}

export class IssueListCommand extends ProjectCommand {
  static paths = [["issue", "list"]];
  static usage = Command.Usage({
    description: "List issues with filters",
    details:
      "gh's spellings work too: `-l/--label`, `-a/--assignee`, `-L/--limit`, `-S/--search`, and `-s/--state open|closed|all`. `--status` and the label flags are repeatable and comma-splittable (`--status Next,'In Progress'`), and match **any** of the named values — a card has one status, so several can only mean \"any of these\".",
  });

  status = Option.Array("--status", [], {
    description: "Filter by status name (repeatable; matches any)",
  });
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
  deleted = Option.Boolean("--deleted", false, {
    description: "List the trash instead (newest deletion first)",
  });

  protected async run(client: TodouClient): Promise<void> {
    const project = this.requireProject();
    const statusNames = splitCommaList(this.status);
    const pickers = [
      statusNames.length > 0,
      this.state,
      this.open,
      this.closed,
    ].filter(Boolean).length;
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

    // The protocol has taken a list here all along (`status` is csvIds
    // server-side, and the client joins arrays with commas) — the single
    // value was the CLI's own restriction.
    const status =
      statusNames.length > 0
        ? (await resolveStatuses(client, project, statusNames)).map((s) => s.id)
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
      deleted: this.deleted ? true : undefined,
    });

    const shown = this.unread
      ? { ...page, items: page.items.filter((i) => i.unread) }
      : page;

    const refPrefix = await fetchRefPrefix(client, project);
    this.output(
      {
        ...shown,
        items: shown.items.map((item) => withRef(item, refPrefix)),
        ref_format: refFormat(refPrefix),
      },
      () => {
        if (shown.items.length === 0) {
          if (this.deleted) return "the trash is empty";
          return this.unread ? "no unread issues" : "no issues";
        }
        const paint = makePainter(this.context.stdout, this.context.env);
        const body = table(shown.items.map((i) => issueRow(i, refPrefix)));
        const n = shown.items.length;
        // A count nobody has to derive: `--json | jq length` was the only way
        // to answer "how many", and it re-fetched the page to do it.
        const footer = shown.next_cursor
          ? `${n} issue${n === 1 ? "" : "s"} shown · more available (raise --limit)`
          : `${n} issue${n === 1 ? "" : "s"}`;
        return `${body}\n${paint("dim", footer)}`;
      },
    );
  }
}

/** One card as `issue view` got it: read, or the reason it could not be. */
type ViewedIssue = {
  number: number;
  /** Undefined exactly when `error` is set. */
  issue?: Issue;
  /** Empty under `--brief`, which fetches no timeline at all. */
  timeline: TimelineItem[];
  /** How many older entries `--last` cut off this card. */
  omitted: number;
  /** Where a watch on this card would resume; never set under `--brief`. */
  cursor?: string;
  /** Set when the requested address redirected here (T-231). */
  movedFrom?: string;
  error?: TodouError;
};

/** Between two cards of a batch, in `── timeline ──`'s visual language. */
const CARD_DIVIDER = "────────";

export class IssueViewCommand extends ProjectCommand {
  static paths = [
    ["issue", "view"],
    ["issue", "show"],
  ];
  static usage = Command.Usage({
    description: "Show one or more issues with their full timeline",
    details: `
      Each \`<number>\` also accepts \`<project>/<number>\` (like
      \`todou/16\`), the prefixed form \`T-16\`, or a full issue URL;
      \`issue show\` is an alias of \`issue view\`.

      A prefix is resolved to the project that holds it rather than read as
      a number in the current one. A prefix nobody holds, one several
      projects hold, or one that contradicts \`-p/--project\` is refused,
      naming what to write instead.

      **Several numbers read several cards in one call** — space-separated,
      all in the same project. They are fetched concurrently and printed in
      the order given, separated by a dim rule, each with its own cursor
      line. A number that cannot be read (deleted, never existed, no access)
      prints an error line **in its own place** and the other cards are
      printed anyway; the exit code is then 1, so a typo is never mistaken
      for a quiet card. A number repeated within one call is read once.

      Three opt-in slices cut what a card costs to read; the default is
      unchanged and still prints everything.

      \`--brief\` is the header, the status/labels/assignees line and the
      spec line — no body, no timeline. It fetches no timeline pages and
      **does not advance the read marker**: nothing was shown, so nothing
      was read. \`--timeline\` is the other half, dropping the body and
      keeping the header for context. \`--last <N>\` keeps only the newest
      N entries and says how many it dropped. One set of flags applies to
      every card of the batch.

      All three shape \`--json\` the same way they shape the human output:
      \`--brief\` emits \`{issue, ref_format}\`, and \`--last\` slices the
      \`timeline\` array. **Exactly one number keeps that shape unchanged**;
      two or more emit one document \`{items, ref_format}\` instead, where
      each item is \`{number, issue, timeline, next_cursor}\` or
      \`{number, error: {status, code, message}}\`, in the order asked for.
    `,
    examples: [
      ["Just the header and status", "$0 issue view 16 --brief"],
      ["What happened lately", "$0 issue view 16 --timeline --last 10"],
      ["Scan a whole batch at once", "$0 issue view 12 15 23 --brief"],
    ],
  });

  numbers = Option.Rest({ required: 1 });
  brief = Option.Boolean("--brief", false, {
    description: "Header and meta only — no body, no timeline",
  });
  timelineOnly = Option.Boolean("--timeline", false, {
    description: "Skip the body, keep the timeline",
  });
  last = Option.String("--last", {
    description: "Keep only the newest N timeline entries",
  });

  protected async run(client: TodouClient): Promise<number> {
    if (this.brief && this.timelineOnly) {
      throw new CliError(
        "--brief and --timeline ask for opposite halves of the card",
        "drop one — `--brief` is header+meta, `--timeline` is the timeline",
      );
    }
    if (this.brief && this.last !== undefined) {
      throw new CliError(
        "--brief prints no timeline for --last to trim",
        "use `--timeline --last N` for the newest N entries",
      );
    }
    const last =
      this.last === undefined
        ? undefined
        : parsePositiveInt(this.last, "--last");
    const { project, numbers } = await this.resolveIssueRefs(
      client,
      this.numbers,
    );

    const paint = makePainter(this.context.stdout, this.context.env);
    // Concurrent, because the whole point of a batch is not paying for it
    // card by card; the input order is restored for output either way.
    const [refPrefix, cards] = await Promise.all([
      fetchRefPrefix(client, project),
      Promise.all(numbers.map((n) => this.fetchCard(client, project, n, last))),
    ]);

    // One number is the old command, down to the byte: the failure is the
    // command's failure, and the payload keeps the shape scripts read.
    const only = cards.length === 1 ? (cards[0] as ViewedIssue) : undefined;
    if (only !== undefined) {
      if (only.error !== undefined) throw only.error;
      this.output(this.jsonCard(only, refPrefix, { envelope: true }), () =>
        this.renderCard(only, paint, refPrefix),
      );
      await this.markRead(client, project, only);
      return 0;
    }

    this.output(
      {
        items: cards.map((card) => this.jsonCard(card, refPrefix, {})),
        ref_format: refFormat(refPrefix),
      },
      () =>
        cards
          .map((card) => this.renderCard(card, paint, refPrefix))
          .join(`\n\n${paint("dim", CARD_DIVIDER)}\n\n`),
    );
    for (const card of cards) await this.markRead(client, project, card);
    return cards.some((card) => card.error !== undefined) ? 1 : 0;
  }

  /**
   * One card's payload. A `TodouError` is the card's own outcome, not the
   * batch's — anything else is a bug or an outage and is left to blow up.
   */
  private async fetchCard(
    client: TodouClient,
    project: string,
    number: number,
    last: number | undefined,
  ): Promise<ViewedIssue> {
    try {
      const issue = await client.getIssue(project, number);
      if (this.brief) return { number, issue, timeline: [], omitted: 0 };
      const { items: drained, cursor } = await drainTimeline(
        client,
        project,
        number,
      );
      const timeline = last === undefined ? drained : drained.slice(-last);
      return {
        number,
        issue,
        timeline,
        omitted: drained.length - timeline.length,
        ...(cursor === undefined ? {} : { cursor }),
      };
    } catch (error) {
      // A card that moved is still readable — at its new address. Following
      // it here rather than erroring is what makes an old ref in a script
      // keep working; the note says where it went.
      if (error instanceof MovedError) {
        const { slug, number: landed } = error.movedTo;
        const card = await this.fetchCard(client, slug, landed, last);
        return { ...card, movedFrom: `${project}/${number}` };
      }
      if (!(error instanceof TodouError)) throw error;
      return { number, timeline: [], omitted: 0, error };
    }
  }

  private renderCard(
    card: ViewedIssue,
    paint: Painter,
    refPrefix: string | null,
  ): string {
    const ref = paint("bold", formatRef(refPrefix, card.number));
    if (card.issue === undefined) {
      const error = card.error as TodouError;
      return `${ref} · error: ${error.message} (${error.status})`;
    }
    const moved =
      card.movedFrom === undefined
        ? ""
        : `${paint("dim", `moved from ${card.movedFrom}`)}\n`;
    return (
      moved +
      renderIssue(
        card.issue,
        card.timeline,
        card.cursor,
        paint,
        refPrefix,
        this.brief ? {} : { body: !this.timelineOnly, omitted: card.omitted },
      )
    );
  }

  private jsonCard(
    card: ViewedIssue,
    refPrefix: string | null,
    opts: { envelope?: boolean },
  ): Record<string, unknown> {
    const head = opts.envelope ? {} : { number: card.number };
    const tail = opts.envelope ? { ref_format: refFormat(refPrefix) } : {};
    if (card.issue === undefined) {
      const error = card.error as TodouError;
      return {
        ...head,
        error: {
          status: error.status,
          code: error.code,
          message: error.message,
        },
        ...tail,
      };
    }
    return {
      ...head,
      issue: withRef(card.issue, refPrefix),
      // `--brief` fetched no timeline, so it reports none — the same
      // omission the human output makes.
      ...(this.brief
        ? {}
        : { timeline: card.timeline, next_cursor: card.cursor ?? null }),
      ...tail,
    };
  }

  /**
   * Viewing advances the server-side read position (T-46), pinned to the
   * newest entry actually shown so anything landing after the fetch stays
   * unread. After the output on purpose, and best-effort: an old server
   * (404) or a network blip must never fail the view itself. A card that
   * failed to load, and every card under `--brief`, showed nothing and so
   * read nothing.
   */
  private async markRead(
    client: TodouClient,
    project: string,
    card: ViewedIssue,
  ): Promise<void> {
    if (this.brief || card.issue === undefined) return;
    const tail = card.timeline.at(-1)?.created_at;
    try {
      await client.markIssueRead(
        project,
        card.number,
        tail === undefined ? {} : { up_to: tail },
      );
    } catch {
      // Markers refresh on the next successful view.
    }
  }
}

export class IssueEventsCommand extends ProjectCommand {
  static paths = [["issue", "events"]];
  static usage = Command.Usage({
    description: "Show an issue's events — the timeline minus the comments",
    details: `
      \`<number>\` also accepts \`<project>/<number>\` or a full issue URL.

      The audit half of a card: who moved the status, who assigned whom,
      which spec version landed. Every line starts with \`event <id> ·\`,
      the id \`#event-<id>\` links to — spelled out because comment ids and
      event ids are separate sequences and a bare number would be
      ambiguous. The other half is \`comment list\`.

      \`--type\` takes \`issue watch\`'s spellings and filters server-side,
      \`comment\` included when that is what you want. Without it the drain
      is unfiltered and the comments are dropped here instead — asking the
      server for every event type by name would silently miss whichever
      type it learned after this CLI was built.

      Like \`issue view --brief\`, this **does not advance the read
      marker**: half a card is not a read card. \`--json\` emits one
      document — \`{events, next_cursor, ref_format}\` — not the NDJSON a
      watch streams, because this read is bounded.
    `,
    examples: [
      ["Who touched this card, and when", "$0 issue events 16"],
      ["Only the links in", "$0 issue events 16 --type referenced"],
      ["The last thing that happened", "$0 issue events 16 --last 1"],
    ],
  });

  number = Option.String({ required: true });
  types = Option.String("--type", {
    description: `Comma-separated filter: ${TimelineFilterType.options.join(", ")}`,
  });
  last = Option.String("--last", {
    description: "Keep only the newest N events",
  });

  protected async run(client: TodouClient): Promise<void> {
    const { project, number } = await this.resolveIssueRef(client, this.number);
    const last =
      this.last === undefined
        ? undefined
        : parsePositiveInt(this.last, "--last");
    const types =
      this.types === undefined ? undefined : normalizeTypes(this.types);

    const { items, cursor } = await drainTimeline(client, project, number, {
      types,
    });
    // An explicit --type is the caller's own list and is left alone; the
    // default drops exactly what `comment list` covers.
    const matched =
      types === undefined ? items.filter((i) => i.type !== "comment") : items;
    const events = last === undefined ? matched : matched.slice(-last);
    const omitted = matched.length - events.length;

    const refPrefix = await fetchRefPrefix(client, project);
    const paint = makePainter(this.context.stdout, this.context.env);
    this.output(
      {
        events,
        next_cursor: cursor ?? null,
        ref_format: refFormat(refPrefix),
      },
      () =>
        [
          ...(events.length === 0
            ? [types === undefined ? "no events" : "nothing matches --type"]
            : []),
          ...(omitted > 0 ? [paint("dim", elision(omitted, "event"))] : []),
          // "event 3", not a bare "3": comment ids and event ids are
          // separate sequences that overlap, so an unqualified number reads
          // as whichever kind the reader happened to expect. A `--type
          // comment` entry keeps the comment renderer's own head line, for
          // the same reason and in the same spelling.
          ...events.map((item) =>
            item.type === "comment"
              ? renderTimelineItem(item, paint, {
                  issueNumber: number,
                  refPrefix,
                  showId: true,
                })
              : `${paint("dim", `event ${item.id} ·`)} ${renderTimelineItem(
                  item,
                  paint,
                  { issueNumber: number, refPrefix },
                )}`,
          ),
          ...(cursor === undefined
            ? []
            : [
                paint(
                  "dim",
                  `cursor: ${cursor} (issue watch --since <cursor>)`,
                ),
              ]),
        ].join("\n"),
    );
    // No markIssueRead: like `--brief`, a slice that hides every comment
    // cannot be what marks the card read (T-183).
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
      checks once and returns immediately. Exit codes: 0 = new entries were
      printed, or a \`--poll\` finished its one check, news or not;
      3 = a blocking watch timed out with nothing new; 1 = error; 4 = gave
      up on a network outage (see below). Under \`--forever\` only 0 and 1
      remain.

      Without \`--json\` every entry prints as exactly one line —
      \`<ref> <who> <what> <when>: <summary>\` — and a comment shows the
      start of its body, so a reader of the stream sees what was said and
      not merely that something was said. \`--summary <chars>\` sets how
      much body a line carries (default 120). The batch ends with its
      \`cursor:\` line, as before.

      \`--json\` emits NDJSON: one compact JSON record per line, so a file
      this is appended to stays parseable line by line. Item lines have the
      shape they always had, and the batch ends with one
      \`{"type":"cursor","next_cursor":…,"ref_format":…}\` record; feed
      that next_cursor back into \`--since\` to never miss or repeat an
      entry, and resume from the **last** cursor record seen. An empty poll
      prints that record alone. Timeline entries carry no issue number, so
      \`ref_format\` (\`{prefix, token}\`) is where this project's ref
      spelling comes from: \`token + number\`.

      stdout carries data only — retry progress and other notes go to
      stderr — so redirect them apart (\`> feed.ndjson 2> feed.err\`)
      rather than merging them with \`2>&1\`. Migrating off the old
      \`{ items, next_cursor }\` envelope (v0.2.0):
      \`jq -r .next_cursor\` becomes
      \`jq -r 'select(.type=="cursor").next_cursor'\`, and \`jq .items[]\`
      becomes \`jq 'select(.type!="cursor")'\`; bootstrapping a cursor from
      an empty poll needs no change.

      Transient failures (connection refused/reset, timeouts, 5xx) are
      retried with exponential backoff and jitter: a blocking watch keeps
      retrying for at least ~2 minutes (14 consecutive failures — enough
      to ride out a slow deploy restart); \`--poll\` fails fast after 3.
      Exhausting the budget exits 4 — unlike 1, just rerun with the same
      \`--since\` cursor and nothing is missed or repeated.

      \`--forever\` makes the wait one trustworthy call, with no re-run loop
      around it: it never exits on a timeout and never gives up on an
      outage, so it returns only with entries (0) or a fatal error (1).
      Across every retry and every quiet phase it re-drains from the cursor
      it already holds, never a fresh "now", so entries landing in a gap are
      delivered rather than skipped. \`--timeout\` then means the heartbeat
      interval (default 600s): one \`still watching — nothing new in …\`
      line to stderr per elapsed interval, which is how a reader tells
      waiting apart from wedged. Conflicts with \`--poll\`.

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
        "todou issue watch 33 --timeout 3300 --debounce 45",
      ],
      [
        "Wait for a verdict, however long it takes",
        'todou issue watch 33 --since "$CURSOR" --debounce 60 --forever',
      ],
      [
        "Feed a script, line by line",
        'todou issue watch 33 --poll --since "$CURSOR" --json | jq -r \'select(.type=="comment").body\'',
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
  forever = Option.Boolean("--forever", false, {
    description:
      "Wait until entries arrive or a fatal error — never time out, retry outages indefinitely (conflicts with --poll)",
  });
  timeout = Option.String("--timeout", {
    description:
      "Give up after this many seconds (default 60; with --forever, seconds between heartbeats, default 600)",
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
  summary = Option.String("--summary", {
    description: "Body characters per line in text mode (default 120)",
  });

  protected async run(client: TodouClient): Promise<number> {
    const { project, number } = await this.resolveIssueRef(client, this.number);
    const mode = watchMode(this.poll, this.forever);
    const retry = watchRetryOptions(
      mode,
      (line) => this.note(line),
      this.clock,
    );
    const types =
      this.types === undefined ? undefined : normalizeTypes(this.types);
    const self = await this.resolveFilter(client, project, retry);
    const timeoutSec = watchTimeoutSec(this.timeout, mode);
    const intervalSec =
      this.interval === undefined
        ? 2
        : parseSeconds(this.interval, "--interval");
    const debounceSec =
      this.debounce === undefined
        ? undefined
        : parseSeconds(this.debounce, "--debounce");
    const summaryChars =
      this.summary === undefined
        ? 120
        : parsePositiveInt(this.summary, "--summary");

    // Baseline before the loop: the newest entry regardless of filter, so
    // "from now" never replays history. Also 404s early on a bad number.
    let baseline: string | undefined;
    try {
      baseline =
        this.since ??
        (await retryTransient(
          () => tailCursor(client, project, number),
          retry,
        )) ??
        undefined;
    } catch (error) {
      // A single-issue cursor is a row position in the source database, so
      // it cannot survive the move. Rather than follow silently and resume
      // from a position that means nothing there, hand back the new ref and
      // a cursor to re-anchor from, and let the caller decide.
      if (!(error instanceof MovedError)) throw error;
      const { slug, number: landed } = error.movedTo;
      const cursor = await arrivalCursor(client, slug, landed);
      this.output({ moved_to: error.movedTo, cursor }, () =>
        [
          `moved to ${slug}/${landed}`,
          ...(cursor === null
            ? []
            : [
                `re-anchor with: todou issue watch ${slug}/${landed} --since ${cursor}`,
              ]),
        ].join("\n"),
      );
      return 0;
    }
    const paint = makePainter(this.context.stdout, this.context.env);
    const refPrefix = await fetchRefPrefix(client, project);
    // Timeline entries carry no issue number of their own, so the envelope
    // is the only place a watcher can read the project's ref format off.
    const ref_format = refFormat(refPrefix);
    // Transport, not truth (T-123): the feed only says "there may be
    // something to pull", so the cursor, the filters and the exit codes are
    // the same code as when this polled. A watch on one card narrows the
    // feed to that card — see openChangeNudges on why an event carrying no
    // issue number still wakes us. `--poll` drains once, so a subscription
    // would be pure overhead.
    const nudges = this.poll
      ? null
      : await openChangeNudges({
          client,
          projects: new Set([project]),
          issue: number,
          intervalSec,
          clock: this.clock,
        });
    try {
      return await runWatchLoop<TimelineItem>({
        ...mode,
        timeoutSec,
        intervalSec,
        debounceSec,
        baseline,
        retry,
        clock: this.clock,
        wait: nudges?.wait,
        onQuiet: (_cursor, totalMs) =>
          this.note(quietNote("still watching", timeoutSec, totalMs)),
        drain: (after) =>
          drainTimeline(client, project, number, { after, types, ...self }),
        onItems: (items, cursor) =>
          this.outputBatch([...items, cursorRecord(cursor, ref_format)], () =>
            [
              ...items.map((item) =>
                renderActivityLine(item, paint, {
                  refLabel: formatRef(refPrefix, number),
                  issueNumber: number,
                  refPrefix,
                  summaryChars,
                }),
              ),
              paint("dim", `cursor: ${cursor}`),
            ].join("\n"),
          ),
        onEmpty: (cursor) =>
          this.outputBatch([cursorRecord(cursor, ref_format)], () =>
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
    } finally {
      nudges?.close();
    }
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

/**
 * Where a watch should resume on the card's new home: the position of the
 * arrival itself, so everything the card has done since the move is
 * delivered and its copied history is not replayed.
 */
async function arrivalCursor(
  client: TodouClient,
  project: string,
  number: number,
): Promise<string | null> {
  const page = await client.getTimeline(project, number, {
    types: "moved_in",
    last: true,
    limit: 1,
  });
  return page.next_cursor ?? null;
}

export class IssueCreateCommand extends ProjectCommand {
  static paths = [["issue", "create"]];
  static usage = Command.Usage({
    description: "Create an issue",
    details:
      "gh's short flags work too (`-t`, `-b`, `-F`, `-l`, `-a`). A `--label` the project does not have yet is created on the spot, with a color derived from its name.\n\n`issue edit`'s `--add-label`/`--add-assignee` are accepted here as plain aliases of `--label`/`--assignee` — a new issue has no existing set, so adding and setting coincide. `--remove-label`/`--remove-assignee` are refused for the same reason: there is nothing yet to remove.",
  });

  title = Option.String("-t,--title", { required: true });
  body = Option.String("-b,--body");
  bodyFile = Option.String("-F,--body-file", {
    description: "Body from a file, or - for stdin",
  });
  allowBodyPath = Option.Boolean("--allow-body-path", false, {
    description: "Post a --body that is a path as literal text",
  });
  // `--add-label` is `issue edit`'s spelling, carried over as a pure alias:
  // with no existing set to add to, "add these" and "set these" are the same
  // request, and refusing the habit only costs a retry (T-193).
  labels = Option.Array("-l,--label,--labels,--add-label,--add-labels", [], {
    description: "Repeatable and comma-splittable; unknown names are created",
  });
  assignees = Option.Array(
    "-a,--assignee,--assignees,--add-assignee,--add-assignees",
    [],
  );
  status = Option.String("--status");
  // Declared only to be refused with a pointer: clipanion's own rejection
  // ("Unsupported option name") names no alternative, and this is the other
  // half of the edit habit --add-label answers above (T-193).
  removeLabels = Option.Array("--remove-label,--remove-labels", []);
  removeAssignees = Option.Array("--remove-assignee,--remove-assignees", []);

  protected async run(client: TodouClient): Promise<void> {
    const project = this.requireProject();
    if (this.removeLabels.length > 0) {
      throw new CliError(
        "a new issue has no labels to remove",
        "--remove-label belongs to `issue edit`; on create, `--label` names the labels the issue starts with",
      );
    }
    if (this.removeAssignees.length > 0) {
      throw new CliError(
        "a new issue has no assignees to remove",
        "--remove-assignee belongs to `issue edit`; on create, `--assignee` names the assignees the issue starts with",
      );
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
    const created = withRef(issue, await fetchRefPrefix(client, project));
    this.output(created, () => `${created.ref} created: ${created.title}`);
  }
}

export class IssueEditCommand extends ProjectCommand {
  static paths = [
    ["issue", "edit"],
    ["issue", "update"],
  ];
  static usage = Command.Usage({
    description: "Edit one or more issues' fields, labels, or assignees",
    details: `
      Each \`<number>\` also accepts \`<project>/<number>\` or a full issue
      URL. \`issue update\` is an alias of \`issue edit\`; to change only the
      status there is also \`issue status <number> <status>\`.

      **Several numbers apply one set of flags to every card**, in the order
      given, all in the same project: \`issue edit 12 15 23 --status Next\`
      is the same as running the single-card edit three times. There is no
      per-card value — for different changes, make different calls — and
      \`--title\`/\`--body\` are refused outright on a batch, since one title
      across several cards has no honest use.

      A batch is **checked before it writes**: every card is read first, and
      a number that cannot be read fails the whole command with nothing
      written. Once writing starts it goes card by card in order, printing
      each \`ref updated\` as it lands, and **stops at the first failure** —
      naming the card that failed and the ones not attempted, so a rerun is
      the remaining numbers. Applying the same flags twice is a no-op, so
      rerunning the whole list is safe too.

      Two ways to write labels, and they cannot be mixed:
      \`--add-label\`/\`--remove-label\` edit the set in place (gh's flags),
      while \`--label\`/\`--labels\` **replace** it wholesale — anything not
      named is dropped, and the dropped names are printed. Both spellings
      are repeatable and comma-splittable, and any label the project does
      not have yet is created on the spot. On a batch the names are resolved
      once, but which ids each card ends up with is computed from that
      card's own current set.

      \`--json\` on a single number is unchanged (the updated issue). Two or
      more emit \`{items, ref_format}\`; a batch that fails partway emits
      \`{items, error, not_attempted, ref_format}\` and exits 1, so the
      account is complete either way.
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
      ["Move a batch along", "todou issue edit 12 15 23 --status Next"],
    ],
  });

  numbers = Option.Rest({ required: 1 });
  title = Option.String("-t,--title");
  body = Option.String("-b,--body");
  bodyFile = Option.String("-F,--body-file");
  allowBodyPath = Option.Boolean("--allow-body-path", false, {
    description: "Post a --body that is a path as literal text",
  });
  status = Option.String("--status");
  setLabels = Option.Array("-l,--label,--labels", [], {
    description: "Replace the whole label set with these",
  });
  addLabels = Option.Array("--add-label,--add-labels", []);
  removeLabels = Option.Array("--remove-label,--remove-labels", []);
  addAssignees = Option.Array("--add-assignee,--add-assignees", []);
  removeAssignees = Option.Array("--remove-assignee,--remove-assignees", []);

  protected async run(client: TodouClient): Promise<number> {
    const set = splitCommaList(this.setLabels);
    const add = splitCommaList(this.addLabels);
    const remove = splitCommaList(this.removeLabels);
    const addAssignees = splitCommaList(this.addAssignees);
    const removeAssignees = splitCommaList(this.removeAssignees);
    // Both label styles are read-modify-write — the API only takes whole
    // lists — but they answer different questions, so mixing them is
    // refused rather than resolved in some order the caller would have to
    // guess (T-135). Before any request: this is a usage error, not an
    // outcome.
    if (set.length > 0 && (add.length > 0 || remove.length > 0)) {
      throw new CliError(
        "--label/--labels replaces the whole label set; --add-label/--remove-label edit it",
        "pass one style or the other, not both",
      );
    }
    const editsLabels = set.length + add.length + remove.length > 0;
    const editsAssignees = addAssignees.length + removeAssignees.length > 0;
    const writesBody = this.body !== undefined || this.bodyFile !== undefined;

    const { project, numbers, spellings } = await this.resolveIssueRefs(
      client,
      this.numbers,
    );
    if (
      this.title === undefined &&
      !writesBody &&
      this.status === undefined &&
      !editsLabels &&
      !editsAssignees
    ) {
      throw new CliError("nothing to change", "pass at least one edit flag");
    }
    if (numbers.length > 1 && (this.title !== undefined || writesBody)) {
      throw new CliError(
        "--title/--body sets one value, and this call names several cards",
        "give them their own titles one call at a time — a batch is for status, labels and assignees",
      );
    }

    // What every card gets, resolved once however many cards there are.
    const shared: IssueUpdateInput = {};
    if (this.title !== undefined) shared.title = this.title;
    if (writesBody) {
      shared.body = await readBody({
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
    if (this.status !== undefined) {
      shared.status_id = (await resolveStatus(client, project, this.status)).id;
    }
    const note = (line: string) => this.note(line);
    const replace =
      set.length > 0 ? await ensureLabels(client, project, set, note) : null;
    const addedLabels = (await ensureLabels(client, project, add, note)).map(
      (l) => l.id,
    );
    // Removals stay strict: inventing a label just to drop it is a no-op
    // that hides the typo behind it.
    const removedLabels = new Set(
      (await resolveLabels(client, project, remove)).map((l) => l.id),
    );
    const addedPeople = await resolveAssignees(client, project, addAssignees);
    const removedPeople = new Set(
      await resolveAssignees(client, project, removeAssignees),
    );

    // Reading first buys two things: the base of every read-modify-write,
    // and — for a batch — the guarantee that a mistyped number is caught
    // before any card has an event on it. A lone card with neither
    // read-modify-write flag needs neither, and pays for neither.
    const before =
      editsLabels || editsAssignees || numbers.length > 1
        ? await this.readAll(client, project, numbers, spellings)
        : [];

    const refPrefix = await fetchRefPrefix(client, project);
    const written: Array<Issue & { ref: string }> = [];
    for (const [i, number] of numbers.entries()) {
      const current = before[i];
      const input: IssueUpdateInput = { ...shared };
      if (editsLabels && current !== undefined) {
        input.label_ids = this.labelIdsFor(current, spellings[i] ?? "", {
          project,
          replace,
          added: addedLabels,
          removed: removedLabels,
        });
      }
      if (editsAssignees && current !== undefined) {
        input.assignee_ids = [
          ...new Set([...current.assignees.map((a) => a.id), ...addedPeople]),
        ].filter((id) => !removedPeople.has(id));
      }

      let issue: Issue;
      try {
        issue = await client.updateIssue(project, number, input);
      } catch (error) {
        // One card's failure is the command's failure, worded as it always
        // was. A batch has partial work to account for instead.
        if (numbers.length === 1 || !(error instanceof TodouError)) throw error;
        return this.reportPartial(
          error,
          number,
          numbers.slice(i + 1),
          written,
          refPrefix,
        );
      }
      const row = withRef(issue, refPrefix);
      written.push(row);
      // Streamed, not collected: a batch that dies on card four has
      // already told stdout which three landed.
      if (numbers.length > 1 && !this.json) {
        this.context.stdout.write(`${row.ref} updated\n`);
      }
    }

    const single = numbers.length === 1 ? written[0] : undefined;
    if (single !== undefined) {
      this.output(single, () => `${single.ref} updated`);
      return 0;
    }
    if (this.json) {
      this.context.stdout.write(
        `${JSON.stringify(
          { items: written, ref_format: refFormat(refPrefix) },
          null,
          2,
        )}\n`,
      );
    }
    return 0;
  }

  /**
   * Every target card, or a refusal naming all the numbers that could not
   * be read. All-or-nothing on purpose: a typo in a list of a dozen must
   * not leave the first eight edited.
   */
  private async readAll(
    client: TodouClient,
    project: string,
    numbers: number[],
    spellings: string[],
  ): Promise<Issue[]> {
    const settled = await Promise.allSettled(
      numbers.map((number) => client.getIssue(project, number)),
    );
    const bad = settled.flatMap((result, i) =>
      result.status === "rejected"
        ? [{ raw: spellings[i] ?? String(numbers[i]), reason: result.reason }]
        : [],
    );
    const first = bad[0];
    if (first === undefined) {
      return settled.map((r) => (r as PromiseFulfilledResult<Issue>).value);
    }
    if (numbers.length === 1 || !(first.reason instanceof TodouError)) {
      throw first.reason;
    }
    throw new CliError(
      `cannot read ${bad.map((b) => b.raw).join(", ")}: ${first.reason.message}`,
      "nothing was written — a batch reads every card before it edits any",
    );
  }

  /** stdout gets the account, stderr the diagnosis, and the run exits 1. */
  private reportPartial(
    error: TodouError,
    number: number,
    notAttempted: number[],
    written: Array<Issue & { ref: string }>,
    refPrefix: string | null,
  ): number {
    if (this.json) {
      this.context.stdout.write(
        `${JSON.stringify(
          {
            items: written,
            error: {
              number,
              status: error.status,
              code: error.code,
              message: error.message,
            },
            not_attempted: notAttempted,
            ref_format: refFormat(refPrefix),
          },
          null,
          2,
        )}\n`,
      );
      return 1;
    }
    const rest =
      notAttempted.length === 0
        ? ""
        : `; not attempted: ${notAttempted
            .map((n) => formatRef(refPrefix, n))
            .join(", ")}`;
    throw new CliError(
      `failed on ${formatRef(refPrefix, number)}: ${error.message}${rest}`,
      notAttempted.length === 0
        ? undefined
        : "rerun with the numbers that were not attempted — the same flags twice are a no-op",
    );
  }

  /**
   * One card's new label set. Names were resolved once for the whole batch;
   * what stays per-card is which ids this card ends up with, since both
   * styles start from the set it already carries.
   */
  private labelIdsFor(
    issue: Issue,
    spelling: string,
    plan: {
      project: string;
      replace: Label[] | null;
      added: number[];
      removed: Set<number>;
    },
  ): number[] {
    if (plan.replace !== null) {
      const kept = new Set(plan.replace.map((l) => l.id));
      const dropped = issue.labels.filter((l) => !kept.has(l.id));
      if (dropped.length > 0) {
        // The flag is one agents reach for meaning "add" (T-135), so the
        // one chance to catch a mistaken wipe is the moment it happens.
        this.note(
          `--label/--labels replaces the whole label set — removed ${dropped
            .map((l) => l.name)
            .join(", ")}`,
        );
        this.note(
          `to add without replacing: todou issue edit ${spelling} -p ${plan.project} ` +
            `--add-label ${shellArg(dropped[0]?.name ?? "<name>")}`,
        );
      }
      return plan.replace.map((l) => l.id);
    }
    return [
      ...new Set([...issue.labels.map((l) => l.id), ...plan.added]),
    ].filter((id) => !plan.removed.has(id));
  }
}

/**
 * Not a third path on `IssueEditCommand`: the spelling agents reach for puts
 * the status in a second positional, and edit has only one (T-187).
 */
export class IssueStatusCommand extends ProjectCommand {
  static paths = [
    ["issue", "status"],
    ["issue", "move"],
  ];
  static usage = Command.Usage({
    description:
      "Move an issue to a status — an alias for `issue edit --status`",
    details: `
      \`<number>\` also accepts \`<project>/<number>\` or a full issue URL;
      \`issue move\` is an alias of \`issue status\`. Status names resolve
      exactly as they do on \`issue edit --status\`, and an unknown one is
      refused with the same error.

      Both positionals are required. The current status is read back with
      \`issue view --brief\`; letting a missing second argument turn this
      into a read would make writing and reading differ by nothing more
      visible than the number of arguments.
    `,
    examples: [
      ["Start work on a card", "todou issue status 16 'In Progress'"],
      ["Put it back in the queue", "todou issue move 16 Next"],
    ],
  });

  number = Option.String({ required: true });
  status = Option.String({ required: true });

  protected async run(client: TodouClient): Promise<void> {
    const { project, number } = await this.resolveIssueRef(client, this.number);
    const target = await resolveStatus(client, project, this.status);
    const issue = await client.updateIssue(project, number, {
      status_id: target.id,
    });
    const updated = withRef(issue, await fetchRefPrefix(client, project));
    this.output(updated, () => `${updated.ref} updated`);
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
    const { project, number } = await this.resolveIssueRef(client, this.number);
    const target = await resolveClosedStatus(client, project, this.status);
    if (this.comment !== undefined) {
      await client.createComment(project, number, this.comment);
    }
    const issue = await client.updateIssue(project, number, {
      status_id: target.id,
    });
    const closed = withRef(issue, await fetchRefPrefix(client, project));
    this.output(closed, () => `${closed.ref} closed (${target.name})`);
  }
}

export class IssueDeleteCommand extends ProjectCommand {
  static paths = [["issue", "delete"]];
  static usage = Command.Usage({
    description: "Move an issue to the trash",
    details:
      "Reversible — `issue restore` brings the card and everything on it back, and the number is never reused. While it is in the trash the issue is visible only to project admins and its author (`issue list --deleted`), references to it read as plain text, and every write to it is refused.\n\nPrompts unless `-y/--yes` is given, and refuses to run unprompted off a TTY. `<number>` also accepts `<project>/<number>` or a full issue URL.",
  });

  number = Option.String({ required: true });
  yes = Option.Boolean("-y,--yes", false, {
    description: "Skip the confirmation prompt",
  });

  protected async run(client: TodouClient): Promise<number> {
    const { project, number } = await this.resolveIssueRef(client, this.number);
    const issue = withRef(
      await client.getIssue(project, number),
      await fetchRefPrefix(client, project),
    );

    if (!this.yes) {
      if (!isTTY(this.context.stdin)) {
        throw new CliError(
          "refusing to delete without a confirmation",
          `pass -y/--yes: todou issue delete ${this.number} -y`,
        );
      }
      const ok = await confirm(
        this.context.stdin,
        this.context.stderr,
        `Move ${issue.ref} "${issue.title}" to the trash?`,
      );
      if (!ok) {
        this.note("cancelled");
        return 1;
      }
    }

    await client.deleteIssue(project, number);
    this.output({ ...issue, deleted: true }, () => `${issue.ref} deleted`);
    return 0;
  }
}

export class IssueTransferCommand extends ProjectCommand {
  static paths = [["issue", "transfer"]];
  static usage = Command.Usage({
    description: "Move an issue to another project",
    details:
      "The card takes a new number in the destination and its old address becomes a permanent redirect, so links to it — `#comment-N`, attachment URLs, other cards' timelines — keep working. References the card's own text wrote at the old address — a bare `#12`, a `PREFIX-12`, a `#comment-N` — are respelled once into the qualified `old-project#12` form, so they keep naming what they named; each body or comment this rewrites records a revision holding the original text and is not marked edited. Statuses map by name and fall back to the destination's default; labels and assignees the destination has no match for are dropped and reported. Moving back into a project the card has lived in before reclaims its original number.\n\nPrompts with the mapping unless `-y/--yes` is given, and refuses to run unprompted off a TTY. `<number>` also accepts `<project>/<number>`, `T-16`, or a full issue URL.\n\nA single-issue watch cursor does not survive the move: `issue watch` prints the new ref and a cursor to re-anchor from.",
  });

  number = Option.String({ required: true });
  to = Option.String("--to", { required: true, description: "Target project" });
  dryRun = Option.Boolean("--dry-run", false, {
    description: "Print the mapping and change nothing",
  });
  yes = Option.Boolean("-y,--yes", false, {
    description: "Skip the confirmation prompt",
  });

  protected async run(client: TodouClient): Promise<number> {
    const { project, number } = await this.resolveIssueRef(client, this.number);
    const prefix = await fetchRefPrefix(client, project);
    const ref = formatRef(prefix, number);

    if (this.dryRun) {
      const preview = await client.moveIssue(project, number, {
        to_project: this.to,
        dry_run: true,
      });
      this.output(preview, () =>
        [
          `${ref} would move to ${this.to}`,
          preview.moved_to.number === null
            ? "  would take a new number"
            : `  would reinhabit ${this.to}/${preview.moved_to.number}`,
          ...mappingLines(preview),
        ].join("\n"),
      );
      return 0;
    }

    if (!this.yes) {
      if (!isTTY(this.context.stdin)) {
        throw new CliError(
          "refusing to move without a confirmation",
          `pass -y/--yes: todou issue transfer ${this.number} --to ${this.to} -y`,
        );
      }
      // The preview costs one request and is the same computation the move
      // itself runs, so what is confirmed is what will happen.
      const preview = await client.moveIssue(project, number, {
        to_project: this.to,
        dry_run: true,
      });
      for (const line of mappingLines(preview)) this.note(line);
      const ok = await confirm(
        this.context.stdin,
        this.context.stderr,
        `Move ${ref} to ${this.to}?`,
      );
      if (!ok) {
        this.note("cancelled");
        return 1;
      }
    }

    const result = await client.moveIssue(project, number, {
      to_project: this.to,
      dry_run: false,
    });
    const landed = result.moved_to.number as number;
    const newPrefix = await fetchRefPrefix(client, result.moved_to.slug);
    this.output(result, () =>
      [
        `${ref} → ${result.moved_to.slug}/${landed} (${formatRef(newPrefix, landed)})`,
        ...(result.reinhabited ? ["  reinhabited its previous number"] : []),
        ...mappingLines(result),
      ].join("\n"),
    );
    return 0;
  }
}

/** The lines both the preview and the result print, in the same order. */
function mappingLines(result: MoveIssueResult): string[] {
  const lines: string[] = [];
  const { status, dropped_labels, dropped_assignees } = result.mapping;
  if (status.from !== status.to) {
    lines.push(`  status: ${status.from} → ${status.to}`);
  }
  if (dropped_labels.length > 0) {
    lines.push(`  dropped labels: ${dropped_labels.join(", ")}`);
  }
  if (dropped_assignees.length > 0) {
    lines.push(
      `  dropped assignees: ${dropped_assignees.map((u: { login: string }) => `@${u.login}`).join(", ")}`,
    );
  }
  return lines;
}

export class IssueRestoreCommand extends ProjectCommand {
  static paths = [["issue", "restore"]];
  static usage = Command.Usage({
    description: "Take an issue back out of the trash",
    details:
      "`<number>` also accepts `<project>/<number>` or a full issue URL. Restoring is not destructive, so it never prompts.",
  });

  number = Option.String({ required: true });

  protected async run(client: TodouClient): Promise<void> {
    const { project, number } = await this.resolveIssueRef(client, this.number);
    const issue = withRef(
      await client.restoreIssue(project, number),
      await fetchRefPrefix(client, project),
    );
    this.output(issue, () => `${issue.ref} restored (${issue.status.name})`);
  }
}

function isTTY(stream: unknown): boolean {
  return Boolean((stream as { isTTY?: boolean })?.isTTY);
}

/**
 * Which parts of a card `issue view` was asked for. Header and meta are not
 * optional — a slice with no card on it is not readable, whichever half was
 * wanted.
 */
type IssueSections = {
  /** Dropped by `--timeline`; `--brief` passes an empty timeline instead. */
  body?: boolean;
  /** How many older entries `--last` cut, for the elision line. */
  omitted?: number;
};

function renderIssue(
  issue: Issue,
  timeline: TimelineItem[],
  cursor: string | undefined,
  paint: Painter,
  refPrefix: string | null,
  sections: IssueSections,
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
        ? `assignees: ${issue.assignees.map(personName).join(", ")}`
        : null,
    ]
      .filter(Boolean)
      .join(" · "),
  );
  lines.push(
    paint(
      "dim",
      `opened by ${personName(issue.author)} ${relativeTime(issue.created_at)} · updated ${relativeTime(issue.updated_at)}`,
    ),
  );
  if (issue.spec_version !== null) {
    const status = specVerdict(issue.spec_review_status);
    const unresolved =
      issue.spec_unresolved_comments > 0
        ? ` · ${issue.spec_unresolved_comments} unresolved comment(s)`
        : "";
    lines.push(
      `spec: v${issue.spec_version} · ${status}${unresolved} (todou spec status/pull/comments)`,
    );
  }
  if (sections.body && issue.body.trim() !== "") {
    lines.push("", issue.body.trimEnd());
  }
  if (timeline.length > 0) {
    lines.push("", paint("dim", "── timeline ──"));
    const omitted = sections.omitted ?? 0;
    if (omitted > 0) {
      lines.push(paint("dim", elision(omitted, "entry", "entries")));
    }
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
