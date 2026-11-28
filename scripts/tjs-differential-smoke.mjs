#!/usr/bin/env node
// Usage: tjs-differential-smoke.mjs <reference> <subject> [--subset]
//
// Runs one command sequence through two builds of the CLI and compares what
// each prints — stdout, stderr and exit code, command by command (T-792).
// Each side talks to a server of its own, started fresh from the same
// configuration, so the same sequence produces the same numbers on both. A
// path ending in `.cjs` runs under this node; anything else is executed.
//
// --subset runs only the commands checked on real macOS and Windows
// machines: --version, whoami, issue view, comment add, watch --poll, with
// the project and issue they need created first.
//
// Run from a checkout with dependencies installed: the servers are started
// from projects/server. Everything they write goes under .tmp/ and is
// removed at the end, as are both server processes.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const subset = args.includes("--subset");
const verbose = args.includes("--verbose");
const [reference, subject] = args.filter((arg) => !arg.startsWith("--"));
if (reference === undefined || subject === undefined) {
  console.error(
    "usage: tjs-differential-smoke.mjs <reference> <subject> [--subset] [--verbose]",
  );
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SLOW_RATIO = 3;
const SERVER_READY_MS = 60_000;
const COMMAND_TIMEOUT_MS = 60_000;

const VALID_DIAGRAM = "```mermaid\nflowchart LR\n  a --> b\n```";
const BROKEN_DIAGRAM = "```mermaid\nflowchart LR\n  a -->\n```";

function serverConfig(dir) {
  return [
    "[auth]",
    'mode = "single"',
    "",
    "[database]",
    `system = "pglite://${join(dir, "db").replaceAll("\\", "/")}"`,
    "auto_migrate = true",
    "",
    "[database.projects]",
    'placement = "shared"',
    "",
    "[storage]",
    'backend = "fs"',
    `path = "${join(dir, "attachments").replaceAll("\\", "/")}"`,
    "",
  ].join("\n");
}

function startServer(dir) {
  const config = join(dir, "config.toml");
  writeFileSync(config, serverConfig(dir));
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("TODOU_")) env[name] = value;
  }
  const child = spawn(
    process.execPath,
    [
      join(root, "projects/server/src/index.ts"),
      "serve",
      "--config",
      config,
      "--port",
      "0",
    ],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  const collect = (chunk) => {
    log += chunk;
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  return new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(`server did not start in ${SERVER_READY_MS} ms\n${log}`),
      );
    }, SERVER_READY_MS);
    const poll = setInterval(() => {
      const match = /todou server listening on :(\d+)\b/.exec(log);
      if (match) {
        clearInterval(poll);
        clearTimeout(timer);
        resolveReady({ child, origin: `http://127.0.0.1:${match[1]}` });
      } else if (child.exitCode !== null) {
        clearInterval(poll);
        clearTimeout(timer);
        reject(new Error(`server exited before it was ready\n${log}`));
      }
    }, 100);
  });
}

