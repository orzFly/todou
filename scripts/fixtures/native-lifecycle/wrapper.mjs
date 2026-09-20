// Copied beside asset.ts by native-lifecycle-smoke.mjs. The imported module is
// the exact generated payload, or an explicitly requested source bundle.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import loadedExtension from "./asset.ts";

const config = JSON.parse(readFileSync(process.env.TODOU_SMOKE_CONFIG, "utf8"));
const instance = randomUUID();
const assetSha256 = createHash("sha256")
  .update(readFileSync(config.asset))
  .digest("hex");
function emit(kind, data = {}) {
  appendFileSync(
    config.events,
    `${JSON.stringify({
      kind,
      at: new Date().toISOString(),
      pid: process.pid,
      instance,
      host: config.host,
      assetSha256,
      ...data,
    })}\n`,
  );
}
function identity(ctx) {
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile(),
    leafId: ctx.sessionManager.getLeafId(),
  };
}
function snapshot(ctx) {
  const path =
    process.env[config.host === "pi" ? "TODOU_PI_STATE" : "TODOU_OMP_STATE"];
  let state = null;
  try {
    state = JSON.parse(readFileSync(path, "utf8"));
  } catch {}
  return { ...identity(ctx), statePath: path, state };
}
function messages() {
  const timestamp = Date.now();
  const assistant = (text) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "smoke",
    model: "local",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  });
  return [
    {
      role: "user",
      content: [{ type: "text", text: "smoke first user" }],
      timestamp,
    },
    assistant("smoke first assistant; persistent history"),
    {
      role: "user",
      content: [{ type: "text", text: "smoke second user" }],
      timestamp,
    },
    assistant("smoke second assistant"),
  ];
}

function observedContext(ctx) {
  return new Proxy(ctx, {
    get(target, prop) {
      if (prop !== "ui") return Reflect.get(target, prop);
      return new Proxy(target.ui, {
        get(ui, key) {
          if (key === "setWidget")
            return (name, lines, ...rest) => {
              emit("widget", { name, lines: lines ?? null });
              return ui.setWidget(name, lines, ...rest);
            };
          const value = Reflect.get(ui, key);
          return typeof value === "function" ? value.bind(ui) : value;
        },
      });
    },
  });
}

