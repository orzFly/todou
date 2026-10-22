#!/usr/bin/env node
/**
 * Real-input regression for the attachment viewer's image zoom (T-535).
 * Usage: node scripts/image-zoom-smoke.mjs [--keep] [--help]
 * Requires the same installed dependencies, Node 24+, flock and CHROMIUM
 * (default /usr/bin/chromium) as the other browser smokes.
 * Exit: 0 every case as expected; 1 an assertion; 2 infrastructure failure.
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { evaluate, startBrowser } from "./lib/browser-cdp.mjs";
import { createBrowserStack } from "./lib/browser-stack.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HELP = `image-zoom-smoke — wheel, drag, click, pinch and the title-bar zoom group

Usage: node scripts/image-zoom-smoke.mjs [--keep] [--help]

Seeds an issue with a large and a 48px image, opens the attachment viewer and
drives it with CDP input (mouse wheel, ctrl+wheel, press/move/release, touch),
never with synthetic DOM events: the canvas's wheel listener must be
non-passive, and only trusted input tells whether it is.

Then the same desktop cases run twice more with a fault that swallows one input
channel before the canvas sees it. Each fault names the cases it must turn red,
so a pass is evidence the case depends on the canvas and not on chance.

--keep  Retain isolated artifacts under .tmp/ after cleanup.
Exit codes: 0 pass, 1 assertion, 2 infrastructure error.
`;

const DESKTOP = { width: 1440, height: 1000, deviceScaleFactor: 1 };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };

function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), row + 1 + x * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function seed(stack) {
  let cookie = "";
  const call = async (method, path, body, form) => {
    const response = await fetch(`${stack.serverUrl}/api${path}`, {
      method,
      headers: {
        ...(form ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
      },
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal: AbortSignal.timeout(15_000),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";", 1)[0];
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
  await call("POST", "/auth/login");
  const slug = "image-zoom-smoke";
  await call("POST", "/projects", { slug, name: "Zoom", description: "" });
  const issue = await call("POST", `/projects/${slug}/issues`, {
    title: "Images",
    body: "",
  });
  const files = [
    // Large enough to be downscaled at fit in both viewports.
    [
      "sheet.png",
      png(1800, 2600, (x, y) => [
        (x * 7) & 255,
        (y * 3) & 255,
        ((x ^ y) * 5) & 255,
      ]),
    ],
    [
      "icon.png",
      png(48, 48, (x, y) =>
        ((x >> 3) + (y >> 3)) % 2 ? [139, 92, 246] : [251, 191, 36],
      ),
    ],
    // Paged to last: an image that never loads has nothing to zoom.
    ["broken.png", Buffer.from("not a png")],
  ];
  const uploaded = [];
  for (const [name, bytes] of files) {
    const form = new FormData();
    form.append("file", new File([bytes], name, { type: "image/png" }));
    form.append("issue_number", String(issue.number));
    uploaded.push(
      await call("POST", `/projects/${slug}/attachments`, undefined, form),
    );
  }
  if (!cookie.includes("="))
    throw new Error("seed did not receive an auth cookie");
  return {
    cookie,
    issueUrl: `${stack.webUrl}/projects/${slug}/issues/${issue.number}`,
    names: uploaded.map((a) => a.filename),
  };
}

/** Canvas geometry as the page sees it, read back from the rendered DOM. */
function readState() {
  const canvas = document.querySelector("[data-testid=image-canvas]");
  if (!canvas) return null;
  const img = canvas.querySelector("img");
  const m = img.style.transform.match(
    /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/,
  );
  const rect = canvas.getBoundingClientRect();
  const dialog = document.querySelector("[role=dialog]");
  const title = dialog.querySelector("h2");
  const button = (label) =>
    dialog.querySelector(`button[aria-label="${label}"]`);
  const readout = button("zoom to fit") ?? button("zoom to actual size");
  const sameRow = (el) =>
    el !== null && el.parentElement.closest("div") === title.parentElement;
  return {
    title: title.textContent,
    rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    view: m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : null,
    fit: Number(canvas.dataset.fit),
    natural: { w: img.naturalWidth, h: img.naturalHeight },
    cursor: getComputedStyle(canvas).cursor,
    readout: readout?.textContent ?? null,
    readoutLabel: readout?.getAttribute("aria-label") ?? null,
    zoomOutDisabled: button("zoom out")?.disabled ?? null,
    groupInTitleBar:
      [button("zoom out"), readout, button("zoom in")].every(sameRow) &&
      sameRow(button("maximize") ?? button("restore size")),
    scrollY: window.scrollY,
  };
}

