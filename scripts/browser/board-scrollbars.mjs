import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { evaluate } from "../lib/browser-cdp.mjs";

const VIEWPORT = {
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
};
const SAMPLE_MS = 60;
const TODO = "Todo";
const EMPTY_STATUSES = [
  "Backlog",
  "Next",
  "In Progress",
  "Ready to Ship",
  "Shipped",
  "Done",
];
const CANONICAL = [
  "Backlog",
  "Todo",
  "Next",
  "In Progress",
  "Ready to Ship",
  "Shipped",
  "Done",
];

function failure(name, detail) {
  return { name, detail };
}

async function apiFixture(serverPort) {
  const base = `http://127.0.0.1:${serverPort}/api`;
  let cookie = "";
  const call = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";", 1)[0];
    if (!response.ok)
      throw new Error(
        `${method} ${path} -> ${response.status} ${await response.text()}`,
      );
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
  await call("POST", "/auth/login");
  const slug = `layout-board-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  await call("POST", "/projects", {
    slug,
    name: `Layout board ${slug}`,
    description: "",
  });
  const statuses = await call("GET", `/projects/${slug}/statuses`);
  const names = statuses.map((status) => status.name);
  if (JSON.stringify(names) !== JSON.stringify(CANONICAL)) {
    throw new Error(
      `project did not seed the seven canonical statuses: ${JSON.stringify(names)}`,
    );
  }
  const todo = statuses.find((status) => status.name === TODO);
  if (!todo) throw new Error("canonical Todo status is missing");
  for (let index = 1; index <= 15; index += 1) {
    await call("POST", `/projects/${slug}/issues`, {
      title: `Scrollbar card ${String(index).padStart(2, "0")} — enough text to exercise a real board card`,
      body: "",
      status_id: todo.id,
    });
  }
  return { slug, cookie, todoId: todo.id, statuses: names };
}

function samplerSource(fault) {
  return `(() => {
    const fault = ${JSON.stringify(fault)};
    const samples = [];
    const started = performance.now();
    let phase = "loading";
    const opacity = el => el ? Number.parseFloat(getComputedStyle(el).opacity) : null;
    const take = () => {
      const columns = [...document.querySelectorAll('[data-testid^="column-"]')];
      const todoColumn = document.querySelector('[data-testid="column-Todo"]');
      const record = {
        t: +(performance.now() - started).toFixed(1),
        phase,
        readyState: document.readyState,
        loadingVisible:
          !!document.querySelector('.animate-pulse,[data-slot="skeleton"]') ||
          !todoColumn ||
          todoColumn.querySelectorAll('a[href*="/issues/"]').length < 15,
        columns: {},
      };
      for (const column of columns) {
        const name = column.getAttribute('data-testid').slice('column-'.length);
        const bar = column.querySelector('.os-scrollbar-vertical');
        const viewport = column.querySelector('[data-overlayscrollbars-viewport], .overflow-y-auto');
        const computed = bar ? getComputedStyle(bar) : null;
        record.columns[name] = {
          bar: !!bar,
          opacity: opacity(bar),
          visibility: computed?.visibility ?? null,
          classes: bar?.className ?? null,
          scrollTop: viewport?.scrollTop ?? null,
          scrollHeight: viewport?.scrollHeight ?? null,
          clientHeight: viewport?.clientHeight ?? null,
          cards: column.querySelectorAll('a[href*="/issues/"]').length,
          skeletons: column.querySelectorAll('[data-slot="skeleton"], .animate-pulse').length,
        };
      }
      samples.push(record);
    };
    if (fault) {
      const install = () => {
        if (document.head && !document.querySelector('style[data-board-scrollbar-fault]')) {
          const style = document.createElement('style');
          style.dataset.boardScrollbarFault = 'todo-opacity-zero';
          style.textContent = '[data-testid="column-Todo"] .os-scrollbar-vertical { opacity: 0 !important; }';
          document.head.append(style);
        }
      };
      new MutationObserver(install).observe(document, { childList: true, subtree: true });
      install();
    }
    window.__boardSmoke = {
      samples,
      sampleMs: ${SAMPLE_MS},
      setPhase(value) { phase = value; take(); },
      take,
      faultConfirmed() {
        const style = document.querySelector('style[data-board-scrollbar-fault]');
        const bar = document.querySelector('[data-testid="column-Todo"] .os-scrollbar-vertical');
        return !!style && !!bar && getComputedStyle(bar).opacity === '0';
      },
    };
    take();
    setInterval(take, ${SAMPLE_MS});
  })()`;
}

async function waitUntil(page, probe, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(page, probe);
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function exactTodoRequest(request, slug, todoId) {
  const url = new URL(request.url);
  const wantedPath = `/api/projects/${slug}/issues`;
  const direct =
    request.method === "GET" &&
    url.pathname === wantedPath &&
    url.searchParams.get("status") === String(todoId) &&
    url.searchParams.get("limit") === "100" &&
    url.searchParams.get("sort") === "updated" &&
    url.searchParams.get("order") === "desc";
  if (direct) {
    return {
      representation: "direct",
      subrequest: `${url.pathname}${url.search}`,
    };
  }
  if (
    request.method !== "POST" ||
    url.pathname !== "/api/batch" ||
    !request.postData
  )
    return null;
  try {
    const body = JSON.parse(request.postData);
    const matches =
      body.requests?.filter(({ url: nested }) => {
        const candidate = new URL(nested, "http://batch.invalid");
        return (
          candidate.pathname === `/projects/${slug}/issues` &&
          candidate.searchParams.get("status") === String(todoId) &&
          candidate.searchParams.get("limit") === "100" &&
          candidate.searchParams.get("sort") === "updated" &&
          candidate.searchParams.get("order") === "desc"
        );
      }) ?? [];
    return matches.length === 1
      ? { representation: "batch", subrequest: matches[0].url }
      : null;
  } catch {
    return null;
  }
}

async function armTodoPause(page, fixture) {
  await page.send("Fetch.enable", {
    patterns: [{ urlPattern: "*", requestStage: "Request" }],
  });
  let settled = false;
  let resolvePaused;
  let rejectPaused;
  const paused = new Promise((resolve, reject) => {
    resolvePaused = resolve;
    rejectPaused = reject;
  });
  const unsubscribe = page.on("Fetch.requestPaused", (event) => {
    void (async () => {
      try {
        const match = exactTodoRequest(
          event.request,
          fixture.slug,
          fixture.todoId,
        );
        if (match && !settled) {
          settled = true;
          resolvePaused({
            requestId: event.requestId,
            url: event.request.url,
            ...match,
          });
          return;
        }
        await page.send("Fetch.continueRequest", {
          requestId: event.requestId,
        });
      } catch (error) {
        if (!settled) {
          settled = true;
          rejectPaused(error);
        }
      }
    })();
  });
  return {
    paused,
    async release(record) {
      await page.send("Fetch.continueRequest", { requestId: record.requestId });
    },
    async close() {
      unsubscribe();
      await page.send("Fetch.disable").catch(() => {});
    },
  };
}

function phaseSamples(samples, phase) {
  return samples.filter((sample) => sample.phase === phase);
}

function maximumOpacity(samples, status) {
  return Math.max(
    -Infinity,
    ...samples
      .map((sample) => sample.columns[status]?.opacity)
      .filter(Number.isFinite),
  );
}

function fullyVisible(sample, status) {
  const bar = sample.columns[status];
  return bar?.bar && bar.opacity >= 0.99 && bar.visibility === "visible";
}

function phaseSummary(samples, phase) {
  const rows = phaseSamples(samples, phase);
  const start = rows[0]?.t ?? null;
  const end = rows.at(-1)?.t ?? null;
  const hidden = rows.find((sample) => {
    const todo = sample.columns[TODO];
    return todo?.opacity <= 0.01 && todo.visibility === "hidden";
  });
  const autoHideClass = rows.find((sample) =>
    /auto-hide-hidden|os-scrollbar-auto-hide-hidden/.test(
      sample.columns[TODO]?.classes ?? "",
    ),
  );
  const final = rows.at(-1)?.columns[TODO] ?? null;
  return {
    count: rows.length,
    start,
    end,
    durationMs: start === null || end === null ? 0 : end - start,
    firstHiddenAtMs: hidden?.t ?? null,
    firstAutoHideClassAtMs: autoHideClass?.t ?? null,
    finalOpacity: final?.opacity ?? null,
    finalVisibility: final?.visibility ?? null,
    finalClasses: final?.classes ?? null,
  };
}

async function runPass({ browser, stack, fixture, fault, label }) {
  const context = await browser.newContext();
  let page;
  const failures = [];
  let intercept = null;
  const poll = async (probe, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(page, probe)) return true;
      await sleep(50);
    }
    return false;
  };
  try {
    page = await context.newPage({
      viewport: VIEWPORT,
      cookie: fixture.cookie,
      scripts: [samplerSource(fault)],
    });
    intercept = await armTodoPause(page, fixture);
    const url = `http://127.0.0.1:${stack.webPort}/projects/${fixture.slug}/board`;
    await page.navigate(url);
    let paused;
    try {
      paused = await Promise.race([
        intercept.paused,
        sleep(15_000).then(() => {
          throw new Error("Todo listIssues request was never intercepted");
        }),
      ]);
    } catch (error) {
      failures.push(failure("todo-request-intercept", error.message));
      throw error;
    }

    await evaluate(page, async () => {
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      window.__boardSmoke.setPhase("paused-loading");
    });
    await sleep(700);
    const loadingSamples = phaseSamples(
      await evaluate(page, () => window.__boardSmoke.samples.slice()),
      "paused-loading",
    );
    const loadingDuration =
      (loadingSamples.at(-1)?.t ?? 0) - (loadingSamples[0]?.t ?? 0);
    const validLoading = loadingSamples.filter(
      (sample) =>
        sample.loadingVisible && sample.readyState !== "uninitialized",
    );
    if (validLoading.length < 10 || loadingDuration < 540) {
      failures.push(
        failure(
          "paused-loading-samples",
          `need >=10 loading samples after two frames spanning >=540ms; got ${validLoading.length} over ${loadingDuration}ms`,
        ),
      );
    }

    await intercept.release(paused);
    await intercept.close();
    intercept = null;
    await waitUntil(
      page,
      () => {
        const columns = document.querySelectorAll('[data-testid^="column-"]');
        const todo = document.querySelector('[data-testid="column-Todo"]');
        return (
          columns.length === 7 &&
          todo?.querySelectorAll('a[href*="/issues/"]').length === 15 &&
          !!todo.querySelector(".os-scrollbar-vertical")
        );
      },
      "seven board columns, fifteen Todo cards, and scrollbar",
    );

    await evaluate(page, () => window.__boardSmoke.setPhase("initial-reveal"));
    await sleep(3_400);
    const revealSamples = phaseSamples(
      await evaluate(page, () => window.__boardSmoke.samples.slice()),
      "initial-reveal",
    );
    const revealDuration =
      (revealSamples.at(-1)?.t ?? 0) - (revealSamples[0]?.t ?? 0);
    const validReveal = revealSamples.filter(
      (sample) =>
        sample.columns.Todo?.bar &&
        Number.isFinite(sample.columns.Todo.opacity),
    );
    if (
      validReveal.length < 10 ||
      revealDuration < 3_000 ||
      maximumOpacity(validReveal, TODO) < 0.99
    ) {
      failures.push(
        failure(
          "todo-initial-reveal",
          `need >=10 valid Todo samples over a continuous >=3000ms window with peak >=.99; got ${validReveal.length} samples over ${revealDuration}ms with peak ${maximumOpacity(validReveal, TODO)}`,
        ),
      );
    }
    for (const status of EMPTY_STATUSES) {
      const valid = revealSamples.filter(
        (sample) =>
          sample.columns[status]?.bar &&
          Number.isFinite(sample.columns[status]?.opacity),
      );
      if (valid.length < 10 || maximumOpacity(valid, status) > 0.01) {
        failures.push(
          failure(
            `empty-${status}-opacity-floor`,
            `${status} needs an existing bar whose reveal peak stays <=0.01; got ${valid.length} samples and peak ${maximumOpacity(valid, status)}`,
          ),
        );
      }
    }
    const injectionConfirmed = fault
      ? await evaluate(page, () => window.__boardSmoke.faultConfirmed())
      : false;
    if (fault && !injectionConfirmed) {
      failures.push(
        failure(
          "fault-injection-not-confirmed",
          "Todo opacity-zero style was not effective",
        ),
      );
    }

    const geometry = await evaluate(page, () => {
      const column = document.querySelector('[data-testid="column-Todo"]');
      const bar = column.querySelector(".os-scrollbar-vertical");
      const viewport = column.querySelector(
        "[data-overlayscrollbars-viewport], .overflow-y-auto",
      );
      const barRect = bar.getBoundingClientRect();
      return {
        bar: {
          x: barRect.left + barRect.width / 2,
          y: barRect.top + barRect.height / 2,
        },
        outside: { x: 1, y: Math.max(1, barRect.top) },
        scrollTop: viewport.scrollTop,
      };
    });
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...geometry.bar,
    });
    await poll(
      () =>
        Number.parseFloat(
          getComputedStyle(
            document.querySelector(
              '[data-testid="column-Todo"] .os-scrollbar-vertical',
            ),
          ).opacity,
        ) >= 0.99,
      1_000,
    );
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...geometry.outside,
    });
    await evaluate(page, () =>
      window.__boardSmoke.setPhase("pre-scroll-suspend"),
    );
    await sleep(2_100);
    const suspended = phaseSamples(
      await evaluate(page, () => window.__boardSmoke.samples.slice()),
      "pre-scroll-suspend",
    );
    const suspensionDuration =
      (suspended.at(-1)?.t ?? 0) - (suspended[0]?.t ?? 0);
    const unchanged = suspended.every(
      (sample) =>
        sample.columns.Todo?.scrollTop === null ||
        Math.abs(sample.columns.Todo.scrollTop - geometry.scrollTop) <= 0.01,
    );
    if (
      suspended.length < 10 ||
      suspensionDuration < 2_000 ||
      !suspended.every((sample) => fullyVisible(sample, TODO)) ||
      !unchanged
    ) {
      failures.push(
        failure(
          "pre-scroll-suspension",
          "after real pointer enter/leave, Todo did not stay fully visible and unscrolled for >=2s",
        ),
      );
    }

    await page.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...geometry.outside,
    });
    await evaluate(page, () =>
      window.__boardSmoke.setPhase("post-real-scroll-hide"),
    );
    const scroll = await evaluate(page, () => {
      const viewport = document.querySelector(
        '[data-testid="column-Todo"] [data-overlayscrollbars-viewport], [data-testid="column-Todo"] .overflow-y-auto',
      );
      const before = viewport.scrollTop;
      viewport.scrollTop = Math.min(
        viewport.scrollHeight - viewport.clientHeight,
        before + 420,
      );
      return { before, after: viewport.scrollTop };
    });
    if (!(scroll.after > scroll.before)) {
      failures.push(
        failure(
          "real-scroll-not-observed",
          `programmatic real viewport scroll did not move (${scroll.before} -> ${scroll.after})`,
        ),
      );
    }
    await sleep(3_100);
    await poll(() => {
      const bar = document.querySelector(
        '[data-testid="column-Todo"] .os-scrollbar-vertical',
      );
      const style = getComputedStyle(bar);
      return (
        Number.parseFloat(style.opacity) <= 0.01 &&
        style.visibility === "hidden"
      );
    }, 1_900);
    let samples = await evaluate(page, () =>
      window.__boardSmoke.samples.slice(),
    );
    const postScroll = phaseSummary(samples, "post-real-scroll-hide");
    if (
      postScroll.count < 45 ||
      postScroll.durationMs < 3_000 ||
      postScroll.firstHiddenAtMs === null ||
      postScroll.finalOpacity > 0.01 ||
      postScroll.finalVisibility !== "hidden"
    ) {
      failures.push(
        failure(
          "real-scroll-hide",
          `need >=3s of samples and final opacity<=.01/visibility:hidden within 5s: ${JSON.stringify(postScroll)}`,
        ),
      );
    }

    await page.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...geometry.bar,
    });
    const reappeared = await poll(() => {
      const bar = document.querySelector(
        '[data-testid="column-Todo"] .os-scrollbar-vertical',
      );
      const style = getComputedStyle(bar);
      return (
        Number.parseFloat(style.opacity) >= 0.99 &&
        style.visibility === "visible"
      );
    }, 1_000);
    await evaluate(page, () =>
      window.__boardSmoke.setPhase("hover-reappear-hold"),
    );
    await sleep(2_100);
    const hovered = phaseSamples(
      await evaluate(page, () => window.__boardSmoke.samples.slice()),
      "hover-reappear-hold",
    );
    const hoverDuration = (hovered.at(-1)?.t ?? 0) - (hovered[0]?.t ?? 0);
    if (
      !reappeared ||
      hovered.length < 10 ||
      hoverDuration < 2_000 ||
      !hovered.every((sample) => fullyVisible(sample, TODO))
    ) {
      failures.push(
        failure(
          "hover-reappearance",
          "real pointer hover did not reach >=.99 and remain visible for >=2s",
        ),
      );
    }

    await page.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...geometry.outside,
    });
    await evaluate(page, () => window.__boardSmoke.setPhase("leave-hide"));
    await sleep(3_100);
    await poll(() => {
      const bar = document.querySelector(
        '[data-testid="column-Todo"] .os-scrollbar-vertical',
      );
      const style = getComputedStyle(bar);
      return (
        Number.parseFloat(style.opacity) <= 0.01 &&
        style.visibility === "hidden"
      );
    }, 1_900);
    samples = await evaluate(page, () => window.__boardSmoke.samples.slice());
    const leave = phaseSummary(samples, "leave-hide");
    if (
      leave.count < 45 ||
      leave.durationMs < 3_000 ||
      leave.firstHiddenAtMs === null ||
      leave.finalOpacity > 0.01 ||
      leave.finalVisibility !== "hidden"
    ) {
      failures.push(
        failure(
          "leave-hide",
          `leave did not cover the full delay and hide within 5s: ${JSON.stringify(leave)}`,
        ),
      );
    }

    const phases = Object.fromEntries(
      [
        "paused-loading",
        "initial-reveal",
        "pre-scroll-suspend",
        "post-real-scroll-hide",
        "hover-reappear-hold",
        "leave-hide",
      ].map((phase) => [phase, phaseSummary(samples, phase)]),
    );
    const result = {
      name: `board-scrollbars:${label}`,
      fixture: {
        slug: fixture.slug,
        statuses: fixture.statuses,
        cards: 15,
      },
      intercept: { ...paused, confirmedFramesWhilePaused: 2 },
      injectionConfirmed,
      failures,
      phases,
      samples,
    };
    if (failures.length) {
      const shot = await page.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
      writeFileSync(
        join(stack.dir, `board-scrollbars-${label}.png`),
        Buffer.from(shot.data, "base64"),
      );
      writeFileSync(
        join(stack.dir, `board-scrollbars-${label}.json`),
        `${JSON.stringify(result, null, 2)}\n`,
      );
    }
    return result;
  } finally {
    await intercept?.close().catch(() => {});
    await context.close();
  }
}

