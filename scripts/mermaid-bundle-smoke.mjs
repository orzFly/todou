#!/usr/bin/env node
// Usage: mermaid-bundle-smoke.mjs <todou.cjs | todou executable>
//
// Proves on the built artifact that the embedded mermaid works (T-769): the
// sub-bundle, the compression, the payload injection and the main bundle's
// external are four separate steps, and only running the result shows that
// they connect. Run from source, the CLI takes a different loading path
// entirely, so no unit test can stand in for this. A `.cjs` runs under this
// node; anything else is a single-file executable and runs itself (T-792),
// with its own loader for the same payload.
//
// The CLI talks to a stub server on 127.0.0.1 that answers the one route a
// `comment add` needs. Anything else is answered 500 and named on stderr, so
// a missing route is easy to place.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bundle = process.argv[2];
if (bundle === undefined) {
  console.error(
    "usage: mermaid-bundle-smoke.mjs <todou.cjs | todou executable>",
  );
  process.exit(2);
}
const [command, prefix] = bundle.endsWith(".cjs")
  ? [process.execPath, [bundle]]
  : [bundle, []];

// From mermaid's own source; the CLI's code never spells it, and inside the
// compressed payload it cannot appear in clear.
if (readFileSync(bundle, "utf8").includes("flowchart-v2")) {
  console.error(`${bundle} carries mermaid uncompressed`);
  process.exit(1);
}

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    if (
      req.method === "POST" &&
      req.url === "/api/projects/todou/issues/7/comments"
    ) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "comment",
          id: 42,
          author: { id: 1, login: "claude-agent", display_name: null },
          body: JSON.parse(raw).body,
          created_at: "2026-01-01T00:00:00Z",
          edited_at: null,
        }),
      );
      return;
    }
    // The ref prefix; the CLI spells refs without one when it cannot read it.
    if (req.url === "/api/projects/todou/references/config") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    console.error(`stub: no route for ${req.method} ${req.url}`);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not stubbed" }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

const dir = mkdtempSync(join(tmpdir(), "todou-mermaid-smoke-"));
const failures = [];
try {
  const post = (body) => {
    const file = join(dir, "body.md");
    writeFileSync(file, body);
    return new Promise((resolve) => {
      execFile(
        command,
        [...prefix, "comment", "add", "7", "-p", "todou", "--body-file", file],
        {
          env: {
            PATH: process.env.PATH,
            HOME: dir,
            XDG_CONFIG_HOME: dir,
            XDG_STATE_HOME: dir,
            TMPDIR: dir,
            TODOU_SERVER: `http://127.0.0.1:${port}`,
            TODOU_TOKEN: "todou_pat_smoke",
          },
        },
        (error, stdout, stderr) =>
          resolve({
            code: error ? (error.code ?? 1) : 0,
            stdout,
            stderr,
            file,
          }),
      );
    });
  };

  const valid = "```mermaid\nflowchart LR\n  A --> B\n```\n";
  const broken =
    "```mermaid\nflowchart LR\n  A[Start] --> B\n  B -->|SettingsEvent::Saved(Config)| C\n```\n";

  const mixed = await post(`# Diagrams\n\n${valid}\n${broken}`);
  // The broken block's content starts on line 9; mermaid blames its line 3.
  const want = [
    "warning: 1 of 2 mermaid diagrams fails to parse",
    `${mixed.file}:11`,
    "Parse error on line 3:",
  ];
  if (mixed.code !== 0) failures.push(`mixed body exited ${mixed.code}`);
  for (const text of want) {
    if (!mixed.stderr.includes(text)) failures.push(`stderr lacks "${text}"`);
  }
  if (failures.length > 0) failures.push(`stderr was:\n${mixed.stderr}`);

  const clean = await post(`# Diagram\n\n${valid}`);
  if (clean.code !== 0) failures.push(`valid body exited ${clean.code}`);
  if (clean.stderr !== "") {
    failures.push(`valid body wrote to stderr:\n${clean.stderr}`);
  }
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`mermaid smoke failed on ${bundle}:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`ok: ${bundle} checks mermaid diagrams`);
