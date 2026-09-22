import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/**
 * The structural guard under the mirror sweep's colocated skip (T-510). A
 * deployment whose projects live in the system database no longer repairs
 * `ref_prefixes` at startup, and there is no backfill migration and no CLI
 * escape hatch either — the mirror is correct only because every writer of
 * `ref_formats` copies the row in the same transaction. A third writer would
 * therefore create gaps nothing ever closes, so it has to be stopped here.
 *
 * Blind spots, stated rather than implied: a file that writes twice and
 * mirrors once passes, and so does a wrong line in DECLARED. Only `src/` is
 * scanned — `test/` legitimately writes histories without mirrors.
 */
const WRITE_MARKER = "insert(refFormats)";
const MIRROR = "mirrorRefFormat";
const MUTATION_MARKERS = ["update(refFormats)", "delete(refFormats)"];

/**
 * Files that insert a format row and owe the mirror nothing, each with the
 * reason. Adding a line here is the deliberate act this guard exists to
 * force. Empty today: both writers mirror.
 */
const DECLARED: Record<string, string> = {};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

const FILES = sourceFiles(SRC).map((path) => ({
  name: relative(SRC, path).replaceAll("\\", "/"),
  text: readFileSync(path, "utf8"),
}));

describe("every writer of a ref format mirrors it", () => {
  it("leaves no history writer without a mirror write", () => {
    const offenders = FILES.filter(
      (file) =>
        file.text.includes(WRITE_MARKER) &&
        !file.text.includes(MIRROR) &&
        DECLARED[file.name] === undefined,
    ).map((file) => file.name);
    expect(
      offenders,
      "These files insert into `ref_formats` without naming " +
        "`mirrorRefFormat`. On a colocated deployment the mirror in " +
        "`ref_prefixes` is kept correct by the writing transaction alone — " +
        "the startup sweep skips those projects, and no backfill migration " +
        "or repair command exists — so a history row written without its " +
        "mirror is a reference that resolves wrongly forever. Mirror the " +
        "row in the same transaction, or add the file with the reason it " +
        "owes nothing:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("keeps the declared list from rotting", () => {
    const stale = Object.keys(DECLARED).filter((name) => {
      const file = FILES.find((f) => f.name === name);
      return file === undefined || !file.text.includes(WRITE_MARKER);
    });
    expect(
      stale,
      "These no longer exist or no longer write a format row; drop them " +
        "from DECLARED so the list keeps meaning what it says:\n" +
        stale.join("\n"),
    ).toEqual([]);
  });

  it("keeps the history append-only, which is what makes insert-only sync complete", () => {
    const mutators = FILES.filter((file) =>
      MUTATION_MARKERS.some((marker) => file.text.includes(marker)),
    ).map((file) => file.name);
    expect(
      mutators,
      "These files update or delete `ref_formats` rows. The mirror is " +
        "synchronised by inserting whatever it is missing, which can only " +
        "be complete while the history is append-only: an edited or removed " +
        "row leaves the mirror holding a claim the project no longer " +
        "makes.\n" +
        mutators.join("\n"),
    ).toEqual([]);
  });
});