/** A single-mode server hands a session to anyone; the CLI wants a token. */
async function mintToken(origin) {
  const login = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!login.ok)
    throw new Error(`login: ${login.status} ${await login.text()}`);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const minted = await fetch(`${origin}/api/me/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "differential" }),
  });
  if (!minted.ok)
    throw new Error(`token: ${minted.status} ${await minted.text()}`);
  return (await minted.json()).token;
}

function commandFor(build) {
  return build.endsWith(".cjs")
    ? [process.execPath, [resolve(build)]]
    : [resolve(build), []];
}

/**
 * Only what the CLI must see: no colour, no TODOU_* or harness variables
 * from the caller, a home of its own. The process tree it may inspect is
 * the same for both sides.
 */
function cliEnv(side) {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: side.home,
    USERPROFILE: side.home,
    XDG_CONFIG_HOME: join(side.home, ".config"),
    TODOU_SERVER: side.origin,
    TODOU_TOKEN: side.token,
    TMPDIR: side.tmp,
    TEMP: side.tmp,
    TMP: side.tmp,
    TZ: "UTC",
    LANG: "C.UTF-8",
    NO_COLOR: "1",
  };
  for (const name of ["SystemRoot", "SYSTEMROOT", "ComSpec", "PATHEXT"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function run(side, argv, stdin) {
  const [command, prefix] = commandFor(side.build);
  const started = performance.now();
  return new Promise((resolveRun) => {
    const child = spawn(command, [...prefix, ...argv], {
      cwd: side.dir,
      env: cliEnv(side),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), COMMAND_TIMEOUT_MS);
    child.on("error", (error) => {
      stderr += `spawn failed: ${error.message}`;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({
        stdout,
        stderr,
        code: signal === null ? code : `signal ${signal}`,
        ms: performance.now() - started,
      });
    });
    child.stdin.end(stdin ?? "");
  });
}

/** Strips what differs between two fresh runs by construction. */
function normalize(text, side) {
  return (
    text
      .replaceAll(side.token, "<token>")
      .replaceAll(side.origin, "<server>")
      .replaceAll(side.origin.replace("127.0.0.1", "localhost"), "<server>")
      .replaceAll(side.dir, "<dir>")
      .replaceAll(side.dir.replaceAll("\\", "/"), "<dir>")
      .replace(
        /\b(just now|\d+[smhdw] ago|\d+ (second|minute|hour|day)s? ago)\b/g,
        "<when>",
      )
      .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z\b/g, "<time>")
      // mkdtemp's six random characters, in the scratch files a body edit leaves.
      .replace(/(todou-[a-z]+-)[A-Za-z0-9]{6}\b/g, "$1XXXXXX")
      .replace(/\bcursor: \S+/g, "cursor: <cursor>")
      .replace(/("cursor"|"next_cursor"|"since"): "[^"]*"/g, '$1: "<cursor>"')
      .replace(/--since \d+:[\w.]+/g, "--since <cursor>")
  );
}

function steps(side) {
  const file = (name, content) => {
    const path = join(side.dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  };
  const project = [
    "api",
    "POST",
    "/projects",
    "--body",
    JSON.stringify({ slug: "diff", name: "Differential", ref_prefix: "D" }),
  ];
  const all = [
    { label: "--version", argv: ["--version"], subset: true },
    { label: "--help", argv: ["--help"] },
    { label: "whoami", argv: ["whoami"], subset: true },
    { label: "create project", argv: project, subset: true },
    {
      label: "issue create",
      argv: [
        "issue",
        "create",
        "-p",
        "diff",
        "--title",
        "First issue",
        "--body",
        "Hello",
      ],
      subset: true,
    },
    {
      label: "issue create from stdin",
      argv: [
        "issue",
        "create",
        "-p",
        "diff",
        "--title",
        "Second",
        "--body-file",
        "-",
      ],
      stdin: "Body from stdin.\nSecond line, ünïcödé 🥔\n",
    },
    { label: "issue list", argv: ["issue", "list", "-p", "diff"] },
    {
      label: "issue view",
      argv: ["issue", "view", "-p", "diff", "1"],
      subset: true,
    },
    {
      label: "issue edit",
      argv: [
        "issue",
        "edit",
        "-p",
        "diff",
        "1",
        "--title",
        "First issue, renamed",
        "--status",
        "Todo",
      ],
    },
    {
      // A qualifier whose value carries a space goes back to the server
      // re-quoted, which runs the query parser inside the bundle.
      label: "search",
      argv: [
        "search",
        "-p",
        "diff",
        "--",
        "-status:In Progress",
        "renamed",
      ],
    },
    {
      label: "comment add",
      argv: ["comment", "add", "-p", "diff", "1", "--body", "A plain comment."],
      subset: true,
    },
    {
      label: "comment add with diagrams",
      argv: ["comment", "add", "-p", "diff", "1", "--body-file", "-"],
      stdin: `One that parses:\n\n${VALID_DIAGRAM}\n\nOne that does not:\n\n${BROKEN_DIAGRAM}\n`,
      subset: true,
    },
    {
      label: "attach",
      argv: [
        "attach",
        "-p",
        "diff",
        "1",
        () => file("upload/notes.txt", "attached bytes\n"),
      ],
    },
    { label: "attach list", argv: ["attach", "list", "-p", "diff", "1"] },
    {
      label: "attach download",
      argv: [
        "attach",
        "download",
        "-p",
        "diff",
        "1",
        "notes.txt",
        "-o",
        () => join(side.dir, "downloaded.txt"),
      ],
      after: () => readFileSync(join(side.dir, "downloaded.txt"), "utf8"),
    },
    {
      label: "question ask",
      argv: [
        "comment",
        "add",
        "-p",
        "diff",
        "1",
        "--body",
        "Pick one.",
        "--questions",
        () =>
          file(
            "questions.json",
            JSON.stringify([
              {
                header: "Pick",
                question: "Which one?",
                options: [
                  { label: "A", description: "the first" },
                  { label: "B", description: "the second" },
                ],
                multiple: false,
              },
            ]),
          ),
      ],
    },
    { label: "question list", argv: ["question", "list", "-p", "diff", "1"] },
    {
      label: "question answer",
      argv: [
        "question",
        "answer",
        "-p",
        "diff",
        "1",
        () => side.questionId,
        "--select",
        "A",
      ],
    },
    {
      label: "spec push",
      argv: [
        "spec",
        "push",
        "-p",
        "diff",
        "1",
        () => {
          file("spec-in/proposal.md", "# Proposal\n\nDo the thing.\n");
          file("spec-in/plan.md", "# Plan\n\n1. Do it.\n");
          return join(side.dir, "spec-in");
        },
        "--message",
        "v1",
      ],
    },
    {
      label: "spec pull",
      argv: [
        "spec",
        "pull",
        "-p",
        "diff",
        "1",
        () => join(side.dir, "spec-out"),
      ],
      after: () =>
        readdirSync(join(side.dir, "spec-out"))
          .sort()
          .map(
            (name) =>
              `${name}:\n${readFileSync(join(side.dir, "spec-out", name), "utf8")}`,
          )
          .join("\n"),
    },
    {
      label: "watch --poll",
      argv: [
        "watch",
        "-p",
        "diff",
        "--poll",
        "--any-actor",
        "--since",
        () => side.cursor,
      ],
      subset: true,
    },
    {
      label: "issue watch --poll",
      argv: [
        "issue",
        "watch",
        "-p",
        "diff",
        "1",
        "--poll",
        "--any-actor",
        "--since",
        () => side.cursor,
      ],
    },
    { label: "config show", argv: ["config", "show"] },
    { label: "unknown command", argv: ["no-such-command"] },
  ];
  return subset ? all.filter((step) => step.subset) : all;
}

async function main() {
  mkdirSync(join(root, ".tmp"), { recursive: true });
  const sides = [
    { name: "reference", build: reference },
    { name: "subject", build: subject },
  ].map((side) => {
    const dir = mkdtempSync(join(root, ".tmp", `tjs-diff-${side.name}-`));
    const home = join(dir, "home");
    const tmp = join(dir, "tmp");
    mkdirSync(home);
    mkdirSync(tmp);
    return { ...side, dir, home, tmp };
  });

  let failures = 0;
  const slow = [];
  try {
    for (const side of sides) {
      const server = await startServer(side.dir);
      side.server = server.child;
      side.origin = server.origin;
      side.token = await mintToken(server.origin);
    }
    const plans = sides.map(steps);
    for (let i = 0; i < plans[0].length; i += 1) {
      const results = [];
      for (const [s, side] of sides.entries()) {
        const step = plans[s][i];
        const argv = step.argv.map((arg) =>
          typeof arg === "function" ? arg() : arg,
        );
        const result = await run(side, argv, step.stdin);
        const question = /question wait \S+ (\d+)/.exec(result.stdout);
        if (step.label === "question ask" && question)
          side.questionId = question[1];
        // The watches start from the plain comment, so that what they
        // print is everything the sequence did after it.
        const cursor = /\bcursor: (\S+)/.exec(result.stdout);
        if (step.label === "comment add" && cursor) side.cursor = cursor[1];
        results.push({
          out: normalize(result.stdout, side),
          err: normalize(result.stderr, side),
          code: result.code,
          ms: result.ms,
          after: step.after ? normalize(attempt(step.after), side) : undefined,
        });
      }
      const [ref, sub] = results;
      const label = plans[0][i].label;
      const same =
        ref.out === sub.out &&
        ref.err === sub.err &&
        ref.code === sub.code &&
        ref.after === sub.after;
      const ratio = sub.ms / ref.ms;
      const timing = `${ref.ms.toFixed(0)} ms vs ${sub.ms.toFixed(0)} ms (×${ratio.toFixed(2)})`;
      if (ratio > SLOW_RATIO) slow.push(`${label}: ${timing}`);
      if (same) {
        console.log(`ok    ${label} — exit ${ref.code}, ${timing}`);
        if (verbose) console.log(indent(`${ref.out}${ref.err}`));
      } else {
        failures += 1;
        console.log(`DIFF  ${label} — ${timing}`);
        for (const [what, a, b] of [
          ["exit", String(ref.code), String(sub.code)],
          ["stdout", ref.out, sub.out],
          ["stderr", ref.err, sub.err],
          ["after", ref.after ?? "", sub.after ?? ""],
        ]) {
          if (a === b) continue;
          console.log(`  ${what} (reference):\n${indent(a)}`);
          console.log(`  ${what} (subject):\n${indent(b)}`);
        }
      }
    }
    for (const side of sides) {
      const left = existsSync(join(side.home, ".tjs"));
      if (left) {
        failures += 1;
        console.log(
          `DIFF  ${side.name} left ${join(side.home, ".tjs")} behind`,
        );
      }
    }
  } finally {
    for (const side of sides) side.server?.kill();
    await Promise.all(
      sides.map(
        (side) =>
          new Promise((done) => {
            if (!side.server || side.server.exitCode !== null) return done();
            side.server.on("exit", done);
          }),
      ),
    );
    for (const side of sides)
      rmSync(side.dir, { recursive: true, force: true });
  }
  if (slow.length > 0) {
    console.log(`\nmore than ${SLOW_RATIO}× slower on the subject:`);
    for (const line of slow) console.log(`  ${line}`);
  }
  console.log(
    `\n${failures === 0 ? "identical" : `${failures} difference(s)`}`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

/** What an `after` check read, or why it could not. */
function attempt(read) {
  try {
    return read();
  } catch (error) {
    return `<${error.code ?? error.message}>`;
  }
}

function indent(text) {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

await main();
