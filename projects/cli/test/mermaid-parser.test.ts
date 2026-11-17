import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import type { DiagramResult } from "../src/mermaid/types.ts";

const script = fileURLToPath(
  new URL("./fixtures/parse-diagrams.ts", import.meta.url),
);

// One child process for every case: loading mermaid takes about half a
// second. A child rather than an import because vitest's own module loader
// does not necessarily go through the `registerHooks` resolve hook, which is
// the part this suite exists to prove.
const sources = {
  flowchart: "flowchart LR\n  A --> B",
  pie: 'pie title Pets\n  "Dogs" : 3\n  "Cats" : 2',
  edgeLabel:
    "flowchart LR\n  A[Start] --> B\n  B -->|SettingsEvent::Saved(Config)| C",
  brokenPie: 'pie title Pets\n  "Dogs" 3',
  unknown: "not a diagram at all",
};

let results: Record<keyof typeof sources, DiagramResult>;

beforeAll(async () => {
  const keys = Object.keys(sources) as Array<keyof typeof sources>;
  const { stdout } = await promisify(execFile)(process.execPath, [
    script,
    JSON.stringify(keys.map((key) => sources[key])),
  ]);
  const parsed = JSON.parse(stdout) as DiagramResult[];
  results = Object.fromEntries(
    keys.map((key, i) => [key, parsed[i]]),
  ) as typeof results;
}, 60_000);

describe("the mermaid parser, loaded from source", () => {
  // The pie and the edge-label cases are also the proof of the dompurify
  // stub: without it, both fail with "DOMPurify.addHook is not a function".
  it("accepts a valid flowchart", () => {
    expect(results.flowchart).toEqual({ ok: true });
  });

  it("accepts a valid pie", () => {
    expect(results.pie).toEqual({ ok: true });
  });

  it("reports a jison grammar's error with its line", () => {
    expect(results.edgeLabel).toMatchObject({ ok: false, line: 3 });
    expect(results.edgeLabel).toHaveProperty(
      "message",
      expect.stringContaining("Parse error on line 3:"),
    );
  });

  it("takes a langium grammar's line from its message", () => {
    expect(results.brokenPie).toMatchObject({ ok: false, line: 2 });
  });

  it("has no line for an unrecognised diagram type", () => {
    expect(results.unknown).toMatchObject({ ok: false, line: null });
    expect(results.unknown).toHaveProperty(
      "message",
      expect.stringContaining("No diagram type detected"),
    );
  });
});