export async function runBoardScrollbars(options) {
  const fixture = await apiFixture(options.stack.serverPort);
  if (!options.selfTest) {
    return {
      name: "board-scrollbars",
      passes: [
        await runPass({
          ...options,
          fixture,
          fault: false,
          label: "clean",
        }),
      ],
    };
  }
  const baseline = await runPass({
    ...options,
    fixture,
    fault: false,
    label: "baseline",
  });
  const fault = await runPass({
    ...options,
    fixture,
    fault: true,
    label: "fault",
  });
  const restored = await runPass({
    ...options,
    fixture,
    fault: false,
    label: "restored",
  });
  const baselineNames = new Set(baseline.failures.map((item) => item.name));
  const faultNames = new Set(fault.failures.map((item) => item.name));
  const restoredNames = new Set(restored.failures.map((item) => item.name));
  const assessment = [];
  const coverageNames = new Set([
    "todo-request-intercept",
    "paused-loading-samples",
    "fault-injection-not-confirmed",
    "real-scroll-not-observed",
  ]);
  if (baseline.failures.some((item) => coverageNames.has(item.name))) {
    assessment.push(
      failure(
        "self-test-baseline-coverage",
        "baseline lacked required intercept/loading/injection coverage",
      ),
    );
  }
  if (fault.failures.some((item) => coverageNames.has(item.name))) {
    assessment.push(
      failure(
        "self-test-fault-coverage",
        "fault pass lacked required intercept/loading/injection coverage",
      ),
    );
  }
  if (restored.failures.some((item) => coverageNames.has(item.name))) {
    assessment.push(
      failure(
        "self-test-restoration-coverage",
        "restored pass lacked required intercept/loading coverage",
      ),
    );
  }
  if (baseline.failures.length) {
    assessment.push(
      failure(
        "self-test-baseline-not-clean",
        `pre-existing failures cannot prove the injected fault: ${[...baselineNames].join(", ")}`,
      ),
    );
  }
  if (!fault.injectionConfirmed) {
    assessment.push(
      failure("self-test-injection", "fault CSS was not confirmed"),
    );
  }
  if (
    baseline.failures.length ||
    !faultNames.has("todo-initial-reveal") ||
    baselineNames.has("todo-initial-reveal")
  ) {
    assessment.push(
      failure(
        "self-test-new-targeted-failure",
        "fault did not add a new targeted Todo reveal failure over a green baseline",
      ),
    );
  }
  if (restored.failures.length) {
    assessment.push(
      failure(
        "self-test-fresh-restoration",
        `fresh clean rerun failed: ${[...restoredNames].join(", ")}`,
      ),
    );
  }
  return {
    name: "board-scrollbars",
    passes: [baseline, fault, restored],
    failures: assessment,
  };
}
