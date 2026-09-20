#!/usr/bin/env node
/**
 * Manual 390px regression for the search jump rows (T-446): the offer panel's
 * rows in the header box, and the jump banner on the search page.
 *
 * Usage: node scripts/search-wrap-smoke.mjs [--keep] [--help]
 * Requires the same installed dependencies, Node 24+, flock and CHROMIUM
 * (default /usr/bin/chromium) as browser-layout-smoke.mjs. Owns an isolated
 * stack, its API-seeded projects, agent, cards and comment, a browser context
 * and cleanup.
 * Exit: 0 every case passed; 1 a layout/fault assertion; 2 usage, prerequisite,
 * startup, cleanup, or a check that never reached its target.
 *
 * The fixture is the longest ref the schema can actually be made to produce:
 * a 64-character slug (`ProjectSlug`), a 20-character prefix
 * (`MAX_PREFIX_LENGTH`) and a comment by an author whose name is 64 characters
 * (`MAX_LOGIN_LENGTH`) — built through the real endpoints so the server's own
 * validators are what call it legal.
 *
 * The author is a machine account on purpose. The signed-in human keeps a
 * short display name, because the header's own account chip overflows the page
 * under a long one (T-500) and would make every page-level number here green
 * or red for somebody else's reason.
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  probeRefRowWidth,
  probeShortRowParity,
} from "./browser/search-wrap-probe.mjs";
import { evaluate, startBrowser } from "./lib/browser-cdp.mjs";
import { createBrowserStack } from "./lib/browser-stack.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 1 };

const HELP = `search-wrap-smoke — search jump rows at 390px (T-446)

Usage: node scripts/search-wrap-smoke.mjs [--keep] [--help]

Drives the real offer panel and the real jump banner over a schema-maximal
comment ref, and grades each surface by the number that can see its own failure:
the banner by document.scrollWidth, the panel by its own scrollWidth. The
page-level number is *required to stay green* in the panel's red case, which is
what stops the two criteria being swapped for one another.

Each surface is then re-measured with the pre-fix markup put back — \`shrink-0\`
on the ref token and every allocated width removed, both halves at once — and
has to go red, then green again once it is restored.

Finally four short refs (plain, comment, slug-qualified, and one typed at a
moved card's old address) are compared child by child against a replica of the
pre-fix markup built in the same row box, which must be identical; taking the
row's \`items-center\` away is that check's required red.

--keep  Retain isolated artifacts under .tmp/ after cleanup.
CHROMIUM overrides /usr/bin/chromium. Uses en-US / UTC for reproducibility.
Exit codes: 0 pass, 1 layout/fault assertion, 2 infrastructure/coverage error.
`;

/** Schema maxima, spelled without a hyphen: a hyphen is a break opportunity. */
const LONG_SLUG = "a".repeat(64);
const LONG_PREFIX = "Z".repeat(20);
const LONG_LOGIN = "b".repeat(64);
const HOME = "home";
const MIRROR = "mirror";

