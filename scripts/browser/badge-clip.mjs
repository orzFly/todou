import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { evaluate } from "../lib/browser-cdp.mjs";

const WIDTHS = [641, 672, 720, 800, 1024, 1440];
const HEIGHT = 900;
const EPSILON = 0.5;

function failure(name, detail, width) {
  return { name, detail, ...(width ? { width } : {}) };
}

async function seedFixture(serverPort) {
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
  const viewer = await call("GET", "/me");
  await call("PATCH", "/me", { display_name: "Neutral Human" });
  const slug = `layout-badge-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  await call("POST", "/projects", {
    slug,
    name: `Badge clipping ${slug}`,
    description: "",
  });
  const machines = [];
  for (let index = 1; index <= 6; index += 1) {
    const login = `neutral-machine-${index}-${randomUUID().slice(0, 4)}`;
    const machine = await call("POST", "/agents", {
      login,
      display_name: `Neutral Machine Member ${index} With A Deliberately Long Name`,
    });
    await call("PUT", `/projects/${slug}/members/${machine.id}`, {
      role: "writer",
    });
    machines.push(machine);
  }
  const issue = await call("POST", `/projects/${slug}/issues`, {
    title: "Collapsed assignee summary with machine badges",
    body: "The assignment history below is intentionally genuine API history.",
  });
  const ids = machines.map((machine) => machine.id);
  for (let count = 1; count <= ids.length; count += 1) {
    await call("PATCH", `/projects/${slug}/issues/${issue.number}`, {
      assignee_ids: ids.slice(0, count),
    });
  }
  return {
    slug,
    number: issue.number,
    cookie,
    viewerId: viewer.id,
    machineIds: ids,
    machineLogins: machines.map((m) => m.login),
  };
}

function probeSource(fault, machineLogins) {
  return `(() => {
    const fault = ${JSON.stringify(fault)};
    const expectedMachineLogins = ${JSON.stringify(machineLogins)};
    const round = value => Number.isFinite(value) ? Number(value.toFixed(3)) : null;
    const clips = value => ['auto', 'clip', 'hidden', 'scroll'].includes(value);
    const clipMargin = style => {
      if (style.overflowX !== 'clip' && style.overflowY !== 'clip') return 0;
      const values = style.overflowClipMargin.match(/-?[0-9.]+px/g) || [];
      return values.length ? Math.max(0, Number.parseFloat(values.at(-1))) : 0;
    };
    const describe = element => ({
      tag: element.tagName.toLowerCase(),
      testid: element.getAttribute('data-testid'),
      className: element.getAttribute('class'),
    });
    const locate = () => {
      const groups = [...document.querySelectorAll('[data-testid="event-group"]')];
      for (const group of groups) {
        const row = group.firstElementChild;
        const toggle = row?.querySelector(':scope > button[data-testid="event-group-toggle"]');
        const target = row?.querySelector(':scope > span.min-w-0.flex-1[title]');
        const badges = target ? [...target.querySelectorAll('svg[aria-label="agent"]')] : [];
        if (toggle?.getAttribute('aria-expanded') === 'false' && /assign/i.test(target?.getAttribute('title') ?? '') && badges.length) {
          return { group, row, toggle, target, badges };
        }
      }
      return null;
    };
    const targetStyle = target => {
      const style = getComputedStyle(target);
      return {
        overflowX: style.overflowX, overflowY: style.overflowY,
        overflowClipMargin: style.overflowClipMargin,
        paddingTop: style.paddingTop, paddingBottom: style.paddingBottom,
        marginTop: style.marginTop, marginBottom: style.marginBottom,
        textOverflow: style.textOverflow, whiteSpace: style.whiteSpace,
      };
    };
    const allowance = style => Number.parseFloat(style.paddingTop) > 0 &&
      Number.parseFloat(style.paddingBottom) > 0 &&
      Math.abs(Number.parseFloat(style.paddingTop) + Number.parseFloat(style.marginTop)) <= ${EPSILON} &&
      Math.abs(Number.parseFloat(style.paddingBottom) + Number.parseFloat(style.marginBottom)) <= ${EPSILON};
    const measure = () => {
      const found = locate();
      if (!found) return { found: false, groupCount: document.querySelectorAll('[data-testid="event-group"]').length };
      const { group, row, target, badges } = found;
      const style = targetStyle(target);
      const targetRect = target.getBoundingClientRect();
      const measured = badges.map((badge, index) => {
        const box = badge.getBoundingClientRect();
        const owner = badge.closest('a[href*="/users/"]');
        const ownerLogin = owner
          ? decodeURIComponent(new URL(owner.href).pathname.split('/').at(-1))
          : null;
        const ancestors = [];
        let left = 0, right = innerWidth, top = -Infinity, bottom = Infinity;
        for (let element = badge.parentElement, depth = 0; element; element = element.parentElement, depth += 1) {
          const computed = getComputedStyle(element);
          const clipX = clips(computed.overflowX);
          const clipY = clips(computed.overflowY);
          if (!clipX && !clipY) continue;
          const rect = element.getBoundingClientRect();
          const margin = clipMargin(computed);
          const edges = {
            left: rect.left + (Number.parseFloat(computed.borderLeftWidth) || 0) - (computed.overflowX === 'clip' ? margin : 0),
            right: rect.right - (Number.parseFloat(computed.borderRightWidth) || 0) + (computed.overflowX === 'clip' ? margin : 0),
            top: rect.top + (Number.parseFloat(computed.borderTopWidth) || 0) - (computed.overflowY === 'clip' ? margin : 0),
            bottom: rect.bottom - (Number.parseFloat(computed.borderBottomWidth) || 0) + (computed.overflowY === 'clip' ? margin : 0),
          };
          if (clipX) { left = Math.max(left, edges.left); right = Math.min(right, edges.right); }
          if (clipY) { top = Math.max(top, edges.top); bottom = Math.min(bottom, edges.bottom); }
          ancestors.push({ depth, ...describe(element), isExpectedTarget: element === target, overflowX: computed.overflowX, overflowY: computed.overflowY, overflowClipMargin: computed.overflowClipMargin, clipX, clipY, edges: Object.fromEntries(Object.entries(edges).map(([key, value]) => [key, round(value)])) });
        }
        return {
          index,
          ownerLogin,
          belongsToFixture: expectedMachineLogins.includes(ownerLogin),
          box: { top: round(box.top), right: round(box.right), bottom: round(box.bottom), left: round(box.left), width: round(box.width), height: round(box.height) },
          clipped: {
            top: round(Math.max(0, top - box.top)),
            right: round(Math.max(0, box.right - right)),
            bottom: round(Math.max(0, box.bottom - bottom)),
            left: round(Math.max(0, left - box.left)),
          },
          clippingAncestors: ancestors,
        };
      });
      return {
        found: true,
        group: { ...describe(group), closed: found.toggle.getAttribute('aria-expanded') === 'false' },
        row: describe(row), target: { ...describe(target), title: target.getAttribute('title'), style, allowance: allowance(style), clientWidth: target.clientWidth, scrollWidth: target.scrollWidth, overflowing: target.scrollWidth > target.clientWidth + ${EPSILON}, rect: { width: round(targetRect.width), height: round(targetRect.height) } },
        badges: measured,
        faultMarker: !!document.querySelector('style[data-badge-clip-fault]'),
      };
    };
    const inject = () => {
      if (!fault || !document.head || document.querySelector('style[data-badge-clip-fault]')) return;
      const style = document.createElement('style');
      style.dataset.badgeClipFault = 'remove-summary-allowance';
      style.textContent = '[data-testid="event-group"] > div > span.min-w-0.flex-1[title] { padding-top: 0 !important; padding-bottom: 0 !important; margin-top: 0 !important; margin-bottom: 0 !important; }';
      document.head.append(style);
    };
    if (fault) { new MutationObserver(inject).observe(document, { childList: true, subtree: true }); inject(); }
    window.__badgeClipSmoke = { locate, measure, inject };
  })()`;
}

async function waitForTarget(page) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const found = await evaluate(
      page,
      () => !!window.__badgeClipSmoke?.locate(),
    );
    if (found) return;
    await sleep(80);
  }
  throw new Error(
    "seeded closed CollapsedGroup with target machine badges did not render",
  );
}

async function stableFrames(page) {
  await evaluate(page, async () => {
    await document.fonts.ready;
    const target = window.__badgeClipSmoke?.locate()?.group;
    if (!target) throw new Error("target group disappeared before settlement");
    target.scrollIntoView({ block: "center" });
    const box = () => {
      const element = window.__badgeClipSmoke?.locate()?.target;
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return [rect.x, rect.y, rect.width, rect.height].map((value) =>
        Number(value.toFixed(3)),
      );
    };
    for (let tries = 0; tries < 12; tries += 1) {
      const first = box();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const second = box();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const third = box();
      if (
        JSON.stringify(first) === JSON.stringify(second) &&
        JSON.stringify(second) === JSON.stringify(third)
      ) {
        return;
      }
    }
    throw new Error("layout did not hold stable for two animation frames");
  });
}

function inspectMeasurement(measurement, width, fault, machineLogins) {
  const failures = [];
  if (!measurement.found)
    return [
      failure(
        "collapsed-group-missing",
        "seeded assignee CollapsedGroup was not found",
        width,
      ),
    ];
  if (!measurement.group?.closed)
    failures.push(
      failure(
        "collapsed-group-not-closed",
        "target group is not a genuine closed CollapsedGroup",
        width,
      ),
    );
  if (!measurement.target?.title || !/assign/i.test(measurement.target.title))
    failures.push(
      failure(
        "assignee-summary-target-missing",
        "assignee summary target is absent",
        width,
      ),
    );
  if (!measurement.badges?.length)
    failures.push(
      failure(
        "target-machine-badges-missing",
        "no machine badges are inside the summary target",
        width,
      ),
    );
  const actualOwners = (measurement.badges ?? [])
    .map((badge) => badge.ownerLogin)
    .sort();
  const expectedOwners = [...machineLogins].sort();
  if (JSON.stringify(actualOwners) !== JSON.stringify(expectedOwners)) {
    failures.push(
      failure(
        "fixture-machine-badge-mismatch",
        `target badge owners ${JSON.stringify(actualOwners)} do not equal seeded owners ${JSON.stringify(expectedOwners)}`,
        width,
      ),
    );
  }
  if (!fault && !measurement.target.allowance)
    failures.push(
      failure(
        "expected-clipping-allowance-missing",
        "production padding/negative-margin allowance is not effective",
        width,
      ),
    );
  if (
    !measurement.badges?.every((badge) =>
      badge.clippingAncestors.some((ancestor) => ancestor.isExpectedTarget),
    )
  )
    failures.push(
      failure(
        "clipping-ancestor-missing",
        "every target badge must name the production summary span as its expected clipping ancestor",
        width,
      ),
    );
  for (const badge of measurement.badges ?? []) {
    for (const edge of ["top", "right", "bottom", "left"]) {
      if (badge.clipped[edge] > EPSILON)
        failures.push(
          failure(
            `${edge}-clipping`,
            `badge ${badge.index} clipped ${badge.clipped[edge]}px`,
            width,
          ),
        );
    }
  }
  if (width === 641) {
    if (!measurement.target.overflowing)
      failures.push(
        failure(
          "641-horizontal-overflow-missing",
          "641px target must genuinely overflow horizontally",
          width,
        ),
      );
    if (
      measurement.target.style.textOverflow !== "ellipsis" ||
      measurement.target.style.whiteSpace !== "nowrap" ||
      !["hidden", "clip"].includes(measurement.target.style.overflowX)
    ) {
      failures.push(
        failure(
          "641-truncation-contract",
          `expected ellipsis/nowrap/clipping, got ${JSON.stringify(measurement.target.style)}`,
          width,
        ),
      );
    }
  }
  return failures;
}

async function runPass({ browser, stack, fixture, fault, label }) {
  const context = await browser.newContext();
  let page;
  const failures = [];
  const measurements = [];
  try {
    page = await context.newPage({
      viewport: {
        width: WIDTHS[0],
        height: HEIGHT,
        deviceScaleFactor: 1,
        mobile: false,
      },
      cookie: fixture.cookie,
      scripts: [probeSource(fault, fixture.machineLogins)],
    });
    await page.navigate(
      `http://127.0.0.1:${stack.webPort}/projects/${fixture.slug}/issues/${fixture.number}`,
    );
    await waitForTarget(page);
    for (const width of WIDTHS) {
      await page.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: HEIGHT,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await stableFrames(page);
      const measurement = await evaluate(page, () =>
        window.__badgeClipSmoke.measure(),
      );
      measurements.push({ width, ...measurement });
      failures.push(
        ...inspectMeasurement(measurement, width, fault, fixture.machineLogins),
      );
    }
    const mutationConfirmed =
      fault &&
      measurements.every((measurement) => {
        const style = measurement.target?.style;
        return (
          measurement.faultMarker &&
          style?.paddingTop === "0px" &&
          style?.paddingBottom === "0px" &&
          style?.marginTop === "0px" &&
          style?.marginBottom === "0px"
        );
      });
    if (fault && !mutationConfirmed)
      failures.push(
        failure(
          "fault-injection-not-confirmed",
          "summary allowance removal was not effective at every width",
        ),
      );
    const result = {
      name: `badge-clip:${label}`,
      fixture: {
        slug: fixture.slug,
        number: fixture.number,
        machineLogins: fixture.machineLogins,
      },
      mutationConfirmed,
      failures,
      measurements,
    };
    if (failures.length) {
      const shot = await page.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
      writeFileSync(
        join(stack.dir, `badge-clip-${label}.png`),
        Buffer.from(shot.data, "base64"),
      );
      writeFileSync(
        join(stack.dir, `badge-clip-${label}.json`),
        `${JSON.stringify(result, null, 2)}\n`,
      );
    }
    return result;
  } finally {
    await context.close();
  }
}

