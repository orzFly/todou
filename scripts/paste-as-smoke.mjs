#!/usr/bin/env node
/**
 * Manual real-browser checks for pasting as Markdown, plain text and quotes
 * (T-577). Independent of `pnpm test`/CI: which clipboard types a real
 * Ctrl+V, Ctrl+Shift+V and Ctrl+Alt+V hand the page, and whether a key
 * reaches the editor before the browser's own paste, are things happy-dom
 * has no opinion about.
 *
 * Every paste here is a real key press. The clipboard is filled by a real
 * Ctrl+C whose copy event the page answers with the fixture's types — the
 * one route that can put a custom type such as `vscode-editor-data` there —
 * or, for the file case, by `navigator.clipboard.write` with a PNG.
 *
 * Usage: node scripts/paste-as-smoke.mjs [--keep] [--help]
 * Preconditions: the devshell's Node 24+, installed workspace dependencies,
 * `flock`, and CHROMIUM (default /usr/bin/chromium). The runner starts one
 * isolated API/Vite stack and one browser, and seeds its own project and
 * issue through the real API.
 * Exit codes: 0 all checks pass; 1 a named assertion fails; 2 bad CLI input,
 * missing prerequisite, startup failure, or a check that could not reach the
 * thing it grades (a coverage failure).
 * Limitations: Chromium on Linux only. The order of macOS's ⌥⇧⌘V menu item
 * against the page, Windows AltGr layouts, and the paste prompt Firefox and
 * Safari show for `clipboard.read()` are neither exercised nor claimed.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { evaluate, startBrowser } from "./lib/browser-cdp.mjs";
import { createBrowserStack } from "./lib/browser-stack.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const HELP = `paste-as-smoke — real-browser checks for T-577

Usage:
  node scripts/paste-as-smoke.mjs

Options:
  --keep       Keep the isolated stack directory after the run.
  --help       Print this help and exit.

Exit codes:
  0 checks passed; 1 a named assertion failed; 2 usage, prerequisite,
  startup, cleanup, or a check that never reached its target.
`;

const COVERAGE_FAILURES = new Set([
  "case-exception",
  "converter-never-loaded",
  "editor-missing",
  "copy-did-not-happen",
  "toolbar-missing",
  "help-missing",
]);

const CTRL = 2;
const ALT = 1;
const SHIFT = 8;

const PAGE = {
  "text/plain": "See the guide first.\n\nThen read the notes.",
  "text/html":
    '<meta charset="utf-8"><p>See <a href="https://example.com/guide">the guide</a> first.</p><p>Then read <a href="https://example.com/notes">the notes</a>.</p>',
};
const PAGE_MD =
  "See [the guide](https://example.com/guide) first.\n\nThen read [the notes](https://example.com/notes).";
const HEADING = {
  "text/plain": "Release notes",
  "text/html": '<meta charset="utf-8"><h1>Release notes</h1>',
};
const VSCODE = {
  "text/plain": "const a = 1;\nconst b = 2;",
  "text/html":
    '<meta charset="utf-8"><div style="color: #cccccc;background-color: #1f1f1f;font-family: monospace;white-space: pre;"><div><span style="color: #569cd6;">const</span><span> a = 1;</span></div><div><span style="color: #569cd6;">const</span><span> b = 2;</span></div></div>',
  "vscode-editor-data": JSON.stringify({
    version: 1,
    isFromEmptySelection: false,
    multicursorText: null,
    mode: "typescript",
  }),
};

function failure(name, detail, extra = {}) {
  return { name, detail, ...extra };
}

async function seed(serverPort) {
  const base = `http://127.0.0.1:${serverPort}/api`;
  let cookie = "";
  const call = async (method, path, payload) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
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
  const slug = `t577-${randomUUID().slice(0, 8)}`;
  await call("POST", "/projects", { slug, name: "Paste as" });
  const issue = await call("POST", `/projects/${slug}/issues`, {
    title: "A card to comment on",
    body: "seed",
  });
  return { cookie, slug, number: issue.number };
}

/** Page-side helpers: the editor's document, and a copy answered with fixtures. */
const PROBE = `(() => {
  const api = (window.__t577 = { pasteTypes: [], copies: 0 });
  document.addEventListener('paste', (event) => {
    api.pasteTypes.push([...(event.clipboardData?.types ?? [])]);
  }, true);
  document.addEventListener('copy', (event) => {
    if (!api.fixture) return;
    for (const [type, value] of Object.entries(api.fixture)) {
      event.clipboardData.setData(type, value);
    }
    api.fixture = null;
    api.copies += 1;
    event.preventDefault();
  }, true);
  api.view = (selector) => {
    const content = document.querySelector(selector + ' .cm-content');
    let tile = content && content.cmTile;
    while (tile && !tile.view) tile = tile.parent;
    return tile ? tile.view : null;
  };
  api.copySource = () => {
    let box = document.getElementById('t577-copy-source');
    if (!box) {
      box = document.createElement('textarea');
      box.id = 't577-copy-source';
      box.value = 'copy me';
      box.style.cssText = 'position:fixed;left:0;bottom:0;width:80px;height:20px;';
      document.body.append(box);
    }
    box.focus({ preventScroll: true });
    box.select();
  };
})()`;

