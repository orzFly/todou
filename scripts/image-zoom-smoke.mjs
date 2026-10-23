#!/usr/bin/env node
/**
 * Real-input regression for the attachment viewer's image zoom (T-535), its
 * fit / 100% / background / scaling menu (T-537), and the dialog growing
 * with the zoom up to its cap (T-548), tweened, and paging tweened too
 * (T-551).
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
const HELP = `image-zoom-smoke — wheel, drag, click, pinch and the title-bar zoom menu

Usage: node scripts/image-zoom-smoke.mjs [--keep] [--help]

Seeds an issue with a tall, a wide and a 48px image, opens the attachment viewer and
drives it with CDP input (mouse wheel, ctrl+wheel, press/move/release, touch),
never with synthetic DOM events: the canvas's wheel listener must be
non-passive, and only trusted input tells whether it is.

Then the same cases run again under faults that swallow one input channel
before the canvas sees it, block the localStorage write, or show the phone's
hidden − + buttons. Each fault names the cases it must turn red, so a pass is
evidence the case depends on the viewer and not on chance. Every run gets a
fresh browser context, so no run inherits another's stored choices.

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
      // On a phone this name fits beside the readout alone, and truncates
      // once − + stand beside it too (T-537).
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
    // Short at fit, so zooming in has height to grow into (T-548).
    [
      "wide.png",
      png(1600, 400, (x, y) => [(x * 3) & 255, (y * 5) & 255, (x + y) & 255]),
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
  const readout = button("zoom and display options");
  const shown = (el) => el !== null && getComputedStyle(el).display !== "none";
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  };
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
    zoomButtonsShown: [button("zoom out"), button("zoom in")].map(shown),
    titleTruncated: title.scrollWidth > title.clientWidth,
    look: {
      canvasBackground: getComputedStyle(canvas).backgroundColor,
      checker: box(canvas.querySelector("[data-testid=image-checker]")),
      image: box(img),
      rendering: getComputedStyle(img).imageRendering,
      stored: localStorage.getItem("todou:image-look:v1"),
    },
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
  keys: `addEventListener("keydown", (e) => { if (e.key === "0" || e.key === "1") e.stopImmediatePropagation(); }, { capture: true });`,
  // The write goes nowhere; reads still work, so only persistence breaks.
  storage: `Storage.prototype.setItem = function () {};`,
  // What T-535 shipped on a phone: − and + beside the filename.
  "zoom-buttons-shown": `addEventListener("DOMContentLoaded", () => document.head.append(Object.assign(document.createElement("style"), { textContent: '[aria-label="zoom out"], [aria-label="zoom in"] { display: inline-flex !important; }' })));`,
};

async function openViewer(context, fixture, screen, fault, name) {
  const { reducedMotion, ...viewport } = screen;
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
  await page.send("Emulation.setEmulatedMedia", {
    features: [
      {
        name: "prefers-reduced-motion",
        value: reducedMotion ? "reduce" : "no-preference",
      },
    ],
  });
  await page.navigate(fixture.issueUrl);
  try {
    await waitForViewer(page, name ?? fixture.names[0]);
  } catch (error) {
    await page.close();
    throw error;
  }
  return page;
}

/** Click the attachment link until the viewer shows a measured image. */
async function waitForViewer(page, name) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(200);
    // A reload in flight destroys the context mid-evaluate; that is a retry.
    const state = await evaluate(
      page,
      (n) => {
        const link = document.querySelector(`a[href$="/view/${n}"]`);
        if (!link) return false;
        if (!document.querySelector("[role=dialog]")) link.click();
        return true;
      },
      name,
    )
      .then((opened) => (opened ? evaluate(page, readState) : null))
      .catch(() => null);
    if (state?.view && state.fit > 0) return;
  }
  throw new Error("viewer never showed a measured image");
}

async function settle(page) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const running = await evaluate(
      page,
      () =>
        document.querySelector("[data-testid=image-canvas]")?.getAnimations()
          .length ?? 0,
    );
    if (running === 0) return;
    await sleep(50);
  }
  throw new Error("the canvas's height animation never finished");
}

/**
 * Record the dialog's height on every frame it changes (T-551), and where
 * the image's middle sits on screen. Sampled in a ResizeObserver created
 * after the canvas's own, so each sample sees what that frame paints: the
 * canvas has already reframed the view by then, or it never will this frame.
 */
