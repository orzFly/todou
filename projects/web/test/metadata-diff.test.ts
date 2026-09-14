import type { IssueMetadataEntry } from "@todou/shared";
import { describe, expect, it } from "vitest";
import type { MetadataConflict } from "../src/api/metadata.ts";
import {
  applyWrite,
  conflictLines,
  diffMetadata,
  docRows,
  precheck,
  readDocument,
} from "../src/lib/metadata-diff.ts";

let clock = 0;
const entry = (
  namespace: string,
  key: string,
  value: string,
  display = "ci-bridge",
): IssueMetadataEntry => ({
  namespace,
  key,
  value,
  updated_at: new Date(1_700_000_000_000 + clock++ * 1_000).toISOString(),
  updated_by: {
    id: 1,
    login: display,
    display_name: display,
    kind: "machine",
    avatar_url: null,
    owner: null,
  },
});

const mapOf = (pairs: Array<[string, string]>): Map<string, string> =>
  new Map(pairs);

describe("diffMetadata", () => {
  it("sends a changed key with the snapshot value as its expectation", () => {
    // D1. Falsifies by: taking if_match from the text's value instead of the
    // snapshot's — an expectation that always holds and never refuses.
    const snapshot = mapOf([["ci/status", "passing"]]);
    const next = mapOf([["ci/status", "failing"]]);
    expect(diffMetadata(snapshot, next)).toEqual([
      { namespace: "ci", key: "status", value: "failing", if_match: "passing" },
    ]);
  });

  it("sends an added key expecting absence", () => {
    // D2. Falsifies by: carrying a snapshot value on an addition — there is
    // none to carry.
    const snapshot = mapOf([]);
    const next = mapOf([["ci/new", "v"]]);
    expect(diffMetadata(snapshot, next)).toEqual([
      { namespace: "ci", key: "new", value: "v", if_match: null },
    ]);
  });

  it("sends a deleted key as value null with the snapshot expectation", () => {
    // D3 — the deletion direction, the one most easily missed. Falsifies by:
    // removing the "in snapshot, gone from text" branch, which leaves
    // deletions silently unreported and the array empty.
    const snapshot = mapOf([["deploy/host", "todou"]]);
    const next = mapOf([]);
    expect(diffMetadata(snapshot, next)).toEqual([
      { namespace: "deploy", key: "host", value: null, if_match: "todou" },
    ]);
  });

  it("omits unchanged keys entirely — the array is the whole request", () => {
    // D4. Falsifies by: dropping the equality skip. Asserting the length (0)
    // rather than "does not contain" catches an entry that shouldn't exist.
    const snapshot = mapOf([
      ["ci/same", "v"],
      ["ci/other", "old"],
    ]);
    const next = mapOf([
      ["ci/same", "v"],
      ["ci/other", "new"],
    ]);
    expect(diffMetadata(snapshot, next)).toEqual([
      { namespace: "ci", key: "other", value: "new", if_match: "old" },
    ]);
  });

  it("sorts one mixed diff by (ns, key) across all three directions", () => {
    // D5. Falsifies by: not sorting. The whole array compared for equality,
    // so any ordering slip moves the failure to the exact element.
    const snapshot = mapOf([
      ["zz/old", "gone"],
      ["ci/edit", "v1"],
      ["mm/add", "pre-existing"],
    ]);
    const next = mapOf([
      ["aa/add", "fresh"],
      ["ci/edit", "v2"],
      ["mm/add", "pre-existing"],
    ]);
    expect(diffMetadata(snapshot, next)).toEqual([
      { namespace: "aa", key: "add", value: "fresh", if_match: null },
      { namespace: "ci", key: "edit", value: "v2", if_match: "v1" },
      { namespace: "zz", key: "old", value: null, if_match: "gone" },
    ]);
  });

  it("treats a value changed to empty string as a real change", () => {
    // The empty string is a legal value, not a deletion: `ci/x =` and an
    // absent line must land on opposite sides of the diff.
    const snapshot = mapOf([["ci/x", "something"]]);
    const next = mapOf([["ci/x", ""]]);
    expect(diffMetadata(snapshot, next)).toEqual([
      { namespace: "ci", key: "x", value: "", if_match: "something" },
    ]);
  });
});

describe("precheck", () => {
  it("reports each of the three ceilings", () => {
    // D6. Falsifies by: removing precheck — every error list comes back
    // empty and over-limit writes reach the server.
    const overValue: Array<[string, string]> = [["ci/big", "x".repeat(4097)]];
    expect(precheck(new Map(overValue))).toHaveLength(1);

    const nine: Array<[string, string]> = [];
    for (let ns = 1; ns <= 9; ns++) nine.push([`n${ns}/k`, "v"]);
    expect(precheck(new Map(nine))).toHaveLength(1);

    const thirtyThree: Array<[string, string]> = [];
    for (let k = 1; k <= 33; k++) thirtyThree.push([`ci/k${k}`, "v"]);
    expect(precheck(new Map(thirtyThree))).toHaveLength(1);
  });

  it("lets everything at the limits through", () => {
    const atLimits: Array<[string, string]> = [];
    for (let ns = 1; ns <= 8; ns++) {
      for (let k = 1; k <= 32; k++) atLimits.push([`n${ns}/k${k}`, "v"]);
    }
    expect(precheck(new Map(atLimits))).toEqual([]);
  });
});

