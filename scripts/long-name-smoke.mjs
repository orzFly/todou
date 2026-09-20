#!/usr/bin/env node
/**
 * Manual 390px regression for a surface a long display name pushes off screen:
 * the shell header's account button (T-500).
 * Usage: node scripts/long-name-smoke.mjs [--keep] [--help]
 * Requires the same installed dependencies, Node 24+, flock and CHROMIUM
 * (default /usr/bin/chromium) as the other browser smokes.
 * Owns an isolated stack, an API-seeded project, issue and assignment event,
 * a browser context and its own cleanup.
 * Exit: 0 every case as expected; 1 a layout/fault assertion; 2 coverage or
 * infrastructure failure.
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { probeLongNameOverflow } from "./browser/long-name-probe.mjs";
import { evaluate, startBrowser } from "./lib/browser-cdp.mjs";
import { createBrowserStack } from "./lib/browser-stack.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HELP = `long-name-smoke — the shell header's account button at 390px

Usage: node scripts/long-name-smoke.mjs [--keep] [--help]

Seeds a project and an issue through the API, renames the author to the
schema's longest legal display name, and measures at 390px that the account
button does not paint past the viewport. Both the issue page and the project's
issue list, because the header is one component but only the list was measured
when this was reported. Rectangles are intersected with their
clipping ancestors first: an ellipsised chip still holds a full-width name
span, and grading the layout box would report an overflow nobody can see.

The required red is the cluster's pre-T-500 flex-none with the button's
shrink-0, which is the shape that put the button 572px into a 390px viewport.
The page-wide number is reported and not asserted while the event row's own
author is still overflowing for a reason this file does not grade (T-501).

--keep  Retain isolated artifacts under .tmp/ after cleanup.
CHROMIUM overrides /usr/bin/chromium. Uses en-US / UTC for reproducibility.
Exit codes: 0 pass, 1 layout/fault assertion, 2 infrastructure/coverage error.
`;

/**
 * The widest name the schema admits: `user.ts` caps display_name at 200
 * characters, and a capital W is the widest glyph the loaded face has to place
 * 200 of. The reported cases were 32 of them; the cap is the same shape with
 * no argument left about whether a longer one exists.
 */
const LONGEST_LEGAL_NAME = "W".repeat(200);
const VIEWPORT = {
  width: 390,
  height: 900,
  deviceScaleFactor: 1,
  mobile: true,
};

