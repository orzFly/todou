import type { SearchDiagnostic, SearchItem, TodouClient } from "@todou/shared";
import { formatRef, parseSearchQuery } from "@todou/shared";
import { Command, Option } from "clipanion";
import { ProjectCommand } from "../api-command.ts";
import { makePainter, type Painter, plural, table } from "../format.ts";
import { parseChoice, parsePositiveInt, splitCommaList } from "../parse.ts";
import { refFormat, withRef } from "../refs.ts";
import {
  fetchRefPrefix,
  resolveAssignees,
  resolveLabels,
  resolveStatus,
} from "../resolve.ts";

const DOMAINS = ["issues", "comments", "specs"] as const;

/**
 * The shell already ate the user's quotes, so a term that still carries a
 * space is one they meant to keep together — it goes back in quoted, which
 * is how the server is told the same thing.
 *
 * A qualifier needs the quotes around its *value* instead: wrapping the whole
 * of `status:In Progress` would make the run start with a quote, and the
 * server would then read the entire thing as one literal phrase with the
 * qualifier silently gone.
 */
export function joinSearchTerms(terms: string[]): string {
  return terms.map(quoteSearchTerm).join(" ");
}

function quoteSearchTerm(term: string): string {
  if (!/\s/.test(term)) return term;
  const first = parseSearchQuery(term)[0];
  if (first?.kind !== "filter") return `"${term}"`;
  // One argv element that opens with a qualifier: whatever follows the colon
  // is the value the user kept together, however many spaces it has.
  const afterColon = first.keyEnd + 1;
  const value = term.slice(afterColon);
  if (value.startsWith('"')) return term;
  // A quote inside a value has no spelling in the grammar — a bare one ends
  // the value — so there is nothing to preserve by keeping it.
  return `${term.slice(0, afterColon)}"${value.replaceAll('"', "")}"`;
}

/** The snippet with every term hit picked out, ranges applied left to right. */
export function paintSnippet(
  snippet: SearchItem["snippet"],
  paint: Painter,
): string {
  let out = "";
  let at = 0;
  for (const [start, end] of snippet.ranges) {
    // Ranges arrive sorted, but two terms can overlap in the same run; the
    // second one's start is then behind the cursor and it is already painted.
    if (start < at) continue;
    out += snippet.text.slice(at, start);
    out += paint("yellow", snippet.text.slice(start, end));
    at = end;
  }
  return out + snippet.text.slice(at);
}

/** The server's sentence, plus its suggestion when it has one. */
function diagnosticLine(diagnostic: SearchDiagnostic): string {
  return diagnostic.suggestion === null
    ? diagnostic.message
    : `${diagnostic.message}; did you mean ${diagnostic.suggestion}?`;
}

/** The addressable handle for a hit: what you would read next to see it. */
function locator(item: SearchItem): string {
  if (item.kind === "comment") return `comment ${item.comment_id}`;
  if (item.kind === "spec") return `spec ${item.spec_path}`;
  return "issue";
}

