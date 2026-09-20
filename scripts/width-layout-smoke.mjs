#!/usr/bin/env node
/**
 * Manual 390px regression for the real issue description header.
 * Usage: node scripts/width-layout-smoke.mjs [--keep] [--help]
 * Requires the same installed dependencies/server build, Node 24+, flock and
 * CHROMIUM (default /usr/bin/chromium) as browser-layout-smoke.mjs.
 * Owns an isolated stack, API-seeded issue, browser context and cleanup.
 * Exit: 0 green/red/restored-green pass; 1 regression; 2 coverage/infra failure.
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { probeIssueHeaderWidth } from "./browser/issue-header-width-probe.mjs";
import { evaluate, startBrowser } from "./lib/browser-cdp.mjs";
import { createBrowserStack } from "./lib/browser-stack.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HELP = `width-layout-smoke — real issue description header at 390px

Usage: node scripts/width-layout-smoke.mjs [--keep] [--help]

Creates an isolated API/Vite stack and an editable issue through the API.
Checks the plain header, patches its body and checks the real (edited) header.
Restores the original timestamp shrink-0 class temporarily to require a geometry
failure, then requires a clean pass on the restored page. Every measurement
also requires documentElement.scrollWidth <= documentElement.clientWidth.
The timestamp is chosen from measured legal date/time fields in the loaded font.

--keep  Retain isolated artifacts under .tmp/ after cleanup.
CHROMIUM overrides /usr/bin/chromium. Uses en-US / UTC for reproducibility.
Exit codes: 0 pass, 1 layout/fault assertion, 2 infrastructure/coverage error.
`;

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
  await call("PATCH", "/me", { display_name: "Alice Neutral" });
  const slug = "width-smoke";
  await call("POST", "/projects", {
    slug,
    name: "Width smoke",
    description: "",
  });
  const path = `/projects/${slug}/issues`;
  const issue = await call("POST", path, {
    title: "Description width",
    body: "A short description for the width probe.",
  });
  if (!cookie.includes("="))
    throw new Error("seed did not receive an auth cookie");
  return {
    cookie,
    url: `${stack.webUrl}/projects/${slug}/issues/${issue.number}`,
    editBody: () =>
      call("PATCH", `${path}/${issue.number}`, {
        body: "An edited description for the width probe.",
      }),
  };
}

async function openIssue(context, fixture, edited) {
  const equals = fixture.cookie.indexOf("=");
  const page = await context.newPage({
    viewport: { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
    cookie: {
      name: fixture.cookie.slice(0, equals),
      value: fixture.cookie.slice(equals + 1),
      url: fixture.url,
    },
  });
  try {
    await page.send("Emulation.setLocaleOverride", { locale: "en-US" });
    await page.send("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
    await page.navigate(fixture.url);
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const ready = await evaluate(
        page,
        (expectedEdited) => {
          const button = document.querySelector(
            '[aria-label="description actions"]',
          );
          const header = button?.parentElement?.parentElement;
          if (!header || !header.querySelector('[aria-label="edit body"]'))
            return false;
          const hasRevision = [...header.children].some(
            (child) =>
              child.tagName === "BUTTON" &&
              child.textContent.trim() === "(edited)",
          );
          return (
            hasRevision === expectedEdited &&
            header.getBoundingClientRect().width > 0
          );
        },
        edited,
      );
      if (ready) return page;
      await sleep(100);
    }
    throw new Error(`real description header not ready (edited=${edited})`);
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
  const record = (name, result, expectRed = false) => {
    const coverageErrors = [...result.coverageErrors];
    if (result.viewportWidth !== 390)
      coverageErrors.push("expected-390px-viewport");
    const geometryRed = result.failures.some((failure) =>
      ["actions-outside-header", "header-child-outside"].includes(failure),
    );
    const pass =
      coverageErrors.length === 0 &&
      (expectRed ? !result.ok && geometryRed : result.ok);
    const entry = {
      name,
      status: pass ? "pass" : "fail",
      expectRed,
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
      prefix: "width-layout-smoke-",
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
      const plain = await openIssue(context, fixture, false);
      try {
        record(
          "plain-green",
          await evaluate(plain, probeIssueHeaderWidth, {
            expectedEdited: false,
          }),
        );
      } finally {
        await plain.close();
      }
      await fixture.editBody();
      const edited = await openIssue(context, fixture, true);
      try {
        const options = { expectedEdited: true, expectTruncation: true };
        record(
          "edited-green",
          await evaluate(edited, probeIssueHeaderWidth, options),
        );
        record(
          "timestamp-shrink-0-red",
          await evaluate(edited, probeIssueHeaderWidth, options, {
            timestampShrink0: true,
          }),
          true,
        );
        record(
          "edited-restored-green",
          await evaluate(edited, probeIssueHeaderWidth, options),
        );
      } finally {
        await edited.close();
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
    console.error(`width-layout-smoke: ${error.stack ?? error}`);
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
    name: "width-layout-smoke",
    status: exitCode === 0 ? "pass" : "fail",
    exitCode,
    versions: stack?.versions ?? null,
    cases,
  };
  console.log(`REPORT ${JSON.stringify(report)}`);
  if (stack?.dir && existsSync(stack.dir)) {
    writeFileSync(
      resolve(stack.dir, "width-layout-smoke-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  return exitCode;
}

process.exitCode = await main();
