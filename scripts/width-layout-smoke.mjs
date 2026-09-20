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
Then renames the author to the schema's longest legal display name and repeats,
where the chip must give its name up instead of leaving the row and the
timestamp must keep a width of its own. That case's required red is the chip's
pre-fix shrink-0 box; its page-wide overflow comes from the shell header's own
account button and is tolerated by name rather than asserted.

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
    // Through the real endpoint, so the server's own validator is what decides
    // this name is legal rather than this file's opinion of the limit (T-486).
    renameAuthor: (display_name) => call("PATCH", "/me", { display_name }),
  };
}

/**
 * The widest name the schema admits: `user.ts` caps display_name at 200
 * characters, and a capital W is the widest glyph the loaded face has to place
 * 200 of. The reported case was 32 of them; the cap is what the acceptance
 * criterion asks for, and the two are the same shape one order apart.
 */
const LONGEST_LEGAL_NAME = "W".repeat(200);

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
          // A descendant search, not the row's own children: T-487 moved the
          // edited marker into the baseline group one level in.
          const hasRevision = [...header.querySelectorAll("button")].some(
            (child) => child.textContent.trim() === "(edited)",
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
  // A red case says which failures it is a red *for*. Without that a case
  // passes on any geometry complaint, including one the fault it injected was
  // never supposed to cause — which is how a drill stops grading its own card.
  // `tolerated` is the other half: a failure this page really does have, for a
  // reason outside the case, named here so it cannot quietly become the reason
  // the case passed or failed.
  const record = (
    name,
    result,
    { expectRed = false, requiredRed = null, tolerated = [] } = {},
  ) => {
    const coverageErrors = [...result.coverageErrors];
    if (result.viewportWidth !== 390)
      coverageErrors.push("expected-390px-viewport");
    const failures = result.failures.filter(
      (failure) => !tolerated.includes(failure),
    );
    const red =
      requiredRed === null
        ? failures.some((failure) =>
            ["actions-outside-header", "header-child-outside"].includes(
              failure,
            ),
          )
        : requiredRed.every((failure) => failures.includes(failure));
    const green = failures.length === 0;
    const pass =
      coverageErrors.length === 0 && (expectRed ? !green && red : green);
    const entry = {
      name,
      status: pass ? "pass" : "fail",
      expectRed,
      requiredRed,
      tolerated,
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
          { expectRed: true },
        );
        record(
          "edited-restored-green",
          await evaluate(edited, probeIssueHeaderWidth, options),
        );
      } finally {
        await edited.close();
      }
      // T-486: the same header, with the pressure coming from the author's
      // name instead of the timestamp. A fresh page, because the chip renders
      // from the cached issue payload the first load fetched.
      //
      // `document-scroll-overflow` is tolerated here and only here. Measured
      // on this page at 390px with the same name: the widest thing sticking
      // out is the shell header's own account button, which is `shrink-0`
      // around its chip and so cannot narrow whatever the chip does; the
      // description header's chip is clipped and contributes nothing. Asserting
      // the page-wide number here would grade that other surface instead.
      await fixture.renameAuthor(LONGEST_LEGAL_NAME);
      const renamed = await openIssue(context, fixture, true);
      try {
        // Not `expectTruncation`: the width this case takes away is the chip's,
        // and the timestamp gets a row to itself rather than a squeeze.
        const options = { expectedEdited: true };
        const tolerated = ["document-scroll-overflow"];
        record(
          "long-name-green",
          await evaluate(renamed, probeIssueHeaderWidth, options),
          { tolerated },
        );
        record(
          "identity-shrink-0-red",
          await evaluate(renamed, probeIssueHeaderWidth, options, {
            identityShrink0: true,
          }),
          // Not `timestamp-disappeared`, which is the half of T-486's report
          // that T-487 has already carried off: the baseline group wraps now,
          // so an unshrinkable chip sends the timestamp to a second line at
          // full width instead of squeezing it to nothing. What is left of the
          // symptom, and what this grades, is the chip leaving its own row.
          {
            expectRed: true,
            tolerated,
            requiredRed: ["header-child-outside", "header-scroll-overflow"],
          },
        );
        record(
          "long-name-restored-green",
          await evaluate(renamed, probeIssueHeaderWidth, options),
          { tolerated },
        );
      } finally {
        await renamed.close();
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
