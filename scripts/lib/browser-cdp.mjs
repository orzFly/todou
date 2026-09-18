/** CDP pipe transport shared by the manual browser smokes.
 * After changing scripts/lib/, run `pnpm test:browser --self-test-cdp`
 * and all three browser self-tests listed in `pnpm test:browser --help`.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

const REQUEST_TIMEOUT_MS = 10_000;
const STDERR_LIMIT = 8_000;
function sanitizedEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("TODOU_")),
  );
}

function failure(reason, cause) {
  return new Error(
    `Chrome DevTools pipe ${reason}`,
    cause ? { cause } : undefined,
  );
}

class CdpPipe {
  #buffer = Buffer.alloc(0);
  #child;
  #closed = false;
  #failure = null;
  #handlers = new Map();
  #nextId = 1;
  #pending = new Map();

  constructor(child) {
    this.#child = child;
    const input = child.stdio[3];
    const output = child.stdio[4];
    if (!input || !output)
      throw failure("was started without file descriptors 3 and 4");

    output.on("data", (chunk) => this.#consume(chunk));
    output.on("error", (error) => this.#fail(failure("read failed", error)));
    output.on("end", () => this.#fail(failure("disconnected")));
    output.on("close", () => this.#fail(failure("read pipe closed")));
    input.on("error", (error) => this.#fail(failure("write failed", error)));
    input.on("close", () => this.#fail(failure("write pipe closed")));
    child.on("error", (error) =>
      this.#fail(failure("browser process failed", error)),
    );
    child.on("exit", (code, signal) => {
      this.#fail(
        failure(
          `browser exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`,
        ),
      );
    });
  }

  #consume(chunk) {
    if (this.#closed) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const end = this.#buffer.indexOf(0);
      if (end === -1) return;
      const bytes = this.#buffer.subarray(0, end);
      this.#buffer = this.#buffer.subarray(end + 1);
      if (bytes.length === 0) continue;

      let message;
      try {
        message = JSON.parse(bytes.toString("utf8"));
      } catch (error) {
        this.#fail(failure("returned invalid JSON", error));
        return;
      }
      if (!message || typeof message !== "object") {
        this.#fail(failure("returned a non-object message"));
        return;
      }
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        if (!pending) continue;
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(
            failure(
              `${pending.method} failed: ${message.error.message ?? JSON.stringify(message.error)}`,
            ),
          );
        } else {
          pending.resolve(message.result ?? {});
        }
        continue;
      }
      if (typeof message.method !== "string") {
        this.#fail(failure("returned an event without a method"));
        return;
      }
      const key = this.#eventKey(message.method, message.sessionId);
      for (const handler of [...(this.#handlers.get(key) ?? [])]) {
        try {
          handler(message.params ?? {}, message.sessionId);
        } catch (error) {
          queueMicrotask(() => {
            throw error;
          });
        }
      }
    }
  }

  #eventKey(method, sessionId) {
    return `${sessionId ?? "*"}\0${method}`;
  }

  #fail(error) {
    if (this.#closed) return;
    this.#closed = true;
    this.#failure = error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#handlers.clear();
  }

  disconnect(reason = failure("disconnected")) {
    this.#fail(reason);
  }

  on(method, handler, sessionId) {
    if (this.#failure) throw this.#failure;
    const key = this.#eventKey(method, sessionId);
    const handlers = this.#handlers.get(key) ?? new Set();
    handlers.add(handler);
    this.#handlers.set(key, handlers);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      handlers.delete(handler);
      if (handlers.size === 0) this.#handlers.delete(key);
    };
  }

  send(method, params = {}, sessionId, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.#failure) return Promise.reject(this.#failure);
    const id = this.#nextId++;
    const payload = Buffer.from(
      `${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`,
      "utf8",
    );

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(failure(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // Register before write: Chrome can answer before the write callback runs.
      this.#pending.set(id, { method, reject, resolve, timer });
      this.#child.stdio[3].write(payload, (error) => {
        if (!error) return;
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(failure(`${method} write failed`, error));
      });
    });
  }
}

class BrowserContext {
  #browser;
  #closePromise = null;
  #closed = false;
  #pages = new Set();

  constructor(browser, browserContextId, owned = true) {
    this.#browser = browser;
    this.browserContextId = browserContextId;
    this.owned = owned;
  }

  async newPage(options = {}) {
    if (this.#closed || this.#closePromise)
      throw new Error("browser context is closed");
    const page = await this.#browser.newPage({ ...options, context: this });
    this.#pages.add(page);
    page.addCloseCallback(() => this.#pages.delete(page));
    return page;
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    if (this.#closed) return Promise.resolve();
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #close() {
    const pages = [...this.#pages];
    this.#pages.clear();
    try {
      if (this.owned && this.browserContextId) {
        await this.#browser.send("Target.disposeBrowserContext", {
          browserContextId: this.browserContextId,
        });
        for (const page of pages) page.markClosed();
      } else {
        await Promise.allSettled(pages.map((page) => page.close()));
      }
    } finally {
      this.#closed = true;
      this.#browser.forgetContext(this);
    }
  }
}

class BrowserPage {
  #browser;
  #closeCallbacks = new Set();
  #closePromise = null;
  #closed = false;
  #subscriptions = new Set();

  constructor(browser, context, targetId, sessionId) {
    this.#browser = browser;
    this.context = context;
    this.cdp = browser.cdp;
    this.targetId = targetId;
    this.sessionId = sessionId;
  }

  send(method, params = {}, timeoutMs) {
    if (this.#closed)
      return Promise.reject(new Error("browser page is closed"));
    return this.#browser.send(method, params, this.sessionId, timeoutMs);
  }

  on(method, handler) {
    if (this.#closed) throw new Error("browser page is closed");
    const unsubscribe = this.#browser.on(method, handler, this.sessionId);
    const wrapped = () => {
      unsubscribe();
      this.#subscriptions.delete(wrapped);
    };
    this.#subscriptions.add(wrapped);
    return wrapped;
  }

  async navigate(url) {
    return await this.send("Page.navigate", { url });
  }

  async addScriptToEvaluateOnNewDocument(source) {
    const { identifier } = await this.send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source },
    );
    return identifier;
  }

  async removeScriptToEvaluateOnNewDocument(identifier) {
    await this.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  }

  addCloseCallback(callback) {
    this.#closeCallbacks.add(callback);
  }

  markClosed() {
    if (this.#closed) return;
    this.#closed = true;
    for (const unsubscribe of this.#subscriptions) unsubscribe();
    this.#subscriptions.clear();
    for (const callback of this.#closeCallbacks) callback();
    this.#closeCallbacks.clear();
    this.#browser.forgetPage(this);
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    if (this.#closed) return Promise.resolve();
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #close() {
    try {
      await this.#browser.send("Target.closeTarget", {
        targetId: this.targetId,
      });
    } finally {
      this.markClosed();
    }
  }
}

class Browser {
  #child;
  #closePromise = null;
  #closing = false;
  #closed = false;
  #contexts = new Set();
  #pages = new Set();
  #stderr = "";
  #stopChild;

  constructor(child, cdp, stopChild) {
    this.#child = child;
    this.cdp = cdp;
    this.#stopChild = stopChild;
    child.stderr?.on("data", (chunk) => {
      this.#stderr = (this.#stderr + chunk.toString("utf8")).slice(
        -STDERR_LIMIT,
      );
    });
  }

  get child() {
    return this.#child;
  }

  get stderr() {
    return this.#stderr;
  }

  send(method, params = {}, sessionId, timeoutMs) {
    if (this.#closed) return Promise.reject(new Error("browser is closed"));
    return this.cdp.send(method, params, sessionId, timeoutMs);
  }

  on(method, handler, sessionId) {
    if (this.#closed) throw new Error("browser is closed");
    return this.cdp.on(method, handler, sessionId);
  }

  async newContext(options = {}) {
    if (this.#closed || this.#closing) throw new Error("browser is closed");
    const { browserContextId } = await this.send(
      "Target.createBrowserContext",
      options,
    );
    const context = new BrowserContext(this, browserContextId);
    this.#contexts.add(context);
    return context;
  }

  async newPage({
    context = null,
    viewport = null,
    cookie = null,
    url = "about:blank",
    scripts = [],
  } = {}) {
    if (this.#closed || this.#closing) throw new Error("browser is closed");
    const browserContextId = context?.browserContextId;
    const { targetId } = await this.send("Target.createTarget", {
      url: "about:blank",
      ...(browserContextId ? { browserContextId } : {}),
    });
    let page;
    try {
      const { sessionId } = await this.send("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      page = new BrowserPage(this, context, targetId, sessionId);
      this.#pages.add(page);
      await Promise.all([
        page.send("Page.enable"),
        page.send("Runtime.enable"),
        page.send("Network.enable"),
      ]);
      if (viewport) {
        await page.send("Emulation.setDeviceMetricsOverride", {
          deviceScaleFactor: 1,
          mobile: viewport.width < 640,
          ...viewport,
        });
      }
      if (cookie) {
        const normalized = normalizeCookie(cookie, url);
        await page.send("Network.setCookie", normalized);
      }
      for (const source of scripts) {
        await page.addScriptToEvaluateOnNewDocument(source);
      }
      // The target is deliberately born at about:blank: injection and network
      // interception can be armed before the requested navigation begins.
      if (url !== "about:blank") await page.navigate(url);
      return page;
    } catch (error) {
      if (page) page.markClosed();
      await this.send("Target.closeTarget", { targetId }).catch(() => {});
      throw error;
    }
  }

  forgetPage(page) {
    this.#pages.delete(page);
  }

  forgetContext(context) {
    this.#contexts.delete(context);
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    if (this.#closed) return Promise.resolve();
    this.#closing = true;
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #close() {
    const pages = [...this.#pages];
    const contexts = [...this.#contexts];
    try {
      await Promise.allSettled(pages.map((page) => page.close()));
      await Promise.allSettled(contexts.map((context) => context.close()));
      try {
        await this.cdp.send("Browser.close", {}, undefined, 2_000);
      } catch {}
      this.cdp.disconnect();
      await this.#stopChild(this.#child);
    } finally {
      this.#closed = true;
      this.#closing = false;
    }
  }
}

function normalizeCookie(cookie, url) {
  if (typeof cookie === "object") return cookie;
  const equals = cookie.indexOf("=");
  if (equals < 1)
    throw new Error("cookie must be a name=value string or object");
  const normalized = {
    name: cookie.slice(0, equals),
    value: cookie.slice(equals + 1),
  };
  if (url && url !== "about:blank") normalized.url = url;
  else {
    normalized.domain = "127.0.0.1";
    normalized.path = "/";
  }
  return normalized;
}

function browserGroupExists(child) {
  if (!child?.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

function signalBrowserGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function waitForBrowserGroup(child, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (browserGroupExists(child) && Date.now() < deadline) {
    await sleep(50);
  }
  return !browserGroupExists(child);
}

async function defaultStopChild(child) {
  if (!browserGroupExists(child)) return;
  signalBrowserGroup(child, "SIGTERM");
  if (await waitForBrowserGroup(child, 5_000)) return;
  signalBrowserGroup(child, "SIGKILL");
  if (!(await waitForBrowserGroup(child, 1_000))) {
    throw new Error(`Chromium process group ${child.pid} survived SIGKILL`);
  }
}

export async function startBrowser({
  dir,
  chromium = process.env.CHROMIUM ?? "/usr/bin/chromium",
  registerChild,
} = {}) {
  if (!dir) throw new Error("startBrowser requires dir");
  const child = spawn(
    chromium,
    [
      "--remote-debugging-pipe",
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--hide-scrollbars",
      `--user-data-dir=${join(dir, "chrome")}`,
      "about:blank",
    ],
    {
      detached: true,
      env: sanitizedEnvironment(),
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    },
  );
  // Ownership is registered synchronously, before any CDP request or await.
  const registeredStop = registerChild?.(child, "chromium");
  const stopChild =
    typeof registeredStop === "function"
      ? registeredStop
      : registerChild
        ? async () => {}
        : defaultStopChild;
  const cdp = new CdpPipe(child);
  const browser = new Browser(child, cdp, stopChild);
  try {
    await browser.send("Browser.getVersion");
    return browser;
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

/** Run `fn` in the page with JSON-serialisable arguments and return its value. */
export async function evaluate(page, fn, ...args) {
  const expression = `(${fn.toString()})(...${JSON.stringify(args)})`;
  const { result, exceptionDetails } = await page.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) {
    throw new Error(
      exceptionDetails.exception?.description ??
        JSON.stringify(exceptionDetails),
    );
  }
  return result.value;
}