export async function runBadgeClip(options) {
  const fixture = await seedFixture(options.stack.serverPort);
  if (!options.selfTest) {
    return {
      name: "badge-clip",
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
  const baselineKeys = new Set(
    baseline.failures.map((item) => `${item.name}:${item.width ?? "all"}`),
  );
  const faultKeys = new Set(
    fault.failures.map((item) => `${item.name}:${item.width ?? "all"}`),
  );
  const newBottom = [...faultKeys].some(
    (key) => key.startsWith("bottom-clipping:") && !baselineKeys.has(key),
  );
  const invalidFaultEvidence = fault.failures.some((item) =>
    [
      "collapsed-group-missing",
      "collapsed-group-not-closed",
      "assignee-summary-target-missing",
      "target-machine-badges-missing",
      "fixture-machine-badge-mismatch",
      "expected-clipping-allowance-missing",
      "clipping-ancestor-missing",
      "fault-injection-not-confirmed",
    ].includes(item.name),
  );
  const failures = [];
  if (baseline.failures.length) {
    failures.push(
      failure(
        "self-test-baseline-not-clean",
        `pre-existing failures cannot prove the injected fault: ${[...baselineKeys].join(", ")}`,
      ),
    );
  }
  const coverageNames = new Set([
    "collapsed-group-missing",
    "collapsed-group-not-closed",
    "assignee-summary-target-missing",
    "target-machine-badges-missing",
    "fixture-machine-badge-mismatch",
    "expected-clipping-allowance-missing",
    "clipping-ancestor-missing",
    "641-horizontal-overflow-missing",
    "641-truncation-contract",
    "fault-injection-not-confirmed",
  ]);
  if (baseline.failures.some((item) => coverageNames.has(item.name))) {
    failures.push(
      failure(
        "self-test-baseline-coverage",
        "baseline lacked required target/group/badge/ancestor/overflow coverage",
      ),
    );
  }
  if (fault.failures.some((item) => coverageNames.has(item.name))) {
    failures.push(
      failure(
        "self-test-fault-coverage",
        "fault pass lacked required target/group/badge/ancestor/overflow coverage",
      ),
    );
  }
  if (restored.failures.some((item) => coverageNames.has(item.name))) {
    failures.push(
      failure(
        "self-test-restoration-coverage",
        "restored pass lacked required target/group/badge/ancestor/overflow coverage",
      ),
    );
  }
  if (!fault.mutationConfirmed) {
    failures.push(
      failure("self-test-injection", "fault mutation was not confirmed"),
    );
  }
  if (baseline.failures.length || invalidFaultEvidence || !newBottom) {
    failures.push(
      failure(
        "self-test-new-targeted-failure",
        "confirmed mutation did not introduce a new bottom-clipping failure over a green, complete baseline",
      ),
    );
  }
  if (restored.failures.length) {
    failures.push(
      failure(
        "self-test-fresh-restoration",
        `fresh clean rerun failed: ${restored.failures.map((item) => item.name).join(", ")}`,
      ),
    );
  }
  return {
    name: "badge-clip",
    passes: [baseline, fault, restored],
    failures,
  };
}