const FAULTS = {
  // Swallowed at the window in the capture phase: the canvas never hears it.
  wheel: `addEventListener("wheel", (e) => e.stopImmediatePropagation(), { capture: true, passive: true });`,
  pointer: `for (const t of ["pointerdown", "pointermove", "pointerup"]) addEventListener(t, (e) => { if (e.target.closest?.("[data-testid=image-canvas]")) e.stopImmediatePropagation(); }, { capture: true });`,
};

async function openViewer(context, fixture, viewport, fault) {
  const equals = fixture.cookie.indexOf("=");
  const page = await context.newPage({
    viewport,
    cookie: {
      name: fixture.cookie.slice(0, equals),
      value: fixture.cookie.slice(equals + 1),
      url: fixture.issueUrl,
    },
    scripts: fault ? [FAULTS[fault]] : [],
  });
  if (viewport.mobile)
    await page.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5,
    });
  await page.navigate(fixture.issueUrl);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const opened = await evaluate(
      page,
      (name) => {
        const link = document.querySelector(`a[href$="/view/${name}"]`);
        if (!link) return false;
        if (!document.querySelector("[role=dialog]")) link.click();
        return true;
      },
      fixture.names[0],
    );
    if (opened) {
      const state = await evaluate(page, readState);
      if (state?.view && state.fit > 0) return page;
    }
    await sleep(200);
  }
  await page.close();
  throw new Error("viewer never showed a measured image");
}

function input(page) {
  const mouse = (type, x, y, extra = {}) =>
    page.send("Input.dispatchMouseEvent", { type, x, y, ...extra });
  return {
    state: async () => {
      await sleep(120);
      return evaluate(page, readState);
    },
    wheel: async (x, y, deltaY, times, modifiers = 0) => {
      await mouse("mouseMoved", x, y);
      for (let i = 0; i < times; i++) {
        await mouse("mouseWheel", x, y, { deltaX: 0, deltaY, modifiers });
        await sleep(20);
      }
    },
    click: async (x, y) => {
      await mouse("mouseMoved", x, y);
      await mouse("mousePressed", x, y, { button: "left", clickCount: 1 });
      await mouse("mouseReleased", x, y, { button: "left", clickCount: 1 });
    },
    drag: async (x, y, dx, dy) => {
      await mouse("mouseMoved", x, y);
      await mouse("mousePressed", x, y, { button: "left", clickCount: 1 });
      for (let i = 1; i <= 10; i++)
        await mouse("mouseMoved", x + (dx * i) / 10, y + (dy * i) / 10, {
          button: "left",
          buttons: 1,
        });
      await mouse("mouseReleased", x + dx, y + dy, {
        button: "left",
        clickCount: 1,
      });
    },
    key: async (key, code, keyCode) => {
      await page.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key,
        code,
        windowsVirtualKeyCode: keyCode,
      });
      await page.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        code,
        windowsVirtualKeyCode: keyCode,
      });
    },
    press: (label) =>
      evaluate(
        page,
        (l) =>
          document
            .querySelector(`[role=dialog] button[aria-label="${l}"]`)
            ?.click(),
        label,
      ),
    touch: (type, points) =>
      page.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: points.map(([x, y], id) => ({ x, y, id })),
      }),
  };
}

/** Image pixel under a client point; zoom about the pointer must hold it still. */
const pixelAt = (s, cx, cy) => ({
  x: (cx - s.rect.x - s.view.x) / s.view.z,
  y: (cy - s.rect.y - s.view.y) / s.view.z,
});
const near = (a, b, tol) => Math.abs(a - b) <= tol;