function memoryPipe() {
  const child = new EventEmitter();
  const input = new PassThrough();
  const output = new PassThrough();
  child.stdio = [null, null, new PassThrough(), input, output];
  child.stderr = child.stdio[2];
  child.exitCode = null;
  child.signalCode = null;
  return { child, input, output, pipe: new CdpPipe(child) };
}

function check(condition, message) {
  if (!condition) throw new Error(`CDP pipe self-check failed: ${message}`);
}

/**
 * Exercise the protocol transport without launching Chromium. Intended for a
 * focused static/contract check by browser-smoke maintainers.
 */
export async function selfCheckCdpPipe() {
  const framed = memoryPipe();
  let written = Buffer.alloc(0);
  framed.input.on("data", (chunk) => {
    written = Buffer.concat([written, chunk]);
  });
  const fragmented = framed.pipe.send("Test.fragmented");
  const response = Buffer.from(
    `${JSON.stringify({ id: 1, result: { value: 7 } })}\0`,
  );
  framed.output.write(response.subarray(0, 5));
  framed.output.write(response.subarray(5));
  check(
    (await fragmented).value === 7,
    "fragmented response was not reassembled",
  );
  check(written.at(-1) === 0, "request was not NUL terminated");
  check(
    JSON.parse(written.subarray(0, -1).toString()).method === "Test.fragmented",
    "request framing changed its payload",
  );

  const protocolError = framed.pipe.send("Test.error");
  framed.output.write(
    `${JSON.stringify({ id: 2, error: { message: "expected error" } })}\0`,
  );
  await protocolError.then(
    () => check(false, "protocol error resolved"),
    (error) =>
      check(error.message.includes("expected error"), "protocol error lost"),
  );

  let browserLevel = 0;
  let matching = 0;
  let other = 0;
  const unsubscribeBrowser = framed.pipe.on("Test.event", () => browserLevel++);
  const unsubscribeMatching = framed.pipe.on(
    "Test.event",
    () => matching++,
    "page-a",
  );
  framed.pipe.on("Test.event", () => other++, "page-b");
  framed.output.write(
    `${JSON.stringify({ method: "Test.event", params: { browser: true } })}\0`,
  );
  framed.output.write(
    `${JSON.stringify({
      method: "Test.event",
      sessionId: "page-a",
      params: { value: 1 },
    })}\0`,
  );
  unsubscribeBrowser();
  unsubscribeMatching();
  framed.output.write(
    `${JSON.stringify({
      method: "Test.event",
      sessionId: "page-a",
      params: { value: 2 },
    })}\0`,
  );
  check(
    browserLevel === 1 && matching === 1 && other === 0,
    "browser/session routing or unsubscribe failed",
  );

  const timed = framed.pipe.send("Test.timeout", {}, undefined, 20);
  await timed.then(
    () => check(false, "timed request resolved"),
    (error) =>
      check(error.message.includes("timed out"), "timeout was not reported"),
  );

  const malformed = memoryPipe();
  const parsePending = malformed.pipe.send("Test.parse");
  malformed.output.write("{broken}\0");
  await parsePending.then(
    () => check(false, "parse failure resolved"),
    (error) =>
      check(error.message.includes("invalid JSON"), "parse failure was lost"),
  );

  const disconnected = memoryPipe();
  const disconnectPending = disconnected.pipe.send("Test.disconnect");
  disconnected.output.end();
  await disconnectPending.then(
    () => check(false, "disconnected request resolved"),
    (error) =>
      check(error.message.includes("disconnected"), "disconnect was lost"),
  );

  framed.pipe.disconnect();
  return {
    framing: "pass",
    protocolError: "pass",
    parseError: "pass",
    timeout: "pass",
    disconnect: "pass",
    sessionRouting: "pass",
    unsubscribe: "pass",
  };
}