async function key(page, keyName, { modifiers = 0, code, keyCode, text } = {}) {
  const shared = {
    modifiers,
    key: keyName,
    code: code ?? `Key${keyName.toUpperCase()}`,
    windowsVirtualKeyCode: keyCode ?? keyName.toUpperCase().charCodeAt(0),
  };
  await page.send("Input.dispatchKeyEvent", {
    type: text === undefined ? "rawKeyDown" : "keyDown",
    ...(text === undefined ? {} : { text }),
    ...shared,
  });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...shared });
}

async function copyFixture(page, fixture) {
  const before = await evaluate(page, () => window.__t577.copies);
  await evaluate(
    page,
    (data) => {
      window.__t577.fixture = data;
      window.__t577.copySource();
    },
    fixture,
  );
  await key(page, "c", { modifiers: CTRL });
  const after = await evaluate(page, () => window.__t577.copies);
  return after === before + 1;
}

/** Put the document and caret in place, focused, through the real view. */
async function prepare(page, editor, doc, at = doc.length) {
  return evaluate(
    page,
    (selector, text, anchor) => {
      const view = window.__t577.view(selector);
      if (view === null) return false;
      view.focus();
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor },
      });
      return true;
    },
    editor,
    doc,
    at,
  );
}

async function docOf(page, editor) {
  return evaluate(
    page,
    (selector) => window.__t577.view(selector)?.state.doc.toString() ?? null,
    editor,
  );
}

async function settle(page) {
  await evaluate(
    page,
    () =>
      new Promise((done) => requestAnimationFrame(() => setTimeout(done, 50))),
  );
}

async function clickButton(page, selector) {
  const box = await evaluate(
    page,
    (css) => {
      const el = [...document.querySelectorAll(css)].find(
        (candidate) => candidate.offsetParent !== null,
      );
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    },
    selector,
  );
  if (box === null) return false;
  for (const type of ["mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", {
      type,
      x: box.x,
      y: box.y,
      button: "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: 1,
    });
  }
  await settle(page);
  return true;
}

const TOOLBAR = '[role="toolbar"][aria-label="Paste options"]';
const toolbarButton = (label) =>
  `${TOOLBAR} button:not([hidden])[data-${label === "Quote" ? "quote" : `form="${label === "Markdown" ? "markdown" : "plain"}"`}]`;

/**
 * The checks every editor surface gets: criterion 1 (Markdown links, then
 * quoted lines), and the toolbar by mouse and by keyboard (criterion 5).
 */