async function seed(stack) {
  let cookie = "";
  const call = async (method, path, body, token = null) => {
    const response = await fetch(`${stack.serverUrl}/api${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token === null
          ? cookie
            ? { cookie }
            : {}
          : { authorization: `Bearer ${token}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie && token === null) cookie = setCookie.split(";", 1)[0];
    if (!response.ok) {
      throw new Error(
        `${method} ${path}: ${response.status} ${await response.text()}`,
      );
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };

  await call("POST", "/auth/login");
  // Short on purpose; see the header note at the top of this file.
  await call("PATCH", "/me", { display_name: "Dev" });

  const project = async (slug, name, prefix) => {
    await call("POST", "/projects", { slug, name, description: "" });
    await call("PUT", `/projects/${slug}/references/format`, { prefix });
  };
  await project(HOME, "Home", "H");
  await project(MIRROR, "Mirror", "M");
  await project(LONG_SLUG, "A project with a very long slug", LONG_PREFIX);

  const agent = await call("POST", "/agents", {
    login: LONG_LOGIN,
    display_name: LONG_LOGIN,
  });
  const issued = await call("POST", `/agents/${agent.id}/tokens`, {
    name: "search-wrap-smoke",
  });
  // Without membership the comment is a 404 and the row never becomes ready.
  await call("POST", `/projects/${LONG_SLUG}/members`, {
    login: LONG_LOGIN,
    role: "writer",
  });

  const issue = (slug, title) =>
    call("POST", `/projects/${slug}/issues`, { title, body: "seed" });

  const plain = await issue(HOME, "The card a short ref names");
  const note = await call(
    "POST",
    `/projects/${HOME}/issues/${plain.number}/comments`,
    { body: "A note by the signed-in human, whose name is short." },
  );
  for (let n = 0; n < 2; n++) await issue(MIRROR, `Mirror card ${n + 1}`);
  const qualified = await issue(MIRROR, "The card a qualified ref names");
  const travelling = await issue(MIRROR, "The card that moved house");
  const moved = await call(
    "POST",
    `/projects/${MIRROR}/issues/${travelling.number}/move`,
    { to_project: HOME, dry_run: false },
  );

  const long = await issue(LONG_SLUG, "A card in the project with a long slug");
  await issue(LONG_SLUG, "Another card, so the project offer has a peek");
  const longNote = await call(
    "POST",
    `/projects/${LONG_SLUG}/issues/${long.number}/comments`,
    { body: "A note by an author with a name at the schema's maximum." },
    issued.token,
  );

  const longRef = `${LONG_SLUG}/${LONG_PREFIX}-${long.number}#comment-${longNote.id}`;
  return {
    cookie,
    webUrl: stack.webUrl,
    longRef,
    // Every one of these is a short ref: what the reverse check grades is that
    // a row with room to spare was not touched at all.
    short: [
      { typed: `H-${plain.number}`, spelled: `H-${plain.number}` },
      {
        typed: `H-${plain.number}#comment-${note.id}`,
        spelled: `H-${plain.number}#comment-${note.id}`,
      },
      {
        typed: `M-${qualified.number}`,
        spelled: `${MIRROR}/M-${qualified.number}`,
      },
      {
        typed: `${MIRROR}/M-${travelling.number}`,
        spelled: `H-${moved.moved_to.number}`,
      },
    ],
  };
}

async function waitFor(page, fn, args, what, budgetMs = 30_000) {
  const deadline = Date.now() + budgetMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(page, fn, ...args);
    if (last === true) return;
    await sleep(100);
  }
  throw new Error(`${what} never happened (last: ${JSON.stringify(last)})`);
}