async function startSampling(page) {
  await evaluate(page, async () => {
    const dialog = document.querySelector("[role=dialog]");
    const samples = [];
    const ro = new ResizeObserver(() => {
      const img = dialog.querySelector("[data-testid=image-canvas] img");
      const r = img?.getBoundingClientRect();
      samples.push({
        h: dialog.getBoundingClientRect().height,
        canvas: img?.parentElement.getBoundingClientRect().height ?? null,
        imageMid: r ? r.y + r.height / 2 : null,
        t: Math.round(performance.now()),
      });
    });
    ro.observe(dialog);
    const canvas = dialog.querySelector("[data-testid=image-canvas]");
    if (canvas) ro.observe(canvas);
    // Every frame, changed or not: a red with few samples says whether the
    // browser was painting slowly or the dialog did not move.
    const frames = [];
    const tick = (t) => {
      frames.push(Math.round(t));
      if (window.__tween?.ro === ro) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__tween = { ro, samples, frames };
    // Past the observation's first report, so the action starts after it.
    await new Promise((done) =>
      requestAnimationFrame(() => requestAnimationFrame(done)),
    );
  });
}

async function stopSampling(page) {
  // Paging: the next image has to load before its height can move.
  const deadline = Date.now() + 10_000;
  while (
    !(await evaluate(page, () => {
      const canvas = document.querySelector("[data-testid=image-canvas]");
      return canvas?.dataset.zoom !== undefined;
    }))
  ) {
    if (Date.now() > deadline) throw new Error("next image never measured");
    await sleep(50);
  }
  await settle(page);
  // A frame for the last step to be reported.
  await sleep(100);
  return evaluate(page, () => {
    const { ro, samples, frames } = window.__tween;
    ro.disconnect();
    window.__tween = null;
    const gaps = frames.slice(1).map((t, i) => t - frames[i]);
    return { samples, frameGaps: gaps };
  });
}

/**
 * The dialog's heights (or the canvas's) from `from` to `to`, tweened: frames between,
 * every one moving the same way. Reduced motion: nothing in between.
 */
function tweenVerdict({ samples, frameGaps }, from, to, reduced, of = "h") {
  const hs = samples.map((s) => s[of]);
  const between = hs.filter(
    (h) => Math.min(from, to) + 1 < h && h < Math.max(from, to) - 1,
  );
  const sign = Math.sign(to - from);
  const monotonic = hs.every((h, i) => i === 0 || (h - hs[i - 1]) * sign >= 0);
  const lands = hs.length > 0 && near(hs.at(-1), to, 0.5);
  const ok =
    Math.abs(to - from) > 50 &&
    lands &&
    // Two, not a duration's worth of frames: here a frame in which the dialog
    // resizes takes headless Chromium 50–100ms, most of it outside script.
    (reduced ? between.length === 0 : between.length >= 2 && monotonic);
  return {
    ok,
    detail: {
      from,
      to,
      between: between.length,
      monotonic,
      heights: hs.map((h) => Math.round(h)),
      ms: samples.map((s) => s.t - samples[0].t),
      frameGaps,
    },
  };
}

function input(page) {
  const mouse = (type, x, y, extra = {}) =>
    page.send("Input.dispatchMouseEvent", { type, x, y, ...extra });
  return {
    // Read once the canvas's height tween (T-551) has landed.
    state: async () => {
      await sleep(120);
      await settle(page);
      return evaluate(page, readState);
    },
    wheel: async (x, y, deltaY, times, modifiers = 0) => {
      await mouse("mouseMoved", x, y);
      for (let i = 0; i < times; i++) {
        await mouse("mouseWheel", x, y, { deltaX: 0, deltaY, modifiers });
        await sleep(20);
      }
    },
    move: (x, y) => mouse("mouseMoved", x, y),
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
    // Trusted clicks: Radix opens on pointerdown, which el.click() skips.
    menu: async (item) => {
      const centre = (selector, text) =>
        evaluate(
          page,
          ([sel, t]) => {
            const el = [...document.querySelectorAll(sel)].find(
              (e) => t === null || e.textContent.trim().startsWith(t),
            );
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          },
          [selector, text],
        );
      const tap = async (p) => {
        await mouse("mouseMoved", p.x, p.y);
        await mouse("mousePressed", p.x, p.y, {
          button: "left",
          clickCount: 1,
        });
        await mouse("mouseReleased", p.x, p.y, {
          button: "left",
          clickCount: 1,
        });
      };
      // A tweening dialog carries the trigger away from where it was read.
      await settle(page);
      const trigger = await centre(
        '[role=dialog] button[aria-label="zoom and display options"]',
        null,
      );
      if (!trigger) throw new Error("no zoom menu trigger");
      await tap(trigger);
      await sleep(200);
      const entry = await centre("[role=menuitem], [role=menuitemradio]", item);
      if (!entry) throw new Error(`no menu item ${item}`);
      await tap(entry);
      await sleep(200);
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
/** The viewer dialog's box and the viewport, for the T-548 growth cases. */
function readDialog() {
  const r = document.querySelector("[role=dialog]").getBoundingClientRect();
  return {
    y: r.y,
    w: r.width,
    h: r.height,
    vh: innerHeight,
    // The canvas's max-h-[75vh].
    cap: innerHeight * 0.75,
  };
}
const sameBox = (a, b) =>
  a !== null &&
  b !== null &&
  near(a.x, b.x, 0.5) &&
  near(a.y, b.y, 0.5) &&
  near(a.w, b.w, 0.5) &&
  near(a.h, b.h, 0.5);

async function desktopCases(page, fixture) {
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
      s0.readout === `${Math.round(s0.fit * 100)}%`,
    s0,
  );
  check(
    "default-look-checker-under-image-only",
    s0.look.canvasBackground === "rgba(0, 0, 0, 0)" &&
      sameBox(s0.look.checker, s0.look.image) &&
      s0.look.image.w < s0.rect.w - 50 &&
      s0.look.rendering === "auto" &&
      s0.look.stored === null,
    s0.look,
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
      s5.readout === "100%",
    { z: s5.view.z, before: b5, after: a5 },
  );

  await io.menu("Fit");
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

  // T-537: 100% from the menu holds the canvas centre still.
  const cx = s8.rect.x + s8.rect.w / 2;
  const cy = s8.rect.y + s8.rect.h / 2;
  const bm = pixelAt(s8, cx, cy);
  await io.menu("100%");
  const m1 = await io.state();
  const am = pixelAt(m1, cx, cy);
  check(
    "menu-100-is-actual-pixels",
    !near(s8.view.z, 1, 0.01) &&
      near(m1.view.z, 1, 1e-9) &&
      near(bm.x, am.x, 1) &&
      near(bm.y, am.y, 1) &&
      m1.readout === "100%",
    { from: s8.view.z, z: m1.view.z, before: bm, after: am },
  );

  await io.key("0", "Digit0", 48);
  const k0 = await io.state();
  await io.key("1", "Digit1", 49);
  const k1 = await io.state();
  check(
    "keys-fit-and-actual",
    near(k0.view.z, k0.fit, 1e-4) && near(k1.view.z, 1, 1e-9),
    { zero: k0.view.z, one: k1.view.z },
  );

  await io.menu("Black");
  const lb = await io.state();
  check(
    "menu-black-fills-canvas",
    lb.look.canvasBackground === "rgb(0, 0, 0)" &&
      lb.look.checker === null &&
      JSON.parse(lb.look.stored ?? "{}").background === "black",
    lb.look,
  );

  // At exactly 100% a pixel is a screen pixel, so pixelated waits for more.
  await io.menu("Pixelated");
  const p1 = await io.state();
  await io.press("zoom in");
  const p2 = await io.state();
  check(
    "pixelated-only-above-100",
    near(p1.view.z, 1, 1e-9) &&
      p1.look.rendering === "auto" &&
      p2.view.z > 1 &&
      p2.look.rendering === "pixelated",
    { at100: p1.look.rendering, above: p2.look.rendering, z: p2.view.z },
  );

  await io.press("maximize");
  await sleep(300);
  const s9 = await io.state();
  check(
    "maximize-keeps-zoom",
    near(s9.view.z, p2.view.z, 1e-4) &&
      s9.rect.w > p2.rect.w &&
      s9.groupInTitleBar,
    { before: p2.view.z, after: s9.view.z },
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
  check(
    "look-survives-paging",
    s10.look.canvasBackground === "rgb(0, 0, 0)" &&
      s10.look.rendering === "pixelated",
    s10.look,
  );

  // Fit is the floor, except that an upscaled fit cannot hide 100%.
  await io.key("1", "Digit1", 49);
  const s10b = await io.state();
  check(
    "upscaled-icon-reaches-100",
    s10b.fit > 1 &&
      near(s10b.view.z, 1, 1e-9) &&
      s10b.readout === "100%" &&
      s10b.zoomOutDisabled === true,
    { z: s10b.view.z, fit: s10b.fit },
  );
  // Back to fit, so restoring below tests that fit stops upscaling.
  await io.key("0", "Digit0", 48);

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
    s12.natural.w === 1800 &&
      near(s12.view.z, s12.fit, 1e-4) &&
      s12.look.rendering === "auto",
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

  // The choices outlive the page: a reload reads them back from storage.
  await page.send("Page.reload");
  await waitForViewer(page, fixture.names[0]);
  await io.menu("100%");
  await io.press("zoom in");
  const r = await io.state();
  check(
    "look-persists-across-reload",
    r.view.z > 1 &&
      r.look.canvasBackground === "rgb(0, 0, 0)" &&
      r.look.checker === null &&
      r.look.rendering === "pixelated",
    { z: r.view.z, ...r.look },
  );
  return out;
}

/**
 * T-548, on the wide image: zooming in grows the canvas, and the dialog with
 * it, to the image's own height until the 75vh cap, and only then pans.
 */
async function growCases(page, { reduced = false } = {}) {
  const io = input(page);
  const out = [];
  const check = (name, ok, detail) =>
    out.push({ name, ok: Boolean(ok), detail });
  const sample = async () => ({
    s: await io.state(),
    d: await evaluate(page, readDialog),
  });

  const { s: s0, d: d0 } = await sample();
  check(
    "grow-starts-at-fit-height",
    s0.natural.h === 400 &&
      near(s0.rect.h, Math.round(400 * s0.fit), 1) &&
      s0.rect.h < d0.cap - 200,
    { h: s0.rect.h, fit: s0.fit, cap: d0.cap },
  );

  const px = s0.rect.x + s0.rect.w / 2;
  const py = s0.rect.y + s0.rect.h / 2;
  const steps = [];
  for (let i = 0; i < 12; i++) {
    await io.wheel(px, py, -100, 1);
    steps.push(await sample());
  }
  const row = ({ s, d }) => ({
    z: Number(s.view.z.toFixed(3)),
    h: s.rect.h,
    dialogH: d.h,
    want: Math.min(Math.round(400 * s.view.z), d.cap),
  });
  const growing = steps.filter(({ s, d }) => 400 * s.view.z < d.cap - 1);
  const capped = steps.filter(({ s, d }) => 400 * s.view.z > d.cap + 1);
  check(
    "dialog-grows-with-zoom",
    growing.length >= 3 &&
      growing.every(
        ({ s, d }) =>
          near(s.rect.h, Math.round(400 * s.view.z), 1) &&
          near(d.h - d0.h, s.rect.h - s0.rect.h, 1),
      ) &&
      growing.every((x, i) => i === 0 || x.s.rect.h > growing[i - 1].s.rect.h),
    growing.map(row),
  );
  check(
    "dialog-stops-at-max",
    capped.length >= 3 &&
      capped.every(({ s, d }) => near(s.rect.h, d.cap, 1)) &&
      steps.every(
        ({ s, d }) =>
          s.rect.h <= d.cap + 0.5 &&
          d.w === d0.w &&
          d.y >= 0 &&
          d.y + d.h <= d.vh &&
          near(d.y + d.h / 2, d.vh / 2, 1),
      ),
    steps.map(row),
  );

  // At the cap the image outgrows the canvas, so a vertical drag pans.
  const s1 = steps.at(-1).s;
  await io.drag(px, py, 0, 50);
  const s2 = await io.state();
  check(
    "pans-once-at-max",
    -s1.view.y >= 50 &&
      near(s2.view.y - s1.view.y, 50, 0.5) &&
      near(s2.rect.h, s1.rect.h, 0.5),
    { roomY: -s1.view.y, dy: s2.view.y - s1.view.y },
  );

  await io.wheel(px, py, 100, 30);
  const { s: s3, d: d3 } = await sample();
  check(
    "zoom-out-shrinks-back",
    near(s3.view.z, s3.fit, 1e-4) &&
      near(s3.rect.h, s0.rect.h, 1) &&
      near(d3.h, d0.h, 1),
    { h: s3.rect.h, h0: s0.rect.h, dialogH: d3.h, dialogH0: d0.h },
  );

  await io.wheel(px, py, -100, 3);
  const { s: s4 } = await sample();
  await startSampling(page);
  await io.press("maximize");
  await sleep(300);
  const maximizing = await stopSampling(page);
  const { s: s5 } = await sample();
  await startSampling(page);
  await io.press("restore size");
  await sleep(300);
  const restoring = await stopSampling(page);
  const { s: s6, d: d6 } = await sample();
  check(
    "restore-keeps-grown-height",
    s4.rect.h > s0.rect.h + 50 &&
      s5.rect.h > d6.cap &&
      near(s6.view.z, s4.view.z, 1e-4) &&
      near(s6.rect.h, s4.rect.h, 1),
    { zoomed: s4.rect.h, maximized: s5.rect.h, restored: s6.rect.h },
  );
  // Maximize and restore have never animated, and the tween keeps out of them.
  const toMax = tweenVerdict(maximizing, s4.rect.h, s5.rect.h, true, "canvas");
  const toRestored = tweenVerdict(
    restoring,
    s5.rect.h,
    s6.rect.h,
    true,
    "canvas",
  );
  check("maximize-and-restore-land-at-once", toMax.ok && toRestored.ok, {
    maximize: toMax.detail,
    restore: toRestored.detail,
  });

  // Every image starts at its own fit, so paging away and back drops the growth.
  // The dialog tweens from one image's height to the next's (T-551): here
  // the wide image's grown height down to the icon's 96px, and back up.
  await startSampling(page);
  await io.key("ArrowLeft", "ArrowLeft", 37);
  const pagedOut = await stopSampling(page);
  const { s: sIcon, d: dIcon } = await sample();
  await startSampling(page);
  await io.key("ArrowRight", "ArrowRight", 39);
  const pagedBack = await stopSampling(page);
  const { s: s7, d: d7 } = await sample();
  const out1 = tweenVerdict(pagedOut, d6.h, dIcon.h, reduced);
  const back1 = tweenVerdict(pagedBack, dIcon.h, d7.h, reduced);
  check(
    reduced ? "paging-lands-at-once" : "paging-tweens-height",
    out1.ok &&
      back1.ok &&
      sIcon.natural.w === 48 &&
      near(sIcon.rect.h, 96, 0.5),
    { out: out1.detail, back: back1.detail },
  );
  check(
    "paging-back-resets-height",
    s7.natural.h === 400 &&
      near(s7.view.z, s7.fit, 1e-4) &&
      near(s7.rect.h, s0.rect.h, 1) &&
      near(d7.h, d0.h, 1),
    { h: s7.rect.h, h0: s0.rect.h },
  );

  // + clicked over and over at one spot: while the pointer is on the zoom
  // controls the dialog holds its height, so the button stays under it;
  // centred growth would slide it up, and the next click would land on the
  // image and toggle back to fit.
  const plusAt = () =>
    evaluate(page, () => {
      const r = document
        .querySelector('[role=dialog] button[aria-label="zoom in"]')
        .getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
  const p0 = await plusAt();
  const clicks = [];
  for (let i = 0; i < 6; i++) {
    await io.click(p0.x, p0.y);
    const s = await io.state();
    clicks.push({ z: s.view.z, h: s.rect.h, plusY: (await plusAt()).y });
  }
  check(
    "plus-clicks-land-while-hovering",
    clicks.every(
      (c, i) =>
        near(c.z, s7.view.z * 1.25 ** (i + 1), 1e-3) &&
        near(c.h, s7.rect.h, 0.5) &&
        near(c.plusY, p0.y, 0.5),
    ),
    clicks,
  );

  const { d: dHeld } = await sample();
  const heldMid = await evaluate(page, () => {
    const r = document
      .querySelector("[data-testid=image-canvas] img")
      .getBoundingClientRect();
    return r.y + r.height / 2;
  });
  await startSampling(page);
  await io.move(px, s7.rect.y + s7.rect.h / 2);
  const grew = await stopSampling(page);
  const { s: s8, d: d8 } = await sample();
  const grown = tweenVerdict(grew, dHeld.h, d8.h, reduced);
  check(
    reduced ? "pointer-leave-grows-at-once" : "pointer-leave-tweens-height",
    grown.ok,
    grown.detail,
  );
  // Zoomed about the canvas centre and growing about it too, so the image
  // must not move on any frame; a frame painted with the view of the old
  // height would put its middle half the growth off.
  const drift = grew.samples.map(
    (x) => Math.round((x.imageMid - heldMid) * 10) / 10,
  );
  check(
    "image-still-while-growing",
    grew.samples.length > 0 && drift.every((d) => Math.abs(d) <= 1),
    { drift },
  );
  check(
    "grows-when-pointer-leaves-controls",
    near(s8.view.z, clicks.at(-1).z, 1e-6) &&
      s8.rect.h > s7.rect.h + 100 &&
      near(s8.rect.h, Math.min(Math.round(400 * s8.view.z), d8.cap), 1) &&
      near(d8.y + d8.h / 2, d8.vh / 2, 1),
    { z: s8.view.z, h: s8.rect.h, cap: d8.cap },
  );

  // The menu's items sit outside the controls, so choosing one grows at once.
  await io.key("0", "Digit0", 48);
  await io.menu("100%");
  const s9 = await io.state();
  check(
    "menu-zoom-grows-at-once",
    near(s9.view.z, 1, 1e-9) && near(s9.rect.h, 400, 1),
    { z: s9.view.z, h: s9.rect.h },
  );
  return out;
}

async function phoneCases(page) {
  const io = input(page);
  const out = [];
  const t = await io.state();
  out.push({
    name: "phone-title-bar-fits",
    ok:
      t.zoomButtonsShown.every((shown) => !shown) &&
      t.readout === `${Math.round(t.fit * 100)}%` &&
      !t.titleTruncated,
    detail: {
      title: t.title,
      zoomButtonsShown: t.zoomButtonsShown,
      truncated: t.titleTruncated,
    },
  });
  const s0 = await io.state();
  const d0 = await evaluate(page, readDialog);
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
  // T-548: the pinch takes the image past 75vh, so the canvas stops there.
  const d1 = await evaluate(page, readDialog);
  out.push({
    name: "phone-pinch-grows-to-max",
    ok:
      s0.rect.h < d0.cap - 50 &&
      near(s1.rect.h, d1.cap, 1) &&
      d1.y >= 0 &&
      d1.y + d1.h <= d1.vh &&
      d1.w === d0.w,
    detail: { from: s0.rect.h, to: s1.rect.h, cap: d1.cap, dialog: d1 },
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
    const runOne = async (name, viewport, cases, fault, requiredRed, start) => {
      // Its own context, so no run reads another's stored image look.
      const context = await browser.newContext();
      try {
        const page = await openViewer(context, fixture, viewport, fault, start);
        try {
          record(name, await cases(page, fixture), requiredRed);
        } finally {
          await page.close();
        }
      } finally {
        await context.close();
      }
    };
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
      ["fault-keys-swallowed", "keys", ["keys-fit-and-actual"]],
      ["fault-storage-unwritable", "storage", ["look-persists-across-reload"]],
    ]) {
      await runOne(name, DESKTOP, desktopCases, fault, requiredRed);
    }
    await runOne(
      "desktop-grow",
      DESKTOP,
      (p) => growCases(p),
      null,
      [],
      "wide.png",
    );
    // T-551: the same growth with prefers-reduced-motion, which lands at once.
    await runOne(
      "desktop-grow-reduced-motion",
      { ...DESKTOP, reducedMotion: true },
      (p) => growCases(p, { reduced: true }),
      null,
      [],
      "wide.png",
    );
    for (const [name, fault, requiredRed] of [
      ["phone", null, []],
      [
        "fault-phone-pointer-swallowed",
        "pointer",
        ["pinch-scales-with-finger-spread"],
      ],
      [
        "fault-phone-zoom-buttons-shown",
        "zoom-buttons-shown",
        ["phone-title-bar-fits"],
      ],
    ]) {
      await runOne(name, PHONE, phoneCases, fault, requiredRed);
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