async function seed(stack) {
  let cookie = "";
  const call = async (method, path, body) => {
    const response = await fetch(`${stack.serverUrl}/api${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";", 1)[0];
    if (!response.ok) {
      throw new Error(
        `${method} ${path}: ${response.status} ${await response.text()}`,
      );
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
  await call("POST", "/auth/login");
  const slug = "long-name-smoke";
  await call("POST", "/projects", { slug, name: "Long name", description: "" });
  const path = `/projects/${slug}/issues`;
  const issue = await call("POST", path, {
    title: "Long display name",
    body: "A short description.",
  });
  await call("PATCH", "/me", { display_name: LONGEST_LEGAL_NAME });
  if (!cookie.includes("="))
    throw new Error("seed did not receive an auth cookie");
  return {
    cookie,
    issueUrl: `${stack.webUrl}/projects/${slug}/issues/${issue.number}`,
    listUrl: `${stack.webUrl}/projects/${slug}`,
  };
}

async function openPage(context, fixture, url) {
  const equals = fixture.cookie.indexOf("=");
  const page = await context.newPage({
    viewport: VIEWPORT,
    cookie: {
      name: fixture.cookie.slice(0, equals),
      value: fixture.cookie.slice(equals + 1),
      url,
    },
  });
  try {
    await page.send("Emulation.setLocaleOverride", { locale: "en-US" });
    await page.send("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
    await page.navigate(url);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const ready = await evaluate(
        page,
        () =>
          document.querySelector("header button [data-slot='avatar']") !== null,
      );
      if (ready) {
        // The account chip arrives from its own query; a beat after it lands
        // is what settles the row's flex distribution around it.
        await sleep(600);
        return page;
      }
      await sleep(150);
    }
    throw new Error("shell header and event row did not both render");
  } catch (error) {
    await page.close();
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--keep", "--help"].includes(arg))) {
    console.error("Unknown argument. Try --help.");
    return 2;
  }
  if (args.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  const keep = args.includes("--keep");
  let stack;
  let exitCode = 0;
  const cases = [];
  // A red case says which surface it is a red *for*. A fault that reddens the
  // other one has injected something broader than the rule it names.
  const record = (name, result, { requiredRed = null, quiet = [] } = {}) => {
    const coverageErrors = result.coverageErrors.filter(
      (entry) => !quiet.includes(entry),
    );
    if (result.viewport !== VIEWPORT.width)
      coverageErrors.push("expected-390px-viewport");
    const pass =
      coverageErrors.length === 0 &&
      (requiredRed === null
        ? result.failures.length === 0
        : requiredRed.every((failure) => result.failures.includes(failure)));
    const entry = {
      name,
      status: pass ? "pass" : "fail",
      requiredRed,
      ...result,
      coverageErrors,
    };
    cases.push(entry);
    console.log(`CASE ${JSON.stringify(entry)}`);
    if (!pass) exitCode = Math.max(exitCode, coverageErrors.length ? 2 : 1);
  };

  try {
    stack = await createBrowserStack({
      root: ROOT,
      prefix: "long-name-smoke-",
      keep,
    });
    const fixture = await seed(stack);
    const browser = await startBrowser({
      dir: stack.dir,
      chromium: stack.chromium,
      registerChild: stack.registerChild,
    });
    stack.addCleanup(() => browser.close());
    const context = await browser.newContext();
    try {
      for (const [name, url] of [
        ["green-issue", fixture.issueUrl],
        ["green-list", fixture.listUrl],
      ]) {
        const page = await openPage(context, fixture, url);
        try {
          record(name, await evaluate(page, probeLongNameOverflow, {}));
        } finally {
          await page.close();
        }
      }
      // A fresh page for the fault: it mutates the live document, and a clean
      // read on a mutated page is not a restore.
      const faulted = await openPage(context, fixture, fixture.issueUrl);
      try {
        record(
          "account-unshrinkable-red",
          await evaluate(faulted, probeLongNameOverflow, {
            faults: { accountUnshrinkable: true },
            // The fault holds the button wide open, so its name is never asked
            // to ellipsise and "no pressure" is the fault working.
            expectPressure: false,
          }),
          { requiredRed: ["account-button-past-viewport"] },
        );
      } finally {
        await faulted.close();
      }
      const restored = await openPage(context, fixture, fixture.issueUrl);
      try {
        record(
          "restored-green",
          await evaluate(restored, probeLongNameOverflow, {}),
        );
      } finally {
        await restored.close();
      }
    } finally {
      await context.close();
    }
  } catch (error) {
    exitCode = 2;
    cases.push({
      name: "runner-error",
      status: "fail",
      error: error.stack ?? String(error),
    });
    console.error(`long-name-smoke: ${error.stack ?? error}`);
  } finally {
    if (stack) {
      if (exitCode !== 0 && !keep) {
        stack.keep = {
          remove: ["attachments", "chrome", "db"],
          message: `kept failure artifacts: ${stack.dir}`,
        };
      }
      try {
        await stack.cleanup();
      } catch (error) {
        exitCode = 2;
        cases.push({
          name: "cleanup-error",
          status: "fail",
          error: error.stack ?? String(error),
        });
      }
    }
  }
  const report = {
    name: "long-name-smoke",
    status: exitCode === 0 ? "pass" : "fail",
    exitCode,
    versions: stack?.versions ?? null,
    cases,
  };
  console.log(`REPORT ${JSON.stringify(report)}`);
  if (stack?.dir && existsSync(stack.dir)) {
    writeFileSync(
      resolve(stack.dir, "long-name-smoke-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  return exitCode;
}

process.exitCode = await main();