export class SearchCommand extends ProjectCommand {
  static paths = [["search"], ["issue", "search"]];
  static usage = Command.Usage({
    description:
      "Search a project's issues, comments and spec documents (T-141)",
    details: `
      Terms are ANDed and each is a **case-insensitive substring** — so
      \`搜索\` finds it inside a longer run of Chinese, and \`WordDiff\`
      finds \`coalescedWordDiff\`. Quote a phrase to keep it together;
      without quotes the words may land anywhere in the same hit, and for an
      issue that means the title and the body count as one place.

      Every line is \`<ref>  <where>  <snippet>\`, where \`<where>\` is the
      id to read next — \`comment <id>\`, \`spec <path>\`, or plain
      \`issue\`. Hits are ordered by domain (issue title, then issue body,
      then comment, then spec) and then by recency.

      The query also takes qualifiers, spelled the same here and on the web
      (T-262):

      \`\`\`
      is:body|comment|spec     which unit a hit is
      state:open|closed        the card's status category
      status:<name>            the card's status
      label:<name>             a label on the card
      assignee:<login>|@me     who the card is assigned to
      harness:<agent>|none     which agent wrote the matched text
      session:<id>             which agent session wrote it
      \`\`\`

      Commas are any-of and repeating a key is all-of, so \`label:a,b\` is
      either label and \`label:a label:b\` is both. A leading \`-\` inverts
      one expression — and since that also looks like a flag, put it after
      \`--\`: \`todou search -p x -- -harness:codex 部署\`. \`harness:\` and
      \`session:\` follow **the text that matched**, not the card: a comment
      answers for whoever wrote it, a spec for whoever pushed the version, an
      issue body for whoever opened the card.

      A key nobody knows stays plain text — \`area:web\` is a label name in
      this project and \`https://…\` must keep working — so searching a known
      key literally means quoting it: \`'"harness:"'\`. A value that names
      nothing prints a \`warning:\` on stderr and matches nothing; it is not
      an error.

      \`--in\` narrows the domains, \`--status\`/\`--label\`/\`--assignee\`
      narrow exactly as they do on \`issue list\`. They intersect with
      whatever the query string says. Nothing in the trash is searchable, and
      only the newest version of a spec is. Finding nothing is not an error —
      it exits 0.
    `,
    examples: [
      ["Anywhere in the project", "$0 search 全文搜索"],
      ["Two words, any distance apart", "$0 search cursor 语义"],
      ["One phrase, exactly", '$0 search "中文分词"'],
      ["Only what was said in comments", "$0 search pg_trgm --in comments"],
      [
        "What one agent said about deployment",
        "$0 search harness:codex is:comment 部署",
      ],
      ["Open cards carrying a label", "$0 search state:open label:kind:bug 慢"],
      [
        "Everything except one agent's writing",
        "$0 search -- -harness:codex 慢",
      ],
    ],
  });

  terms = Option.Rest({ required: 1 });
  in = Option.Array("--in", [], {
    description: `Domains to search: ${DOMAINS.join(", ")} (repeatable)`,
  });
  status = Option.String("--status", { description: "Filter by status name" });
  labels = Option.Array("-l,--label,--labels", [], {
    description: "Filter by label name (repeatable; matches any)",
  });
  assignee = Option.String("-a,--assignee", {
    description: "Filter by assignee login (or `me`/`@me`)",
  });
  limit = Option.String("-L,--limit", { description: "Page size (1–100)" });

  protected async run(client: TodouClient): Promise<void> {
    const project = this.requireProject();
    const domains = splitCommaList(this.in).map((d) =>
      parseChoice(d, DOMAINS, "--in"),
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

    const page = await client.search(project, {
      q: joinSearchTerms(this.terms),
      in: domains.length > 0 ? domains.join(",") : undefined,
      status,
      label,
      assignee,
      limit: this.limit ? parsePositiveInt(this.limit, "--limit") : undefined,
    });

    // Ahead of the results and on stderr, so a piped `todou search` still
    // yields only hits while the reader is told which word found nothing.
    for (const diagnostic of page.diagnostics) {
      this.note(`warning: ${diagnosticLine(diagnostic)}`);
    }

    const refPrefix = await fetchRefPrefix(client, project);
    this.output(
      {
        ...page,
        items: page.items.map((item) => ({
          ...item,
          issue: withRef(item.issue, refPrefix),
        })),
        ref_format: refFormat(refPrefix),
      },
      () => {
        if (page.items.length === 0) return "no matches";
        const paint = makePainter(this.context.stdout, this.context.env);
        const body = table(
          page.items.map((item) => [
            formatRef(refPrefix, item.issue.number),
            paint("dim", locator(item)),
            paintSnippet(item.snippet, paint),
          ]),
        );
        const n = page.items.length;
        const footer = page.has_more
          ? `${n} ${plural(n, "hit")} shown · more available (raise --limit)`
          : `${n} ${plural(n, "hit")}`;
        return `${body}\n${paint("dim", footer)}`;
      },
    );
  }
}