async function openPage(browser, context, fixture, path) {
  const equals = fixture.cookie.indexOf("=");
  const url = `${fixture.webUrl}${path}`;
  const page = await browser.newPage({
    context,
    // `mobile: false` so the widths below are literal CSS pixels rather than a
    // mobile viewport's scaled ones; every media query this page reads is a
    // width query, and 390 is 390 either way.
    viewport: { ...VIEWPORT, mobile: false },
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
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
}

/** The banner, on the search page a shared `?q=` link lands on. */
async function openBanner(browser, context, fixture, ref) {
  const page = await openPage(
    browser,
    context,
    fixture,
    `/projects/${HOME}/search?q=${encodeURIComponent(ref)}`,
  );
  try {
    await waitFor(
      page,
      (spelled) => {
        const panel = document.querySelector('[role="listbox"]');
        const rows = [...document.querySelectorAll("[data-jump-row]")].filter(
          (row) => panel === null || !panel.contains(row),
        );
        return rows.some(
          (row) =>
            row
              .querySelector("[data-jump-part][title]")
              ?.getAttribute("title") === spelled,
        );
      },
      [ref],
      "the jump banner",
    );
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
}

/** The offer panel, opened the way a narrow header opens it. */
async function openPanel(browser, context, fixture, typed, expected) {
  const page = await openPage(browser, context, fixture, `/projects/${HOME}`);
  try {
    await waitFor(
      page,
      () => document.querySelector('[aria-label="Search"]') !== null,
      [],
      "the narrow header's search control",
    );
    await evaluate(page, () =>
      document.querySelector('[aria-label="Search"]').click(),
    );
    await waitFor(
      page,
      () =>
        document.activeElement ===
        document.querySelector('[aria-label="Search this project"]'),
      [],
      "the search box taking focus",
    );
    // Real editing rather than an assignment to `value`: a controlled React
    // input ignores the latter and the offer would never be asked for.
    await page.send("Input.insertText", { text: typed });
    await waitFor(
      page,
      (want) => {
        const panel = document.querySelector('[role="listbox"]');
        if (panel === null) return { panel: null };
        const titles = [
          ...panel.querySelectorAll("[data-jump-row] [data-jump-part][title]"),
        ].map((token) => token.getAttribute("title"));
        return (
          titles.filter((title) => want.includes(title)).length ===
            want.length || { titles }
        );
      },
      [expected],
      `the offer for ${JSON.stringify(typed)}`,
    );
    return page;
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
  /**
   * `requiredRed` says which failures a red case is a red *for*; without it a
   * fault passes on any complaint, including one it was never meant to cause.
   * `requiredGreen` is the other half, and the reason this file exists: the
   * panel's red case has to leave `document-scroll-overflow` absent, or the
   * two surfaces' criteria are interchangeable after all.
   */
  const record = (
    name,
    result,
    { expectRed = false, requiredRed = null, requiredGreen = [] } = {},
  ) => {
    const coverageErrors = [...(result.coverageErrors ?? [])];
    if (result.viewportWidth !== undefined && result.viewportWidth !== 390) {
      coverageErrors.push("expected-390px-viewport");
    }
    const failures = result.failures ?? [];
    const held = requiredGreen.filter((failure) => failures.includes(failure));
    const red =
      requiredRed === null
        ? failures.length > 0
        : requiredRed.every((failure) => failures.includes(failure));
    const green = failures.length === 0;
    const pass =
      coverageErrors.length === 0 &&
      held.length === 0 &&
      (expectRed ? !green && red : green);
    const entry = {
      name,
      status: pass ? "pass" : "fail",
      expectRed,
      requiredRed,
      requiredGreen,
      brokenGreen: held,
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
      prefix: "search-wrap-smoke-",
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
      // The banner: nothing contains it, so the page is what moves.
      const banner = await openBanner(
        browser,
        context,
        fixture,
        fixture.longRef,
      );
      try {
        const options = { surface: "banner", spelled: fixture.longRef };
        record(
          "banner-green",
          await evaluate(banner, probeRefRowWidth, options),
        );
        record(
          "banner-rigid-token-red",
          await evaluate(banner, probeRefRowWidth, options, {
            rigidToken: true,
          }),
          { expectRed: true, requiredRed: ["document-scroll-overflow"] },
        );
        record(
          "banner-restored-green",
          await evaluate(banner, probeRefRowWidth, options),
        );
      } finally {
        await banner.close();
      }

      // The panel: `overflow-y-auto` makes it its own horizontal scroller, so
      // the page never moves and only the panel's own number can see this.
      const comment = await openPanel(
        browser,
        context,
        fixture,
        fixture.longRef,
        [fixture.longRef],
      );
      try {
        const options = { surface: "panel", spelled: fixture.longRef };
        record(
          "panel-comment-green",
          await evaluate(comment, probeRefRowWidth, options),
        );
        record(
          "panel-comment-rigid-token-red",
          await evaluate(comment, probeRefRowWidth, options, {
            rigidToken: true,
          }),
          {
            expectRed: true,
            requiredRed: ["panel-scroll-overflow"],
            requiredGreen: ["document-scroll-overflow"],
          },
        );
        record(
          "panel-comment-restored-green",
          await evaluate(comment, probeRefRowWidth, options),
        );
      } finally {
        await comment.close();
      }

      // The same panel over the rows whose tokens todou never formatted: the
      // project offer spells what was typed, and each peeked card spells that
      // with its own number stuck on.
      const typed = `${LONG_SLUG}/`;
      const offers = await openPanel(browser, context, fixture, typed, [
        typed,
        `${typed}1`,
      ]);
      try {
        const options = { surface: "panel", spelled: typed, minimumRows: 2 };
        record(
          "panel-project-green",
          await evaluate(offers, probeRefRowWidth, options),
        );
        record(
          "panel-project-rigid-token-red",
          await evaluate(offers, probeRefRowWidth, options, {
            rigidToken: true,
          }),
          {
            expectRed: true,
            requiredRed: ["panel-scroll-overflow"],
            requiredGreen: ["document-scroll-overflow"],
          },
        );
        record(
          "panel-project-restored-green",
          await evaluate(offers, probeRefRowWidth, options),
        );
      } finally {
        await offers.close();
      }

      // The other direction, once per spelling a short ref comes in.
      for (const [index, short] of fixture.short.entries()) {
        const page = await openPanel(browser, context, fixture, short.typed, [
          short.spelled,
        ]);
        try {
          const options = { spelled: short.spelled };
          const label = `short-${index}-${short.spelled.replace(/\W+/g, "-")}`;
          record(
            `${label}-unchanged`,
            await evaluate(page, probeShortRowParity, options),
          );
          // One row is enough to prove this check can fail; running the fault
          // on every spelling would grade the same mechanism four times.
          if (index === 0) {
            record(
              `${label}-items-start-red`,
              await evaluate(page, probeShortRowParity, options, {
                itemsStart: true,
              }),
              { expectRed: true, requiredRed: ["short-ref-offset-changed"] },
            );
            record(
              `${label}-restored`,
              await evaluate(page, probeShortRowParity, options),
            );
          }
        } finally {
          await page.close();
        }
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
    console.error(`search-wrap-smoke: ${error.stack ?? error}`);
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
    name: "search-wrap-smoke",
    status: exitCode === 0 ? "pass" : "fail",
    exitCode,
    versions: stack?.versions ?? null,
    cases,
  };
  console.log(`REPORT ${JSON.stringify(report)}`);
  if (stack?.dir && existsSync(stack.dir)) {
    writeFileSync(
      resolve(stack.dir, "search-wrap-smoke-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  return exitCode;
}

process.exitCode = await main();