async function desktopCases(page) {
  const io = input(page);
  const out = [];
  const check = (name, ok, detail) =>
    out.push({ name, ok: Boolean(ok), detail });

  const s0 = await io.state();
  check(
    "fit-title-bar-group",
    near(s0.view.z, s0.fit, 1e-4) &&
      s0.fit < 1 &&
      s0.cursor === "zoom-in" &&
      s0.groupInTitleBar &&
      s0.zoomOutDisabled === true &&
      s0.readout === `${Math.round(s0.fit * 100)}%` &&
      s0.readoutLabel === "zoom to actual size",
    s0,
  );

  // The middle of the canvas: off-centre, the zoomed image would rightly be
  // pulled flush to an edge and the pointer anchor would move with it.
  const px = s0.rect.x + s0.rect.w * 0.5;
  const py = s0.rect.y + s0.rect.h * 0.4;
  const before = pixelAt(s0, px, py);
  await io.wheel(px, py, -100, 5);
  const s1 = await io.state();
  const after = pixelAt(s1, px, py);
  check(
    "wheel-zooms-about-pointer",
    s1.view.z > s0.view.z * 2 &&
      near(before.x, after.x, 1) &&
      near(before.y, after.y, 1) &&
      s1.cursor === "grab" &&
      s1.scrollY === s0.scrollY &&
      s1.readout === `${Math.round(s1.view.z * 100)}%` &&
      s1.zoomOutDisabled === false,
    { before, after, z0: s0.view.z, z1: s1.view.z },
  );

  // Room in the drag direction must exist, or "moved by exactly dx" is a clamp.
  const roomX = -s1.view.x;
  const roomY = -s1.view.y;
  await io.drag(px, py, 60, 40);
  const s2 = await io.state();
  check(
    "drag-pans",
    roomX >= 60 &&
      roomY >= 40 &&
      near(s2.view.x - s1.view.x, 60, 0.5) &&
      near(s2.view.y - s1.view.y, 40, 0.5) &&
      near(s2.view.z, s1.view.z, 1e-6),
    { roomX, roomY, dx: s2.view.x - s1.view.x, dy: s2.view.y - s1.view.y },
  );

  await io.drag(px, py, 4000, 4000);
  const s3 = await io.state();
  check("drag-clamps-at-edge", s3.view.x === 0 && s3.view.y === 0, s3.view);

  await io.click(px, py);
  const s4 = await io.state();
  check(
    "click-zoomed-returns-to-fit",
    near(s4.view.z, s4.fit, 1e-4) && s4.cursor === "zoom-in",
    s4.view,
  );

  const b5 = pixelAt(s4, px, py);
  await io.click(px, py);
  const s5 = await io.state();
  const a5 = pixelAt(s5, px, py);
  check(
    "click-fit-zooms-to-actual-size",
    near(s5.view.z, Math.max(1, s5.fit * 2), 1e-4) &&
      near(b5.x, a5.x, 1) &&
      near(b5.y, a5.y, 1) &&
      s5.readout === "100%" &&
      s5.readoutLabel === "zoom to fit",
    { z: s5.view.z, before: b5, after: a5 },
  );

  await io.press("zoom to fit");
  const s6 = await io.state();
  await io.press("zoom in");
  const s7 = await io.state();
  check(
    "title-bar-buttons",
    near(s6.view.z, s6.fit, 1e-4) && near(s7.view.z, s6.fit * 1.25, 1e-4),
    { fit: s6.view.z, in: s7.view.z },
  );

  await io.wheel(px, py, -8, 10, 2);
  const s8 = await io.state();
  check(
    "ctrl-wheel-pinch-zooms",
    s8.view.z > s7.view.z * 1.5 && s8.scrollY === s0.scrollY,
    {
      from: s7.view.z,
      to: s8.view.z,
    },
  );

  await io.press("maximize");
  await sleep(300);
  const s9 = await io.state();
  check(
    "maximize-keeps-zoom",
    near(s9.view.z, s8.view.z, 1e-4) &&
      s9.rect.w > s8.rect.w &&
      s9.groupInTitleBar,
    { before: s8.view.z, after: s9.view.z },
  );

  await io.key("ArrowRight", "ArrowRight", 39);
  await sleep(500);
  const s10 = await io.state();
  check(
    "paging-small-image-maximized-upscales",
    s10.natural.w === 48 &&
      s10.view.z > 1 &&
      near(s10.view.z, s10.fit, 1e-4) &&
      near(s10.view.z, Math.min(s10.rect.w, s10.rect.h) / 48, 1e-3),
    { title: s10.title, z: s10.view.z, fit: s10.fit },
  );

  await io.press("restore size");
  await sleep(300);
  const s11 = await io.state();
  check(
    "restored-small-image-not-upscaled",
    s11.natural.w === 48 && s11.view.z === 1,
    s11.view,
  );

  await io.key("ArrowLeft", "ArrowLeft", 37);
  await sleep(500);
  const s12 = await io.state();
  check(
    "paging-back-starts-at-fit",
    s12.natural.w === 1800 && near(s12.view.z, s12.fit, 1e-4),
    s12.view,
  );

  await io.key("ArrowLeft", "ArrowLeft", 37);
  await sleep(800);
  const broken = await evaluate(page, () => {
    const dialog = document.querySelector("[role=dialog]");
    const img = dialog.querySelector('img[alt="broken.png"]');
    return {
      title: dialog.querySelector("h2").textContent,
      canvas: dialog.querySelector("[data-testid=image-canvas]") !== null,
      zoomButtons: dialog.querySelectorAll('button[aria-label^="zoom"]').length,
      visible: img !== null && getComputedStyle(img).visibility === "visible",
    };
  });
  check(
    "broken-image-falls-back",
    broken.title === "broken.png" &&
      !broken.canvas &&
      broken.zoomButtons === 0 &&
      broken.visible,
    broken,
  );
  return out;
}

