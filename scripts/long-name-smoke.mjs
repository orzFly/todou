#!/usr/bin/env node
/**
 * Manual 390px regression for the surfaces a long display name pushes off
 * screen: the shell header's account button (T-500) and an event row's inline
 * author (T-501).
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
const HELP = `long-name-smoke — the shell header and an event row at 390px

Usage: node scripts/long-name-smoke.mjs [--keep] [--help]

Seeds a project, an issue and an assignment event through the API, renames the
author to the schema's longest legal display name, and measures at 390px that
no chip paints past the viewport and the document does not scroll sideways.
Both the issue page and the project's issue list, because the header is one
component but only the list was measured when T-500 was reported.
Rectangles are intersected with their clipping ancestors first: an ellipsised
chip still holds a full-width name span, and grading the layout box would
report an overflow nobody can see.

Each fix carries its own required red — the account cluster's pre-T-500
flex-none, and the chip's pre-T-501 percentage cap — and each must leave the
other surface green, so a pass names which of the two it is evidence for.

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
  const me = await call("GET", "/me");
  const slug = "long-name-smoke";
  await call("POST", "/projects", { slug, name: "Long name", description: "" });
  const path = `/projects/${slug}/issues`;
  const issue = await call("POST", path, {
    title: "Long display name",
    body: "A short description.",
  });
  // An assignment is what puts an author chip inside a sentence, which is the
  // shape T-501 is about; without it the event row has no chip to measure.
  await call("PATCH", `${path}/${issue.number}`, { assignees: [me.login] });
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
        (needsEventRow) =>
          (!needsEventRow ||
            document.querySelectorAll('[id^="event-"] a[href^="/users/"]')
              .length > 0) &&
          document.querySelector("header button [data-slot='avatar']") !== null,
        url === fixture.issueUrl,
      );
      if (ready) {
        // The account chip and the event row arrive from two queries; a frame
        // after both are present is what settles the row's flex distribution.
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
          record(
            name,
            await evaluate(page, probeLongNameOverflow, {
              // Only the issue page draws an event row; on the list the absence
              // is the page, not a chip that stopped rendering.
              surfaces:
                url === fixture.issueUrl
                  ? ["account-button", "event-author"]
                  : ["account-button"],
            }),
          );
        } finally {
          await page.close();
        }
      }
      // A fresh page per fault: these mutate the live document, and a clean
      // read on a mutated page is not a restore.
      for (const [name, faults, requiredRed, stillGreen] of [
        [
          "account-unshrinkable-red",
          { accountUnshrinkable: true },
          ["account-button-past-viewport", "document-scroll-overflow"],
          "event-author-past-viewport",
        ],
        [
          "chip-uncapped-red",
          { chipUncapped: true },
          ["event-author-past-viewport", "document-scroll-overflow"],
          "account-button-past-viewport",
        ],
      ]) {
        const page = await openPage(context, fixture, fixture.issueUrl);
        try {
          const result = await evaluate(page, probeLongNameOverflow, {
            faults,
            // The fault holds one surface wide open, so its name is not asked
            // to ellipsise and "no pressure" is the fault working.
            expectPressure: false,
          });
          record(name, result, { requiredRed });
          if (result.failures.includes(stillGreen)) {
            console.log(
              `NOTE ${name} also reddened ${stillGreen}, which it does not name`,
            );
            exitCode = Math.max(exitCode, 1);
          }
        } finally {
          await page.close();
        }
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
