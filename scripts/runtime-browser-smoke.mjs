#!/usr/bin/env node
/** Two-page runtime measurements against an isolated server. No deployment data. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, startBrowser } from "./lib/browser-cdp.mjs";
import { createBrowserStack } from "./lib/browser-stack.mjs";

const root = resolve(
  process.env.RUNTIME_BROWSER_ROOT ??
    fileURLToPath(new URL("..", import.meta.url)),
);
const baselineOnly = process.argv.includes("--baseline");
const keep = process.argv.includes("--keep");
const production = process.argv.includes("--production");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(read, accepts, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (accepts(value)) return value;
    await sleep(50);
  } while (Date.now() < deadline);
  throw new Error(`${label}: timed out; last value ${JSON.stringify(value)}`);
}

async function seed(serverUrl) {
  let cookie;
  const call = async (method, path, body) => {
    const response = await fetch(`${serverUrl}/api${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const nextCookie = response.headers.get("set-cookie");
    if (nextCookie) cookie = nextCookie.split(";", 1)[0];
    assert.ok(response.ok, `${method} ${path}: ${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  };
  await call("POST", "/auth/login");
  await call("PATCH", "/me", { display_name: "Browser User" });
  const slug = "runtime-browser";
  await call("POST", "/projects", { slug, name: "Runtime browser" });
  const first = await call("POST", `/projects/${slug}/issues`, {
    title: "Shared runtime first card",
    body: "Deterministic browser fixture.",
  });
  const second = await call("POST", `/projects/${slug}/issues`, {
    title: "Shared runtime second card",
    body: "A distinct logical resource.",
  });
  for (let i = 0; i < 4; i++) {
    await call("POST", `/projects/${slug}/issues/${first.number}/comments`, {
      body: `Fixture comment ${i + 1}`,
    });
  }
  return { cookie, slug, first, second, call };
}

/** Counts transport and batch subitems at the server boundary, including workers. */
async function recordingProxy(stack) {
  const records = [];
  const active = new Set();
  let delay = 0;
  let maximum = 0;
  let dropEvents = false;
  const streams = new Set();
  const server = createServer(async (incoming, outgoing) => {
    if (incoming.url === "/runtime-probe") {
      outgoing.setHeader("content-type", "text/html");
      outgoing.end(
        '<!doctype html><title>Runtime probe</title><div id="root"></div><script type="module" src="/@vite/client"></script>',
      );
      return;
    }
    if (incoming.url === "/src/api/runtime/browser-other-worker.js") {
      const transformed = await fetch(
        `${stack.webUrl}/src/api/runtime/shared-worker.ts?worker_file&type=module`,
      );
      assert.ok(transformed.ok, "alternate worker source exists");
      const source = await transformed.text();
      const replaced = source.replace(
        /buildId:\s*[^,\n]+,/,
        'buildId: "browser-other-build",',
      );
      assert.notEqual(
        replaced,
        source,
        "alternate build identity is actually replaced",
      );
      outgoing.writeHead(200, { "content-type": "text/javascript" });
      outgoing.end(replaced);
      return;
    }
    const api = incoming.url.startsWith("/api/");
    if (production && !api) {
      const pathname = new URL(incoming.url, "http://todou.test").pathname;
      const directory = resolve(root, "projects/web/dist");
      const file = pathname.startsWith("/assets/")
        ? resolve(directory, `.${pathname}`)
        : resolve(directory, "index.html");
      if (!file.startsWith(`${directory}/`) || !existsSync(file)) {
        outgoing.writeHead(404, { "content-type": "text/plain" });
        outgoing.end("Not found");
      } else {
        const type = file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : file.endsWith(".html")
              ? "text/html"
              : "application/octet-stream";
        outgoing.writeHead(200, { "content-type": type });
        outgoing.end(readFileSync(file));
      }
      return;
    }
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const events = incoming.url.startsWith("/api/events");
    const record = api
      ? {
          method: incoming.method,
          path: incoming.url,
          startedAt: performance.now(),
          bytes: 0,
          logical:
            incoming.url === "/api/batch"
              ? JSON.parse(body.toString()).requests.map((item) => item.url)
              : incoming.method === "GET"
                ? [incoming.url.slice(4)]
                : [],
        }
      : null;
    if (record) records.push(record);
    if (events && dropEvents) {
      outgoing.writeHead(503);
      outgoing.end();
      return;
    }
    if (record && !events) {
      active.add(record);
      maximum = Math.max(maximum, active.size);
      if (delay && record.logical.length) await sleep(delay);
    }
    const destination = new URL(
      incoming.url,
      api ? stack.serverUrl : stack.webUrl,
    );
    const upstream = request(
      destination,
      {
        method: incoming.method,
        headers: { ...incoming.headers, host: destination.host },
      },
      (response) => {
        if (record) record.status = response.statusCode;
        outgoing.writeHead(response.statusCode, response.headers);
        response.on("data", (chunk) => {
          if (record) record.bytes += chunk.length;
        });
        response.pipe(outgoing);
        response.on("end", () => {
          if (record) record.finishedAt = performance.now();
          active.delete(record);
        });
        response.on("error", () => outgoing.destroy());
      },
    );
    upstream.on("error", () => {
      active.delete(record);
      outgoing.destroy();
    });
    if (events) streams.add(upstream);
    outgoing.on("close", () => {
      streams.delete(upstream);
      active.delete(record);
      upstream.destroy();
    });
    upstream.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    records,
    setDelay(ms) {
      delay = ms;
    },
    disconnectEvents(value) {
      dropEvents = value;
      if (value) for (const stream of streams) stream.destroy();
    },
    summary(start) {
      const selected = records.slice(start);
      const logical = selected.flatMap((row) => row.logical);
      return {
        outerRequests: selected.length,
        batchEnvelopes: selected.filter((row) => row.path === "/api/batch")
          .length,
        logicalReads: logical.length,
        identityReads: logical.filter((path) => path === "/me").length,
        eventConnections: selected.filter((row) =>
          row.path.startsWith("/api/events"),
        ).length,
        responseBytes: selected.reduce((sum, row) => sum + row.bytes, 0),
        maximumPhysicalInFlight: maximum,
        executions: Object.fromEntries(
          [...new Set(logical)].map((path) => [
            path,
            logical.filter((other) => other === path).length,
          ]),
        ),
      };
    },
    async close() {
      for (const stream of streams) stream.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function prepare(page, base, fixture, fallback) {
  if (fallback) {
    await page.addScriptToEvaluateOnNewDocument(
      'Object.defineProperty(globalThis,"SharedWorker",{value:undefined,configurable:true})',
    );
  }
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.send("Network.setCookie", {
    name: fixture.cookie.split("=", 1)[0],
    value: fixture.cookie.slice(fixture.cookie.indexOf("=") + 1),
    url: base,
  });
  await page.navigate(`${base}/runtime-probe`);
  await until(
    () => evaluate(page, () => document.readyState),
    (state) => state === "complete",
    "probe document",
  );
  return await evaluate(
    page,
    async (slug, first, second) => {
      const queries = await import("/src/api/queries.ts");
      const issues = await import("/src/api/issues.ts");
      const timeline = await import("/src/api/timeline.ts");
      await queries.initializeRuntime?.();
      // Each new page must validate identity online, including the baseline.
      await queries.queryClient.fetchQuery({
        ...queries.meQuery,
        staleTime: 0,
      });
      globalThis.probe = {
        ...queries,
        ...issues,
        ...timeline,
        slug,
        first,
        second,
        subscriptions: [],
      };
      return { mode: queries.runtime?.mode ?? "fallback" };
    },
    fixture.slug,
    fixture.first.number,
    fixture.second.number,
  );
}

async function fetchCard(page, number = "first") {
  return await evaluate(
    page,
    async (which) => {
      const p = globalThis.probe;
      const start = performance.now();
      const data = await p.queryClient.fetchQuery(
        p.issueQuery(p.slug, p[which]),
      );
      return { title: data.title, elapsedMs: performance.now() - start };
    },
    number,
  );
}

async function sharedScenarios(pages, proxy, fixture, report) {
  const itemPath = `/projects/${fixture.slug}/issues/${fixture.first.number}`;
  await Promise.all(
    pages.map((page) =>
      evaluate(page, async () => {
        const p = globalThis.probe;
        const { runtimeProjection } = await import(
          "/src/api/runtime/query-adapter.ts"
        );
        p.projection = runtimeProjection(p.issueQuery(p.slug, p.first));
        p.snapshots = [];
        p.subscriptions.push(
          p.runtime.subscribe(
            p.projection,
            { enabled: true, visible: true },
            (snapshot) => p.snapshots.push(snapshot),
          ),
        );
      }),
    ),
  );
  await until(
    () =>
      Promise.all(
        pages.map((page) =>
          evaluate(page, () =>
            globalThis.probe.snapshots.some(
              (snapshot) => snapshot.status === "success",
            ),
          ),
        ),
      ),
    (ready) => ready.every(Boolean),
    "both subscriptions receive server data",
  );
  let cursor = proxy.records.length;
  const title = "Shared runtime updated card";
  await fixture.call(
    "PATCH",
    `/projects/${fixture.slug}/issues/${fixture.first.number}`,
    { title },
  );
  await until(
    () =>
      Promise.all(
        pages.map((page) =>
          evaluate(
            page,
            (expected) =>
              globalThis.probe.snapshots.some(
                (snapshot) => snapshot.data?.title === expected,
              ),
            title,
          ),
        ),
      ),
    (ready) => ready.every(Boolean),
    "one watch validation updates both subscribers",
  );
  assert.equal(
    proxy.summary(cursor).executions[itemPath],
    1,
    "one shared watch validation",
  );
  report.checks.push({
    name: "mutation-watch-both-subscribers",
    ...proxy.summary(cursor),
  });
  await Promise.all(
    pages.map((page) =>
      evaluate(page, () => {
        const p = globalThis.probe;
        for (const unsubscribe of p.subscriptions.splice(0)) unsubscribe();
      }),
    ),
  );
  await evaluate(pages[0], async () => {
    const p = globalThis.probe;
    await p.runtime.control("INVALIDATE", {
      operationId: crypto.randomUUID(),
      targets: [{ type: "key-prefix", queryKey: ["issue", p.slug, p.first] }],
      selection: [],
      refetchType: "none",
      completion: "dirty-applied",
    });
  });
  cursor = proxy.records.length;
  proxy.setDelay(250);
  await Promise.all(
    pages.map((page) =>
      evaluate(page, () => {
        const p = globalThis.probe;
        p.cancel = new AbortController();
        p.cancelResult = null;
        p.runtime
          .read(p.projection.resources[0], { signal: p.cancel.signal })
          .then((data) => {
            p.cancelResult = { title: data.title };
          })
          .catch((error) => {
            p.cancelResult = { error: error.name };
          });
      }),
    ),
  );
  await sleep(50);
  await evaluate(pages[0], () => globalThis.probe.cancel.abort());
  const cancelled = await until(
    () =>
      Promise.all(
        pages.map((page) =>
          evaluate(page, () => globalThis.probe.cancelResult),
        ),
      ),
    (values) => values.every(Boolean),
    "single consumer cancellation settles both independently",
  );
  assert.equal(cancelled[0].error, "AbortError");
  assert.equal(cancelled[1].title, title);
  assert.equal(proxy.summary(cursor).executions[itemPath], 1);
  report.checks.push({ name: "cancel-one-consumer", ...proxy.summary(cursor) });
  proxy.setDelay(0);
  cursor = proxy.records.length;
  await evaluate(pages[0], async () => {
    const p = globalThis.probe;
    const { createRuntimeBridge } = await import("/src/api/runtime/bridge.ts");
    p.otherBuild = createRuntimeBridge({
      buildId: "browser-other-build",
      clientOrigin: "browser-other",
      workerFactory: (name) =>
        new SharedWorker("/src/api/runtime/browser-other-worker.js", {
          type: "module",
          name,
        }),
    });
    await p.otherBuild.ready;
    await p.otherBuild.bootstrap();
    return await p.otherBuild.read(p.projection.resources[0]);
  });
  assert.equal(
    proxy.summary(cursor).executions[itemPath],
    1,
    "different build owns an independent cache",
  );
  assert.ok(
    proxy.summary(cursor).identityReads >= 1,
    "different build verifies identity",
  );
  report.checks.push({ name: "different-build", ...proxy.summary(cursor) });
  await evaluate(pages[0], () => globalThis.probe.otherBuild.dispose());
  cursor = proxy.records.length;
  proxy.disconnectEvents(true);
  await sleep(350);
  proxy.disconnectEvents(false);
  await until(
    () => proxy.summary(cursor).eventConnections,
    (count) => count >= 1,
    "watch reconnect after disconnect",
  );
  report.checks.push({ name: "watch-reconnect", ...proxy.summary(cursor) });
  cursor = proxy.records.length;
  await evaluate(pages[0], async () => {
    const p = globalThis.probe;
    await p.runtime.authTransition(() => p.api.request("POST", "/auth/logout"));
  }).catch(() => {});
  const oldRead = await evaluate(pages[1], async () => {
    const p = globalThis.probe;
    try {
      await p.runtime.read(p.projection.resources[0]);
      return "unexpected-success";
    } catch (error) {
      return error.name;
    }
  });
  assert.notEqual(
    oldRead,
    "unexpected-success",
    "logout revokes the sibling's cached private result",
  );
  await evaluate(pages[0], async () => {
    const p = globalThis.probe;
    await p.runtime.authTransition(() => p.api.request("POST", "/auth/login"));
  });
  await evaluate(pages[1], async () => {
    const p = globalThis.probe;
    await p.runtime.bootstrap();
    const { getRuntimeQueryAdapter } = await import(
      "/src/api/runtime/query-adapter.ts"
    );
    await getRuntimeQueryAdapter(p.queryClient).resumeSession();
  });
  const again = await fetchCard(pages[1]);
  assert.equal(again.title, title);
  report.checks.push({
    name: "logout-and-same-account-login",
    ...proxy.summary(cursor),
  });
}

async function scenario(browser, proxy, fixture, fallback) {
  const context = await browser.newContext();
  const start = proxy.records.length;
  const pages = await Promise.all([context.newPage(), context.newPage()]);
  const report = { mode: fallback ? "fallback" : "worker", checks: [] };
  try {
    const modes = await Promise.all(
      pages.map((page) => prepare(page, proxy.url, fixture, fallback)),
    );
    assert.ok(
      modes.every(({ mode }) => mode === report.mode),
      `expected ${report.mode}: ${JSON.stringify(modes)}`,
    );
    const itemPath = `/projects/${fixture.slug}/issues/${fixture.first.number}`;
    proxy.setDelay(150);
    let cursor = proxy.records.length;
    const cold = await Promise.all(pages.map((page) => fetchCard(page)));
    const traffic = proxy.summary(cursor);
    assert.equal(
      traffic.executions[itemPath],
      fallback ? 2 : 1,
      "overlapping cross-page logical read count",
    );
    assert.ok(cold.every((result) => result.title === fixture.first.title));
    report.checks.push({
      name: "cold-overlap",
      ...traffic,
      firstContentMs: Math.min(...cold.map((row) => row.elapsedMs)),
      freshMs: Math.max(...cold.map((row) => row.elapsedMs)),
    });
    cursor = proxy.records.length;
    await Promise.all(pages.map((page) => fetchCard(page)));
    assert.equal(
      proxy.summary(cursor).executions[itemPath] ?? 0,
      0,
      "fresh completed value reuse",
    );
    report.checks.push({ name: "fresh", ...proxy.summary(cursor) });
    cursor = proxy.records.length;
    const duplicates = await evaluate(pages[0], async () => {
      const p = globalThis.probe;
      const options = p.issueQuery(p.slug, p.second);
      return await Promise.all([
        p.queryClient.fetchQuery(options),
        p.queryClient.fetchQuery(options),
      ]);
    });
    assert.equal(duplicates[0].number, duplicates[1].number);
    assert.equal(
      proxy.summary(cursor).executions[
        `/projects/${fixture.slug}/issues/${fixture.second.number}`
      ],
      1,
      "same-page consumers share a request",
    );
    report.checks.push({ name: "same-page-overlap", ...proxy.summary(cursor) });
    cursor = proxy.records.length;
    await Promise.all([
      evaluate(pages[0], async () => {
        const p = globalThis.probe;
        return await p.queryClient.fetchQuery(
          p.issuesQuery(p.slug, { q: "first", group: "none" }),
        );
      }),
      evaluate(pages[1], async () => {
        const p = globalThis.probe;
        return await p.queryClient.fetchQuery(
          p.issuesQuery(p.slug, { q: "second", group: "none" }),
        );
      }),
    ]).then(([first, second]) => {
      assert.equal(first.items.length, 1);
      assert.equal(second.items.length, 1);
      assert.notEqual(first.items[0].number, second.items[0].number);
    });
    report.checks.push({ name: "different-filters", ...proxy.summary(cursor) });
    cursor = proxy.records.length;
    await Promise.all(
      pages.map((page) =>
        evaluate(page, async () => {
          const p = globalThis.probe;
          await p.queryClient.invalidateQueries({
            queryKey: ["issue", p.slug, p.first],
            refetchType: "none",
          });
        }),
      ),
    );
    assert.equal(
      proxy.summary(cursor).executions[itemPath] ?? 0,
      0,
      "dirty-only must not fetch",
    );
    const refreshed = await Promise.all(pages.map((page) => fetchCard(page)));
    assert.equal(
      proxy.summary(cursor).executions[itemPath],
      fallback ? 2 : 1,
      "dirty reads share one validation",
    );
    report.checks.push({
      name: "dirty-then-fresh",
      ...proxy.summary(cursor),
      freshMs: Math.max(...refreshed.map((row) => row.elapsedMs)),
    });
    await sleep(5_100);
    cursor = proxy.records.length;
    await Promise.all(pages.map((page) => fetchCard(page)));
    assert.equal(
      proxy.summary(cursor).executions[itemPath],
      fallback ? 2 : 1,
      "imperative read after true TTL consults network",
    );
    report.checks.push({
      name: "expired-imperative",
      ...proxy.summary(cursor),
    });
    if (!fallback) await sharedScenarios(pages, proxy, fixture, report);
    proxy.setDelay(0);
    report.total = proxy.summary(start);
    console.log(`SCENARIO ${JSON.stringify(report)}`);
    return report;
  } finally {
    proxy.setDelay(0);
    await context.close();
  }
}

async function applicationScenario(browser, proxy, fixture, fallback = false) {
  const context = await browser.newContext();
  const start = proxy.records.length;
  const pages = await Promise.all([context.newPage(), context.newPage()]);
  const started = performance.now();
  try {
    await Promise.all(
      pages.map(async (page) => {
        await page.send("Emulation.setFocusEmulationEnabled", {
          enabled: true,
        });
        if (fallback === true)
          await page.addScriptToEvaluateOnNewDocument(
            'Object.defineProperty(globalThis,"SharedWorker",{value:undefined,configurable:true})',
          );
        if (fallback === "missing-worker") {
          await page.addScriptToEvaluateOnNewDocument(
            'const NativeWorker=globalThis.SharedWorker;globalThis.SharedWorker=class extends NativeWorker{constructor(_url,options){super("/assets/missing-runtime-worker.js",options)}}',
          );
        }
        await page.send("Network.setCookie", {
          name: fixture.cookie.split("=", 1)[0],
          value: fixture.cookie.slice(fixture.cookie.indexOf("=") + 1),
          url: proxy.url,
        });
        await page.navigate(
          `${proxy.url}/projects/${fixture.slug}/issues/${fixture.first.number}`,
        );
      }),
    );
    await until(
      () =>
        Promise.all(
          pages.map((page) =>
            evaluate(page, () => document.body?.innerText ?? ""),
          ),
        ),
      (text) =>
        text.every(
          (body) =>
            body.includes("Shared runtime") &&
            body.includes("Deterministic browser fixture."),
        ),
      "both actual application pages render",
      30_000,
    );
    const contentMs = performance.now() - started;
    const targets = (
      await browser.send("Target.getTargets")
    ).targetInfos.filter(
      (target) =>
        target.type === "shared_worker" &&
        target.browserContextId === context.browserContextId,
    );
    assert.equal(
      targets.length,
      fallback ? 0 : 1,
      "same-build application worker count",
    );
    await until(
      () => proxy.summary(start).eventConnections,
      (count) => count >= 1,
      "application watch opens",
    );
    const summary = proxy.summary(start);
    assert.equal(
      summary.eventConnections,
      1,
      "healthy same-build application has one watch",
    );
    if (!fallback) {
      await browser.send("Target.closeTarget", {
        targetId: targets[0].targetId,
      });
      // Visibility restoration is a required online recovery boundary, avoiding
      // a 30-second health-probe wait while still terminating the real worker.
      await Promise.all(
        pages.map((page) =>
          evaluate(page, () => {
            window.dispatchEvent(
              new PageTransitionEvent("pagehide", { persisted: true }),
            );
            window.dispatchEvent(
              new PageTransitionEvent("pageshow", { persisted: true }),
            );
          }),
        ),
      );
      await until(
        async () =>
          (await browser.send("Target.getTargets")).targetInfos.filter(
            (target) =>
              target.type === "shared_worker" &&
              target.browserContextId === context.browserContextId &&
              target.targetId !== targets[0].targetId,
          ).length,
        (count) => count === 1,
        "worker is rebuilt after real termination",
      );
      await until(
        () =>
          Promise.all(
            pages.map((page) =>
              evaluate(page, () =>
                document.body?.innerText.includes(
                  "Deterministic browser fixture.",
                ),
              ),
            ),
          ),
        (ready) => ready.every(Boolean),
        "application remains usable after worker restart",
      );
    }
    return {
      mode: `${production ? "production" : "development"}-app-${fallback === "missing-worker" ? fallback : fallback ? "fallback" : "worker"}`,
      ...summary,
      firstContentMs: contentMs,
    };
  } finally {
    await context.close();
  }
}

let stack;
let proxy;
let browser;
try {
  stack = await createBrowserStack({ root, prefix: "runtime-browser-", keep });
  const fixture = await seed(stack.serverUrl);
  proxy = await recordingProxy(stack);
  browser = await startBrowser({
    dir: stack.artifactDir,
    chromium: stack.chromium,
    registerChild: stack.registerChild,
  });
  const results = [];
  if (!production) {
    results.push(await scenario(browser, proxy, fixture, true));
    if (!baselineOnly)
      results.push(await scenario(browser, proxy, fixture, false));
  }
  if (!baselineOnly) {
    // The auth scenario rotates its cookie; seed a new isolated server session
    // for real application pages rather than resurrecting its old cookie.
    const login = await fetch(`${stack.serverUrl}/api/auth/login`, {
      method: "POST",
    });
    fixture.cookie = login.headers.get("set-cookie").split(";", 1)[0];
    results.push(await applicationScenario(browser, proxy, fixture));
    results.push(await applicationScenario(browser, proxy, fixture, true));
    if (production)
      results.push(
        await applicationScenario(browser, proxy, fixture, "missing-worker"),
      );
  }
  const report = {
    source: stack.versions.source,
    results,
    measurement:
      "HTTP boundary counts include identity requests and batch subitems; bytes are response payload bytes, timings are controlled QueryClient reads after online identity bootstrap.",
  };
  writeFileSync(
    resolve(stack.artifactDir, "runtime-results.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await proxy?.close();
  await stack?.cleanup();
}
