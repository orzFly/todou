import { setTimeout as sleep } from "node:timers/promises";
import { evaluate } from "../lib/browser-cdp.mjs";
import { browserColorTools, colorsEqual } from "./diff-colors-color.mjs";

// This checks the real preference store and React subscribers, not a manually
// toggled root class. Expected bases come from the unmodified Pierre snapshot.
export async function verifyThemeTransitions(page, expectedBasesByTheme) {
  await page.send("Runtime.evaluate", {
    expression: `window.__diffColors = (${browserColorTools.toString()})()`,
  });
  const failures = [];
  const steps = [
    { pref: "system", media: "light", theme: "light", kind: "light" },
    { media: "dark", theme: "dark", kind: "dark" },
    { media: "light", theme: "light", kind: "light" },
    { pref: "solarized-dark", theme: "solarized-dark", kind: "dark" },
    { pref: "light", theme: "light", kind: "light" },
    { pref: "solarized-light", theme: "solarized-light", kind: "light" },
    { pref: "system", theme: "light", kind: "light" },
  ];
  let preference = "system";
  for (const [index, step] of steps.entries()) {
    if (step.media) {
      await page.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: step.media }],
      });
    }
    if (step.pref) {
      preference = step.pref;
      await evaluate(
        page,
        async (pref) => {
          const { setThemePref } = await import("/src/lib/theme.ts");
          setThemePref(pref);
        },
        preference,
      );
    }
    const expected = expectedBasesByTheme[step.theme];
    if (!expected)
      throw new Error(`fixture: missing transition base for ${step.theme}`);
    const deadline = Date.now() + 15_000;
    let measured;
    let mismatches;
    do {
      measured = await evaluate(
        page,
        (kind, expected) => {
          const color = window.__diffColors;
          const root = document.documentElement;
          const host = [...document.querySelectorAll("diffs-container")].find(
            (e) =>
              e.shadowRoot?.querySelector(
                '[data-content] [data-line][data-line-type="change-addition"]',
              ) &&
              e.shadowRoot?.querySelector(
                '[data-content] [data-line][data-line-type="change-deletion"]',
              ),
          );
          const state = {
            pref: localStorage.getItem("todou-theme"),
            storedKind: localStorage.getItem("todou-theme-kind"),
            theme: root.dataset.theme,
            dark: root.classList.contains("dark"),
            scheme: getComputedStyle(root).colorScheme,
          };
          if (!host)
            return { state, missing: "actual Pierre addition/deletion lines" };
          host.scrollIntoView({ block: "center" });
          const pre = host.shadowRoot.querySelector("pre");
          if (!pre) return { state, missing: "Pierre pre" };
          const roles = [];
          for (const side of ["addition", "deletion"]) {
            const line = host.shadowRoot.querySelector(
              `[data-content] [data-line][data-line-type="change-${side}"]`,
            );
            const number = host.shadowRoot.querySelector(
              `[data-column-number][data-line-type="change-${side}"] [data-line-number-content]`,
            );
            if (!number) return { state, missing: `Pierre ${side} number` };
            const base = color.resolve(pre, `var(--diffs-${side}-base)`);
            roles.push({
              side,
              base,
              number: color.normalize(getComputedStyle(number).color),
              line: color.normalize(getComputedStyle(line).backgroundColor),
              expectedLine: color.resolve(
                line,
                `color-mix(in lab, var(--background) ${kind === "dark" ? 80 : 88}%, var(--diffs-${side}-base))`,
              ),
            });
          }
          const prose = [];
          for (const side of ["addition", "deletion"]) {
            const rgba = expected.rgba?.[side] ?? expected[side];
            const cssBase = `color(srgb ${rgba[0]} ${rgba[1]} ${rgba[2]} / ${rgba[3]})`;
            const word = document.querySelector(
              side === "addition" ? "ins.spec-ins" : "del.spec-del",
            );
            const stat = [
              ...document.querySelectorAll('a[title="plan.md"] span'),
            ].find(
              (e) =>
                e.children.length === 0 &&
                (side === "addition" ? /^\+\d+$/ : /^−\d+$/).test(
                  e.textContent.trim(),
                ),
            );
            if (!word || !stat)
              return {
                state,
                missing: `theme transition ${side} body/statistic`,
              };
            prose.push({
              side,
              word: color.normalize(getComputedStyle(word).backgroundColor),
              expectedWord: color.resolve(
                word,
                `color-mix(in oklab, ${cssBase} ${side === "addition" ? 24 : 16}%, transparent)`,
              ),
              stat: color.normalize(getComputedStyle(stat).color),
              expectedStat: color.resolve(
                stat,
                `color-mix(in oklab, var(--foreground) 75%, ${cssBase})`,
              ),
            });
          }
          return { state, roles, prose };
        },
        step.kind,
        expected,
      );
      mismatches = [];
      const check = (property, actual, wanted) => {
        if (actual !== wanted)
          mismatches.push({ property, actual, expected: wanted });
      };
      check("preference", measured.state.pref, preference);
      check(
        "stored-kind",
        measured.state.storedKind,
        preference === "system" ? null : step.kind,
      );
      check("data-theme", measured.state.theme, step.theme);
      check("dark-class", measured.state.dark, step.kind === "dark");
      check("color-scheme", measured.state.scheme, step.kind);
      if (measured.missing)
        mismatches.push({ property: "fixture", actual: measured.missing });
      for (const role of measured.roles ?? []) {
        const wantedBase = expected.rgba?.[role.side] ?? expected[role.side];
        if (!Array.isArray(wantedBase))
          throw new Error(
            `fixture: transition base ${step.theme}/${role.side} must be RGBA`,
          );
        for (const [property, actual, wanted] of [
          ["base", role.base, wantedBase],
          ["number-color", role.number, wantedBase],
          ["line-background", role.line, role.expectedLine],
        ]) {
          if (!colorsEqual(actual, wanted))
            mismatches.push({
              property: `${role.side}-${property}`,
              actual,
              expected: wanted,
            });
        }
      }
      for (const role of measured.prose ?? []) {
        for (const [property, actual, wanted] of [
          ["word-background", role.word, role.expectedWord],
          ["stat-color", role.stat, role.expectedStat],
        ]) {
          if (!colorsEqual(actual, wanted))
            mismatches.push({
              property: `${role.side}-${property}`,
              actual,
              expected: wanted,
            });
        }
      }
      if (!mismatches.length) break;
      await sleep(100);
    } while (Date.now() < deadline);
    failures.push(
      ...mismatches.map((failure) => ({
        family: failure.property === "fixture" ? "fixture" : "theme-transition",
        step: index,
        theme: step.theme,
        role: "theme-transition",
        ...failure,
      })),
    );
  }
  return { steps: steps.length, failures };
}

// The renderer replaces deleted pre nodes with markdown-fence wrappers. Keep
// this existing CSS branch checked without claiming a reachable browser sample.
export function staticPreRule(source) {
  const body = source.match(
    /\.markdown-body pre\.spec-del-structure\s*\{([^}]+)\}/,
  )?.[1];
  return (
    !!body &&
    /background-color:\s*color-mix\(\s*in oklab,\s*var\(--diff-deletion\) 12%,\s*var\(--muted\)\s*\)/.test(
      body,
    )
  );
}