async function phoneCases(page) {
  const io = input(page);
  const out = [];
  const s0 = await io.state();
  const mx = s0.rect.x + s0.rect.w / 2;
  const my = s0.rect.y + s0.rect.h * 0.4;
  await io.touch("touchStart", [[mx - 20, my]]);
  await io.touch("touchStart", [
    [mx - 20, my],
    [mx + 20, my],
  ]);
  for (let i = 1; i <= 12; i++) {
    await io.touch("touchMove", [
      [mx - 20 - i * 6, my],
      [mx + 20 + i * 6, my],
    ]);
    await sleep(16);
  }
  await io.touch("touchEnd", []);
  const s1 = await io.state();
  const spread = (40 + 12 * 12) / 40;
  out.push({
    name: "pinch-scales-with-finger-spread",
    ok: near(s1.view.z / s0.view.z, spread, spread * 0.02),
    detail: { spread, ratio: s1.view.z / s0.view.z },
  });
  await io.touch("touchStart", [[mx, my]]);
  for (let i = 1; i <= 8; i++) {
    await io.touch("touchMove", [[mx + i * 5, my + i * 5]]);
    await sleep(16);
  }
  await io.touch("touchEnd", []);
  const s2 = await io.state();
  out.push({
    name: "one-finger-pans-when-zoomed",
    ok:
      near(s2.view.x - s1.view.x, 40, 0.5) &&
      near(s2.view.y - s1.view.y, 40, 0.5),
    detail: { dx: s2.view.x - s1.view.x, dy: s2.view.y - s1.view.y },
  });
  return out;
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
  const runs = [];
  const record = (name, cases, requiredRed = []) => {
    const red = cases.filter((c) => !c.ok).map((c) => c.name);
    const pass =
      requiredRed.length === 0
        ? red.length === 0
        : requiredRed.every((n) => red.includes(n));
    runs.push({
      name,
      status: pass ? "pass" : "fail",
      requiredRed,
      red,
      cases,
    });
    console.log(`RUN ${JSON.stringify({ name, pass, requiredRed, red })}`);
    for (const c of cases)
      console.log(
        `  ${c.ok ? "ok  " : "RED "} ${c.name} ${JSON.stringify(c.detail)}`,
      );
    if (!pass) exitCode = Math.max(exitCode, 1);
  };

  try {
    stack = await createBrowserStack({
      root: ROOT,
      prefix: "image-zoom-smoke-",
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
      for (const [name, fault, requiredRed] of [
        ["desktop", null, []],
        // The first case that needs the channel; later ones start from its
        // missing state, so only the direct dependants are named.
        [
          "fault-wheel-swallowed",
          "wheel",
          ["wheel-zooms-about-pointer", "ctrl-wheel-pinch-zooms"],
        ],
        [
          "fault-pointer-swallowed",
          "pointer",
          ["drag-pans", "click-fit-zooms-to-actual-size"],
        ],
      ]) {
        const page = await openViewer(context, fixture, DESKTOP, fault);
        try {
          record(name, await desktopCases(page), requiredRed);
        } finally {
          await page.close();
        }
      }
      for (const [name, fault, requiredRed] of [
        ["phone", null, []],
        [
          "fault-phone-pointer-swallowed",
          "pointer",
          ["pinch-scales-with-finger-spread"],
        ],
      ]) {
        const page = await openViewer(context, fixture, PHONE, fault);
        try {
          record(name, await phoneCases(page), requiredRed);
        } finally {
          await page.close();
        }
      }
    } finally {
      await context.close();
    }
  } catch (error) {
    exitCode = 2;
    runs.push({
      name: "runner-error",
      status: "fail",
      error: error.stack ?? String(error),
    });
    console.error(`image-zoom-smoke: ${error.stack ?? error}`);
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
        runs.push({
          name: "cleanup-error",
          status: "fail",
          error: error.stack ?? String(error),
        });
      }
    }
  }
  const report = {
    name: "image-zoom-smoke",
    status: exitCode === 0 ? "pass" : "fail",
    exitCode,
    runs,
  };
  console.log(`REPORT ${JSON.stringify({ status: report.status, exitCode })}`);
  if (stack?.dir && existsSync(stack.dir)) {
    writeFileSync(
      resolve(stack.dir, "image-zoom-smoke-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  return exitCode;
}

process.exitCode = await main();