describe("conflictLines", () => {
  const refused = (e: {
    namespace: string;
    key: string;
    value: string | null;
    if_match?: string | null;
  }) => ({
    namespace: e.namespace,
    key: e.key,
    value: e.value,
    if_match: e.if_match === undefined ? undefined : e.if_match,
  });

  it("words each of the five intents distinctly", () => {
    // D7. Falsifies by: rendering only `current` without consulting the
    // refused entry — all five lines would read the same.
    const refusedEntries = [
      refused({ namespace: "ci", key: "edit", value: "v2", if_match: "v1" }),
      refused({ namespace: "ci", key: "gone", value: "v", if_match: "v1" }),
      refused({ namespace: "ci", key: "add", value: "v", if_match: null }),
      refused({ namespace: "ci", key: "del", value: null, if_match: "v1" }),
      refused({ namespace: "ci", key: "delgone", value: null, if_match: "v" }),
    ];
    const conflicts: MetadataConflict[] = [
      { namespace: "ci", key: "edit", current: "v9" },
      { namespace: "ci", key: "gone", current: null },
      { namespace: "ci", key: "add", current: "existing" },
      { namespace: "ci", key: "del", current: "todou-2" },
      { namespace: "ci", key: "delgone", current: null },
    ];
    const lines = conflictLines(refusedEntries, conflicts, []);
    expect(lines.map((l) => `${l.namespace}/${l.key} ${l.text}`)).toEqual([
      'ci/edit → "v9"',
      "ci/gone → deleted by someone else",
      "ci/add → now exists",
      'ci/del → changed to "todou-2"',
      "ci/delgone → already deleted",
    ]);
  });

  it("attributes the write only when a refetched value equals current", () => {
    // D8. Falsifies by: attributing unconditionally — the sidebar entry may
    // predate the conflicting write, and the name would be wrong.
    const snapshot = [
      entry("ci", "host", "todou", "rn-deploy"),
      entry("ci", "other", "stale", "mirror-bot"),
    ];
    const refusedEntries = [
      refused({ namespace: "ci", key: "host", value: "x", if_match: "old" }),
      refused({ namespace: "ci", key: "other", value: "x", if_match: "old" }),
    ];
    const conflicts: MetadataConflict[] = [
      { namespace: "ci", key: "host", current: "todou" },
      { namespace: "ci", key: "other", current: "moved-on" },
    ];
    const lines = conflictLines(refusedEntries, conflicts, snapshot);
    expect(lines.map((l) => l.by)).toEqual(["rn-deploy", null]);
  });

  it("skips keys the 409 did not refuse", () => {
    const refusedEntries = [
      refused({ namespace: "ci", key: "kept", value: "v", if_match: "old" }),
    ];
    const lines = conflictLines(refusedEntries, [], []);
    expect(lines).toEqual([]);
  });
});

describe("applyWrite", () => {
  it("writes new values, overwrites old ones, and deletes on value null", () => {
    // Falsifies by: dropping the null branch — the deleted key survives and
    // the map comparison fails; or by mutating in place — the input-is
    // -untouched assertion below goes red.
    const snapshot = mapOf([
      ["ci/status", "passing"],
      ["orch/phase", "plan"],
      ["gone/key", "bye"],
    ]);
    const result = applyWrite(snapshot, [
      { namespace: "ci", key: "status", value: "failing", if_match: "passing" },
      { namespace: "ci", key: "added", value: "fresh", if_match: null },
      { namespace: "gone", key: "key", value: null, if_match: "bye" },
    ]);
    expect([...result.entries()]).toEqual([
      ["ci/status", "failing"],
      ["orch/phase", "plan"],
      ["ci/added", "fresh"],
    ]);
    expect([...snapshot.entries()]).toEqual([
      ["ci/status", "passing"],
      ["orch/phase", "plan"],
      ["gone/key", "bye"],
    ]);
  });
});

describe("docRows", () => {
  it("flattens the document in (ns, key) ascending order", () => {
    // Falsifies by: skipping the sort — the rows come back in insertion
    // order and the whole-array comparison fails on the first element.
    const doc = mapOf([
      ["orch/x", "1"],
      ["ci/b", "2"],
      ["ci/a", "3"],
    ]);
    expect(docRows(doc)).toEqual([
      { namespace: "ci", key: "a", value: "3" },
      { namespace: "ci", key: "b", value: "2" },
      { namespace: "orch", key: "x", value: "1" },
    ]);
  });
});

describe("readDocument", () => {
  const okParse = (entries: Array<[string, string]>) => () => ({
    ok: true as const,
    entries: mapOf(entries),
  });

  it("returns the parse's errors when the text does not parse", () => {
    // Falsifies by: swallowing the parse failure — ok would flip to true.
    const result = readDocument("whatever", () => ({
      ok: false as const,
      errors: [{ line: 1, message: "bad line" }],
    }));
    expect(result).toEqual({
      ok: false,
      errors: [{ line: 1, message: "bad line" }],
    });
  });

  it("runs the precheck after a successful parse", () => {
    // Falsifies by: parsing without prechecking — an over-limit value
    // would return ok: true, and this assertion fails on ok.
    const result = readDocument(
      "ci/big = ...",
      okParse([["ci/big", "x".repeat(4097)]]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveLength(1);
  });

  it("returns the document when both steps pass", () => {
    const result = readDocument("ci/x = 1", okParse([["ci/x", "1"]]));
    expect(result).toEqual({ ok: true, doc: mapOf([["ci/x", "1"]]) });
  });
});
