/**
 * What a patch says about the commit it came from, read off the text before
 * its first file: `git format-patch` mail headers, or `git show` / `git log -p`
 * output.
 */
export type PatchCommit = {
  /** The subject line, `[PATCH n/m]` taken off. Empty when there is none. */
  subject: string;
  /** `n/m` from `[PATCH n/m]`. */
  series?: string;
  author?: string;
  /** As written; see `formatCommitDate`. */
  date?: string;
  hash?: string;
  /** The message under the subject, without the `---` and `--stat` after it. */
  body: string;
};

const FORMAT_PATCH_FROM = /^From ([0-9a-f]{7,40}) /;
const GIT_SHOW_COMMIT = /^commit ([0-9a-f]{7,40})\b/;
const PATCH_TAG = /^\[PATCH(?:[^\]]*?(\d+\/\d+))?[^\]]*\]\s*/;

function authorName(value: string): string {
  // `alice <noreply@example.com>` → `alice`; a bare address stays itself.
  const name = value.replace(/\s*<[^>]*>\s*$/, "").trim();
  return name === "" ? value.trim() : name.replace(/^"(.*)"$/, "$1");
}

function trimBlankLines(lines: string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end).join("\n");
}

function untag(subject: string): { subject: string; series?: string } {
  const tag = PATCH_TAG.exec(subject);
  if (tag === null) return { subject };
  return { subject: subject.slice(tag[0].length), series: tag[1] };
}

/** `git format-patch`: mail headers, a blank line, the body, `---`, stat. */
function fromMail(lines: string[]): PatchCommit {
  const headers = new Map<string, string>();
  let last: string | undefined;
  let i = 0;
  const hash = FORMAT_PATCH_FROM.exec(lines[0])?.[1];
  if (hash !== undefined) i = 1;
  for (; i < lines.length && lines[i] !== ""; i++) {
    const line = lines[i];
    // RFC 5322 folding: a long Subject continues on indented lines.
    if (/^[ \t]/.test(line) && last !== undefined) {
      headers.set(last, `${headers.get(last)} ${line.trim()}`);
      continue;
    }
    const field = /^([A-Za-z-]+):[ \t]*(.*)$/.exec(line);
    if (field === null) break;
    last = field[1].toLowerCase();
    headers.set(last, field[2]);
  }
  const rest = lines.slice(i);
  const cut = rest.indexOf("---");
  const from = headers.get("from");
  return {
    ...untag(headers.get("subject")?.trim() ?? ""),
    author: from === undefined ? undefined : authorName(from),
    date: headers.get("date"),
    hash,
    body: trimBlankLines(cut === -1 ? rest : rest.slice(0, cut)),
  };
}

/** `git show`: `commit`, `Author:`, `Date:`, then the message indented. */
function fromShow(lines: string[], hash: string): PatchCommit {
  let author: string | undefined;
  let date: string | undefined;
  let i = 1;
  for (; i < lines.length && lines[i] !== ""; i++) {
    const field = /^([A-Za-z]+):\s*(.*)$/.exec(lines[i]);
    if (field?.[1] === "Author") author = authorName(field[2]);
    if (field?.[1] === "Date") date = field[2];
  }
  const message = lines.slice(i).map((line) => line.replace(/^ {4}/, ""));
  const cut = message.indexOf("---");
  const text = trimBlankLines(cut === -1 ? message : message.slice(0, cut));
  const [subject = "", ...body] = text.split("\n");
  return { subject, author, date, hash, body: trimBlankLines(body) };
}

/**
 * The commit a patch's preamble describes, or null when the preamble names
 * none and carries nothing a reader would miss — a `diff -u a b` command line
 * or an `Index:` banner, which only restate the file header under them.
 * Free text that is neither stays as a body without a subject.
 */
export function parsePatchCommit(preamble: string): PatchCommit | null {
  const lines = preamble.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  if (lines.length === 0) return null;
  const shown = GIT_SHOW_COMMIT.exec(lines[0])?.[1];
  if (shown !== undefined) return fromShow(lines, shown);
  if (
    FORMAT_PATCH_FROM.test(lines[0]) ||
    /^(From|Subject|Date):/.test(lines[0])
  ) {
    return fromMail(lines);
  }
  const meaningful = lines.filter(
    (line) =>
      line.trim() !== "" && !/^(diff |Index: |={10,}|Only in )/.test(line),
  );
  if (meaningful.length === 0) return null;
  return { subject: "", body: trimBlankLines(lines) };
}

/** A commit date as a short local date, or the text as written if unparsable. */
export function formatCommitDate(date: string): string {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime())
    ? date
    : parsed.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}