async function surfaceChecks(page, editor, where) {
  const failures = [];
  const at = { where };
  const paste = async (modifiers = CTRL) => {
    await key(page, "v", { modifiers });
    await settle(page);
  };
  const ready = async (fixture, doc = "", caret) => {
    if (!(await copyFixture(page, fixture))) {
      failures.push(failure("copy-did-not-happen", "no copy event", at));
      return false;
    }
    if (!(await prepare(page, editor, doc, caret))) {
      failures.push(failure("editor-missing", editor, at));
      return false;
    }
    return true;
  };

  // The converter is prefetched once the editor is idle, and a paste that
  // beats it goes in as plain text by design. Wait for it through the
  // toolbar, which offers Markdown only once the converter has run — not
  // through the document, so a broken default still fails criterion 1.
  let loaded = false;
  for (let attempt = 0; attempt < 50 && !loaded; attempt++) {
    if (!(await ready(PAGE))) return failures;
    await paste();
    loaded = await evaluate(
      page,
      (css) => !!document.querySelector(css),
      toolbarButton("Markdown"),
    );
    if (!loaded) await sleep(200);
  }
  if (!loaded) {
    failures.push(failure("converter-never-loaded", "no Markdown option", at));
    return failures;
  }

  // 1. Mod-V → Markdown links; Mod-Alt-V → every line quoted.
  if (await ready(PAGE)) {
    await paste();
    const got = await docOf(page, editor);
    if (got !== PAGE_MD)
      failures.push(failure("1-markdown", JSON.stringify(got), at));
  }
  if (await ready(PAGE)) {
    await paste(CTRL | ALT);
    await sleep(200);
    const got = (await docOf(page, editor)) ?? "";
    const lines = got.split("\n");
    if (
      !got.includes("[the guide](https://example.com/guide)") ||
      !lines.every((line) => line.startsWith(">"))
    )
      failures.push(failure("1-quote", JSON.stringify(got), at));
  }

  // 5. Mouse: each switch replaces the whole paste; Mod-Z steps back once.
  if (await ready(PAGE, "intro\n")) {
    await paste();
    if (!(await clickButton(page, toolbarButton("Plain text")))) {
      failures.push(failure("toolbar-missing", "no Plain text button", at));
    } else {
      const plain = await docOf(page, editor);
      if (plain !== `intro\n${PAGE["text/plain"]}`)
        failures.push(failure("5-plain", JSON.stringify(plain), at));
      await clickButton(page, toolbarButton("Quote"));
      const quoted = await docOf(page, editor);
      if (
        quoted !== `intro\n\n> See the guide first.\n>\n> Then read the notes.`
      )
        failures.push(failure("5-quote", JSON.stringify(quoted), at));
      await key(page, "z", { modifiers: CTRL });
      await settle(page);
      const undone = await docOf(page, editor);
      if (undone !== plain)
        failures.push(failure("5-undo", JSON.stringify(undone), at));
    }
  }

  // 5. Keyboard: Mod-. into the toolbar, → to Quote, Enter, Esc back.
  if (await ready(PAGE)) {
    await paste();
    await key(page, ".", { modifiers: CTRL, code: "Period", keyCode: 190 });
    await settle(page);
    const focused = await evaluate(page, () =>
      document.activeElement?.closest('[role="toolbar"]')
        ? document.activeElement.textContent
        : null,
    );
    if (focused !== "Markdown") {
      // Mod-. lands on the form in use, so a toolbar reached on the wrong
      // button is a graded failure; no toolbar at all is lost coverage.
      failures.push(
        failure(
          focused === null ? "toolbar-missing" : "5-keyboard-focus",
          `Mod-. focused ${JSON.stringify(focused)}`,
          at,
        ),
      );
    } else {
      await key(page, "ArrowRight", { code: "ArrowRight", keyCode: 39 });
      await key(page, "Enter", { code: "Enter", keyCode: 13, text: "\r" });
      await settle(page);
      const got = await docOf(page, editor);
      if (got !== `> ${PAGE_MD.replace("\n\n", "\n>\n> ")}`)
        failures.push(failure("5-keyboard", JSON.stringify(got), at));
      await key(page, "Escape", { code: "Escape", keyCode: 27 });
      await settle(page);
      const back = await evaluate(
        page,
        (selector) => {
          const view = window.__t577.view(selector);
          return view !== null && document.activeElement === view.contentDOM;
        },
        editor,
      );
      if (!back)
        failures.push(failure("5-escape", "focus not back in editor", at));
    }
  }
  return failures;
}

/** The ? popover: six rows, and only on the two pages that carry it. */
async function helpCheck(page, where) {
  const opened = await clickButton(page, '[aria-label="Keyboard shortcuts"]');
  if (!opened) return [failure("help-missing", "no ? button", { where })];
  const rows = await evaluate(
    page,
    () =>
      document.querySelectorAll('[data-slot="popover-content"] table tr')
        .length,
  );
  await key(page, "Escape", { code: "Escape", keyCode: 27 });
  await settle(page);
  return rows === 6 ? [] : [failure("7-rows", `${rows} rows`, { where })];
}