export default function probe(api) {
  const hooks = new Map();
  let watch;
  const wrapped = new Proxy(api, {
    get(target, key) {
      if (key === "on")
        return (name, fn) => {
          const handlers = hooks.get(name) ?? [];
          handlers.push(fn);
          hooks.set(name, handlers);
          return target.on(name, async (event, ctx) => {
            emit("extension-event-before", {
              event: name,
              reason: event.reason,
              ...snapshot(ctx),
            });
            const result = await fn(event, observedContext(ctx));
            emit("extension-event-after", {
              event: name,
              reason: event.reason,
              ...snapshot(ctx),
            });
            return result;
          });
        };
      if (key === "registerTool")
        return (tool) => {
          if (tool.name === "todou_watch") watch = tool;
          return target.registerTool(tool);
        };
      if (key === "sendMessage")
        return (message, options) => {
          // Captures the production delivery call, including stop notifications,
          // without triggering a model turn. Socket auth/transport stays real.
          emit("delivery", { message, options });
        };
      if (key === "registerCommand")
        return (name, command) => {
          return target.registerCommand(name, {
            ...command,
            async handler(args, ctx) {
              const ui = new Proxy(ctx.ui, {
                get(uiTarget, prop) {
                  if (prop === "notify")
                    return (text, level) => {
                      emit("notify", { command: name, text, level });
                      return uiTarget.notify(text, level);
                    };
                  const value = Reflect.get(uiTarget, prop);
                  return typeof value === "function"
                    ? value.bind(uiTarget)
                    : value;
                },
              });
              await command.handler(args, { ...ctx, ui });
              emit("extension-command-done", {
                command: name,
                args,
                ...snapshot(ctx),
              });
            },
          });
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  loadedExtension(wrapped);
  if (!watch) throw new Error("Loaded asset did not register todou_watch");
  emit("loaded", { asset: config.asset, hookNames: [...hooks.keys()] });
  for (const name of [
    "session_start",
    "session_shutdown",
    "session_before_switch",
    "session_switch",
    "session_before_branch",
    "session_branch",
    "session_before_fork",
    "session_before_tree",
    "session_tree",
    "agent_start",
    "agent_end",
    "turn_start",
    "turn_end",
  ])
    api.on(name, (event, ctx) => {
      emit("native-event", {
        event: name,
        reason: event.reason,
        ...snapshot(ctx),
      });
    });
  // A stray input is an error, never permission to contact a model.
  api.on("before_agent_start", () => {
    emit("unexpected-model-turn");
    throw new Error("Native lifecycle smoke forbids model turns");
  });

  async function execute(args, ctx) {
    // Pi passes ctx fifth; omp's extension adapter accepts ctx as its final
    // argument (the supported five-argument call also keeps it fifth).
    return watch.execute(
      "native-smoke",
      args,
      new AbortController().signal,
      undefined,
      observedContext(ctx),
    );
  }
  api.registerCommand("probe", {
    description: "isolated native lifecycle smoke driver",
    async handler(raw, ctx) {
      const { op, id, ...args } = JSON.parse(raw);
      emit("probe-begin", { op, id, ...snapshot(ctx) });
      let value;
      try {
        if (op === "start" || op === "list") {
          value = await execute(
            {
              action: op,
              ...(op === "start" ? { issue: "T-16", project: "smoke" } : {}),
            },
            ctx,
          );
        } else if (op === "snapshot" || op === "noop") {
          value = snapshot(ctx);
        } else if (op === "nested") {
          const child = spawn(
            args.binary,
            [
              "--mode",
              "rpc",
              "--no-extensions",
              "--no-session",
              "--provider",
              "smoke",
              "--model",
              "local",
            ],
            {
              cwd: ctx.cwd,
              env: { ...process.env, PI_CODING_AGENT: "true" },
              stdio: ["pipe", "pipe", "pipe"],
            },
          );
          let buffer = "";
          let stderr = "";
          child.stderr.on("data", (data) => {
            stderr += data;
          });
          const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
          const exited = new Promise((resolve) => child.once("exit", resolve));
          try {
            value = await new Promise((resolve, reject) => {
              const timer = setTimeout(
                () => reject(new Error(`nested pi timeout: ${stderr}`)),
                15000,
              );
              child.once("error", (error) => {
                clearTimeout(timer);
                reject(error);
              });
              child.stdout.on("data", (data) => {
                buffer += data;
                for (
                  let end = buffer.indexOf("\n");
                  end !== -1;
                  end = buffer.indexOf("\n")
                ) {
                  const line = buffer.slice(0, end);
                  buffer = buffer.slice(end + 1);
                  let row;
                  try {
                    row = JSON.parse(line);
                  } catch {
                    continue;
                  }
                  if (row.type === "response" && row.id === "nested-follow") {
                    clearTimeout(timer);
                    resolve(row);
                  }
                }
              });
              child.stdin.write(
                `${JSON.stringify({ id: "nested-follow", type: "bash", command: `${quote(args.node)} ${quote(args.cli)} agent can-i-follow` })}\n`,
              );
            });
          } finally {
            child.kill("SIGTERM");
            const kill = setTimeout(() => child.kill("SIGKILL"), 1000);
            await exited;
            clearTimeout(kill);
          }
        } else if (op === "seed") {
          // newSession.setup exposes the writable manager. A user-only history
          // does not flush in Pi; the assistant is required before native fork.
          value = await ctx.newSession({
            setup: async (sm) => {
              for (const message of messages()) sm.appendMessage(message);
              await sm.flush?.();
              const file = sm.getSessionFile();
              if (!file || !existsSync(file))
                throw new Error("Seed did not persist after assistant entry");
              emit("seeded", {
                sessionId: sm.getSessionId(),
                sessionFile: file,
              });
            },
          });
        } else if (op === "new") {
          value = await ctx.newSession();
        } else if (op === "switch") {
          value = await ctx.switchSession(args.path);
        } else if (
          op === "branch" ||
          op === "rewind" ||
          op === "fork" ||
          op === "clone"
        ) {
          const entries = ctx.sessionManager.getBranch();
          const users = entries.filter(
            (e) => e.type === "message" && e.message.role === "user",
          );
          const target = users.at(-1);
          if (!target || users.length < 2)
            throw new Error(
              "Fork fixture needs two users with an assistant between them",
            );
          if (config.host === "omp") {
            // /branch and /rewind share showUserMessageSelector -> ctx.branch.
            // Report this as shared API dispatch, not a PTY selector traversal.
            value = await ctx.branch(target.id);
          } else {
            value = await ctx.fork(
              op === "clone" ? ctx.sessionManager.getLeafId() : target.id,
              { position: op === "clone" ? "at" : "before" },
            );
          }
        } else if (op === "tree") {
          const target = ctx.sessionManager
            .getBranch()
            .find(
              (e) => e.type === "message" && e.message.role === "assistant",
            );
          if (!target)
            throw new Error("Tree fixture needs an assistant ancestor");
          value = await ctx.navigateTree(target.id, { summarize: false });
        } else if (op === "turn") {
          // Dispatch captured reconciliation hooks only. An ordinary native
          // agent turn would invoke a provider; this route is explicitly marked
          // wrapper-dispatch in the report and is not claimed as a model turn.
          for (const fn of hooks.get("agent_start") ?? [])
            await fn({ type: "agent_start" }, ctx);
          emit("dispatched-event", { event: "agent_start", ...snapshot(ctx) });
        } else {
          throw new Error(`Unknown probe operation: ${op}`);
        }
        // Pi destroys old ctx on runtime replacement; do not dereference it here.
        emit("probe-done", { op, id, value });
      } catch (error) {
        emit("probe-error", {
          op,
          id,
          error: String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    },
  });
}
