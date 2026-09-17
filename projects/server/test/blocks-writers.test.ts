import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/**
 * The block verdict (T-377) is a stored conclusion with a hand-written list
 * of writers, and design.md says plainly that nothing makes that list
 * complete. This is the second of the two nets under it: the behavioural
 * cases in blocks.test.ts pin one path each, and this one asks a cruder
 * question of the whole package — does any file touch the verdict's inputs
 * without either re-evaluating or saying why it does not have to?
 *
 * It catches the miss the other net cannot: a NEW file that starts writing
 * a status. Its own blind spot, stated so nobody mistakes it for a proof:
 * a second write path added inside a file that already re-evaluates is
 * invisible here — which is exactly how the `category` branch was missed —
 * and so is a file wrongly added to the list below.
 */
const MARKERS = ["statusId", "blockClearStatusId"];
const EVALUATORS = [
  "evaluateBlockerStatus",
  "reevaluateProjectBlocks",
  "repairBlocks",
];

/**
 * Files that name an input of the verdict and owe it nothing, each with the
 * reason. Adding a line here is the deliberate act the guard exists to
 * force; a wrong line is the way past it.
 */
const DECLARED: Record<string, string> = {
  "db/project-schema.ts": "the column definitions themselves",
  "routes/statuses.ts": "route wiring; the write is in services/statuses.ts",
  "services/inbox.ts": "reads the status for the keep-check",
  "services/search.ts": "reads the status for the facets",
  "services/move/plan.ts": "decides the mapping; copy.ts performs the write",
  "services/move/copy.ts":
    "writes the mapped status into the destination; execute.ts re-evaluates " +
    "against that project once the move has committed",
};

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

const touchesVerdict = (text: string) =>
  MARKERS.some((marker) => text.includes(marker));

describe("every writer of the block verdict re-evaluates it", () => {
  it("leaves no file naming a verdict input unaccounted for", () => {
    const offenders = FILES.filter(
      (file) =>
        touchesVerdict(file.text) &&
        !EVALUATORS.some((fn) => file.text.includes(fn)) &&
        DECLARED[file.name] === undefined,
    ).map((file) => file.name);
    expect(
      offenders,
      "These files name `statusId` or `blockClearStatusId` — the inputs the " +
        "block verdict is computed from — but neither re-evaluate it nor " +
        "appear in DECLARED above. A write that skips the re-evaluation " +
        "parks blocked cards on a stale verdict until the hourly repair " +
        "sweep, and the sweep has no actor, so the person who declared the " +
        "edge is the one reader whose unread filter skips the notification. " +
        "Call evaluateBlockerStatus + announceBlockChanges, or add the file " +
        "with the reason it owes nothing:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("keeps the declared list from rotting", () => {
    const stale = Object.keys(DECLARED).filter((name) => {
      const file = FILES.find((f) => f.name === name);
      return file === undefined || !touchesVerdict(file.text);
    });
    expect(
      stale,
      "These no longer exist or no longer name a verdict input; drop them " +
        "from DECLARED so the list keeps meaning what it says:\n" +
        stale.join("\n"),
    ).toEqual([]);
  });
});