async function composerChecks(page) {
  const editor =
    '[data-slot="markdown-editor"]:has([aria-label="Write a comment"])';
  const failures = [...(await surfaceChecks(page, editor, "composer"))];
  const at = { where: "composer" };
  const ready = async (fixture, doc = "", caret) =>
    (await copyFixture(page, fixture)) &&
    (await prepare(page, editor, doc, caret));

  // 2. A one-line heading in the middle of a line stays inline.
  if (await ready(HEADING, "Read  today", 5)) {
    await key(page, "v", { modifiers: CTRL });
    await settle(page);
    const got = await docOf(page, editor);
    if (got !== "Read Release notes today")
      failures.push(failure("2-inline-heading", JSON.stringify(got), at));
  } else failures.push(failure("copy-did-not-happen", "heading", at));

  // 3. Mod-Shift-V is the clipboard's text/plain, byte for byte.
  if (await ready(PAGE)) {
    await evaluate(page, () => {
      window.__t577.pasteTypes = [];
    });
    await key(page, "V", {
      modifiers: CTRL | SHIFT,
      code: "KeyV",
      keyCode: 86,
    });
    await settle(page);
    const got = await docOf(page, editor);
    if (got !== PAGE["text/plain"])
      failures.push(failure("3-plain", JSON.stringify(got), at));
    const types = await evaluate(page, () => window.__t577.pasteTypes);
    console.log(`OBSERVED mod-shift-v paste types ${JSON.stringify(types)}`);
  } else failures.push(failure("copy-did-not-happen", "page", at));

  // 4. Code from VS Code goes in as plain text; the toolbar offers a fence.
  if (await ready(VSCODE)) {
    await key(page, "v", { modifiers: CTRL });
    await settle(page);
    const got = await docOf(page, editor);
    if (got !== VSCODE["text/plain"])
      failures.push(failure("4-code-plain", JSON.stringify(got), at));
    if (await clickButton(page, toolbarButton("Markdown"))) {
      const fenced = await docOf(page, editor);
      if (fenced !== "```typescript\nconst a = 1;\nconst b = 2;\n```")
        failures.push(failure("4-code-fence", JSON.stringify(fenced), at));
    } else
      failures.push(failure("toolbar-missing", "no Markdown for code", at));
  } else failures.push(failure("copy-did-not-happen", "vscode", at));

  // 6. A pasted image is staged as a file and leaves the document alone.
  const wrote = await evaluate(page, async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 4;
    canvas.height = 4;
    canvas.getContext("2d").fillRect(0, 0, 4, 4);
    const blob = await new Promise((done) => canvas.toBlob(done, "image/png"));
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      return true;
    } catch (error) {
      return String(error);
    }
  });
  if (wrote !== true) {
    failures.push(failure("copy-did-not-happen", `image: ${wrote}`, at));
  } else if (await prepare(page, editor, "draft")) {
    const before = await evaluate(
      page,
      () => document.querySelectorAll('button[aria-label^="remove "]').length,
    );
    await key(page, "v", { modifiers: CTRL });
    await sleep(300);
    const got = await docOf(page, editor);
    if (got !== "draft")
      failures.push(failure("6-file-doc", JSON.stringify(got), at));
    const after = await evaluate(
      page,
      () => document.querySelectorAll('button[aria-label^="remove "]').length,
    );
    if (after !== before + 1)
      failures.push(
        failure("6-file-staged", `staged ${before} -> ${after}`, at),
      );
  }

  failures.push(...(await helpCheck(page, "composer")));
  return failures;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  const unknown = args.filter((arg) => arg !== "--keep");
  if (unknown.length > 0) {
    console.error(
      `paste-as-smoke: unknown argument ${unknown[0]}\nTry --help.`,
    );
    return 2;
  }
  let stack;
  let browser;
  let exitCode = 0;
  const failures = [];
  try {
    stack = await createBrowserStack({
      root: ROOT,
      prefix: "paste-as-smoke-",
      keep: args.includes("--keep"),
    });
    browser = await startBrowser({
      dir: stack.dir,
      chromium: stack.chromium,
      registerChild: stack.registerChild,
    });
    stack.addCleanup(() => browser.close());
    const fixture = await seed(stack.serverPort);
    const context = await browser.newContext();
    await browser.send("Browser.grantPermissions", {
      browserContextId: context.browserContextId,
      origin: stack.webUrl,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });

    const open = async (path, ready, platform) => {
      const page = await browser.newPage({
        context,
        cookie: fixture.cookie,
        viewport: { width: 1280, height: 900 },
        scripts: [PROBE],
      });
      await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      if (platform) {
        await page.send("Emulation.setUserAgentOverride", {
          userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
          platform,
          // navigator.userAgentData is read first, and keeps the host's
          // platform unless the metadata is overridden too.
          userAgentMetadata: {
            platform: "macOS",
            platformVersion: "14.0.0",
            architecture: "x86",
            model: "",
            mobile: false,
          },
        });
      }
      await page.navigate(`${stack.webUrl}${path}`);
      for (let i = 0; i < 100; i++) {
        if (await evaluate(page, (css) => !!document.querySelector(css), ready))
          return page;
        await sleep(100);
      }
      throw new Error(`${path} never showed ${ready}`);
    };

    const issuePath = `/projects/${fixture.slug}/issues/${fixture.number}`;
    const composer = await open(issuePath, '[aria-label="Write a comment"]');
    try {
      failures.push(...(await composerChecks(composer)));
    } finally {
      await composer.close();
    }

    const newIssue = await open(
      `/projects/${fixture.slug}/issues/new`,
      '[aria-label="Description"]',
    );
    try {
      failures.push(
        ...(await surfaceChecks(
          newIssue,
          '[data-slot="markdown-editor"]:has([aria-label="Description"])',
          "new-issue",
        )),
      );
      failures.push(...(await helpCheck(newIssue, "new-issue")));
    } finally {
      await newIssue.close();
    }

    // 7. Apple's symbols, and no ? on an editor that is neither of the two.
    const mac = await open(
      issuePath,
      '[aria-label="Write a comment"]',
      "MacIntel",
    );
    try {
      const seen = await evaluate(mac, () => ({
        platform: navigator.platform,
        uaData: navigator.userAgentData?.platform ?? null,
      }));
      console.log(`OBSERVED emulated platform ${JSON.stringify(seen)}`);
      // A draft is what unfolds the composer's action row.
      await prepare(
        mac,
        '[data-slot="markdown-editor"]:has([aria-label="Write a comment"])',
        "draft",
      );
      await settle(mac);
      if (!(await clickButton(mac, '[aria-label="Keyboard shortcuts"]')))
        failures.push(failure("help-missing", "no ? button", { where: "mac" }));
      const text = await evaluate(
        mac,
        () =>
          document.querySelector('[data-slot="popover-content"]')
            ?.textContent ?? "",
      );
      if (!text.includes("⌘") || text.includes("Ctrl"))
        failures.push(
          failure("7-apple", JSON.stringify(text), { where: "mac" }),
        );
      await key(mac, "Escape", { code: "Escape", keyCode: 27 });
      await clickButton(mac, '[aria-label="edit body"]');
      await settle(mac);
      const editors = await evaluate(
        mac,
        () => document.querySelectorAll('[data-slot="markdown-editor"]').length,
      );
      const helps = await evaluate(
        mac,
        () =>
          document.querySelectorAll('[aria-label="Keyboard shortcuts"]').length,
      );
      console.log(
        `OBSERVED issue page editors=${editors} help-buttons=${helps}`,
      );
      if (editors >= 2 && helps !== 1)
        failures.push(
          failure("7-only-two", `${helps} ? buttons for ${editors} editors`, {
            where: "mac",
          }),
        );
    } finally {
      await mac.close();
    }
  } catch (error) {
    failures.push(failure("case-exception", error.stack ?? String(error)));
  } finally {
    for (const entry of failures) console.log(`FAIL ${JSON.stringify(entry)}`);
    exitCode =
      failures.length === 0
        ? 0
        : failures.some((entry) => COVERAGE_FAILURES.has(entry.name))
          ? 2
          : 1;
    if (stack) {
      try {
        await stack.cleanup();
      } catch (error) {
        exitCode = 2;
        console.error(`paste-as-smoke cleanup: ${error.stack ?? error}`);
      }
    }
  }
  console.log(
    `REPORT ${JSON.stringify({ name: "paste-as-smoke", exitCode, failures: failures.length })}`,
  );
  return exitCode;
}

process.exitCode = await main();
