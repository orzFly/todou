import { evaluate } from "../lib/browser-cdp.mjs";

const A = "var(--diff-addition)";
const D = "var(--diff-deletion)";
const mix = (color, percentage, other = "transparent") =>
  `color-mix(in oklab, ${color} ${percentage}%, ${other})`;
// Locked legacy Tailwind theme.css colors: removed utilities may leave their
// custom properties absent from the generated product stylesheet.
const oldPalette = Object.freeze({
  red500: "oklch(63.7% 0.237 25.331)",
  red600: "oklch(57.7% 0.245 27.325)",
  red700: "oklch(50.5% 0.213 27.518)",
  green600: "oklch(62.7% 0.194 149.214)",
  green700: "oklch(52.7% 0.154 150.069)",
  emerald500: "oklch(69.6% 0.17 162.48)",
});
const oldRed = oldPalette.red500;
const catalogue = [];

// Each entry names one required production role/property. The runner must use
// independent clean, injected and fresh contexts, and only count a matching
// color/baseline failure. An injector error is never a successful fault proof.
function fault(id, role, property, value, options = {}) {
  catalogue.push(
    Object.freeze({
      id,
      theme: "solarized-light",
      width: 1280,
      surface: "rendered",
      status: "unreviewed",
      draft: false,
      expectedToDiffer: true,
      role,
      property,
      ...(value === undefined ? {} : { value }),
      ...options,
    }),
  );
}

fault(
  "ins-background-transparent",
  "word-ins",
  "background-color",
  "transparent",
  { planRow: 97 },
);
fault(
  "del-background-transparent",
  "word-del",
  "background-color",
  "transparent",
  { planRow: 97 },
);
fault(
  "statnumbers-priority-override",
  "timeline-file-plus",
  "color",
  "rgb(255 0 255)",
  {
    surface: "issue",
    planRow: 97,
  },
);

for (const role of [
  "table-th",
  "table-td",
  "table-row",
  "frontmatter-key",
  "frontmatter-td",
]) {
  fault(
    `${role}-old-red-background`,
    role,
    "background-color",
    mix(
      oldRed,
      role === "table-th" ? 14 : 10,
      role === "table-th" ? "var(--muted)" : "transparent",
    ),
    { planRow: 98 },
  );
}
fault(
  "table-th-old-red-foreground",
  "table-th",
  "color",
  mix("var(--foreground)", 55, oldRed),
  { planRow: 98 },
);
fault(
  "structural-removal-old-red-strikethrough",
  "structure",
  "text-decoration-color",
  oldRed,
  { planRow: 98 },
);

// Cover both summary components and every shared StatNumbers/DiffstatBar
// mounting surface. Mobile Files is an independent surface at its real width.
for (const prefix of ["entry", "timeline-summary"]) {
  for (const side of ["plus", "minus"]) {
    fault(
      `${prefix}-${side}-old-utility`,
      `${prefix}-${side}`,
      "color",
      side === "plus" ? oldPalette.green700 : oldPalette.red700,
      { surface: "issue", planRow: 99 },
    );
  }
}
const fileSurfaces = [
  { name: "timeline", prefix: "timeline", surface: "issue", width: 1280 },
  { name: "sidebar", prefix: "sidebar", surface: "issue", width: 1280 },
  { name: "desktop-files", prefix: "rail", surface: "rendered", width: 1280 },
  { name: "mobile-files", prefix: "rail", surface: "files", width: 390 },
];
for (const { name, prefix, surface, width } of fileSurfaces) {
  for (const side of ["plus", "minus"]) {
    const addition = side === "plus";
    const replacement = name === "timeline" && addition;
    fault(
      `${name}-file-${side}-old-utility`,
      `${prefix}-file-${side}`,
      "color",
      addition ? oldPalette.green700 : oldPalette.red700,
      {
        surface,
        width,
        planRow: 99,
        ...(replacement
          ? {
              mutation: "class-replacement",
              removeClass: "diff-addition-text",
              className: "text-green-700",
            }
          : {}),
      },
    );
    fault(
      `${name}-bar-${side}-old-utility`,
      `${prefix}-cell-${side}`,
      "background-color",
      addition ? oldPalette.green600 : oldPalette.red600,
      { surface, width, planRow: 99 },
    );
  }
}
for (const glyph of ["A", "D"]) {
  const oldBase = glyph === "A" ? oldPalette.green600 : oldPalette.red600;
  fault(
    `timeline-badge-${glyph}-old-foreground`,
    `timeline-badge-${glyph}`,
    "color",
    glyph === "A" ? oldPalette.green700 : oldPalette.red700,
    { surface: "issue", planRow: 99 },
  );
  fault(
    `timeline-badge-${glyph}-old-background`,
    `timeline-badge-${glyph}`,
    "background-color",
    mix(oldBase, 15),
    { surface: "issue", planRow: 99 },
  );
}

const defaultLight = Object.freeze({
  "--diff-addition": "#18a46c",
  "--diff-deletion": "#d52c36",
});
const defaultDark = Object.freeze({
  "--diff-addition": "#07c480",
  "--diff-deletion": "#ff2e3f",
});
const themedRoles = [
  {
    name: "body-addition",
    role: "word-ins",
    property: "background-color",
    surface: "rendered",
  },
  {
    name: "body-deletion",
    role: "word-del",
    property: "background-color",
    surface: "rendered",
  },
  {
    name: "stat-addition",
    role: "timeline-file-plus",
    property: "color",
    surface: "issue",
  },
  {
    name: "stat-deletion",
    role: "timeline-file-minus",
    property: "color",
    surface: "issue",
  },
];
for (const theme of ["solarized-light", "solarized-dark"]) {
  for (const { name, role, property, surface } of themedRoles) {
    fault(`${theme}-locked-default-${name}`, role, property, undefined, {
      theme,
      surface,
      planRow: 100,
      tokenOverride: theme === "solarized-light" ? defaultLight : defaultDark,
    });
  }
}
for (const { name, role, property, surface } of themedRoles) {
  fault(`dark-locked-light-${name}`, role, property, undefined, {
    theme: "dark",
    surface,
    planRow: 101,
    tokenOverride: defaultLight,
    // The host must also run this same mutation in an independent LIGHT page
    // and require a full pass: a no-op here is evidence, not an injection error.
    lightControl: Object.freeze({
      theme: "light",
      width: 1280,
      surface,
      status: "unreviewed",
      draft: false,
      role,
      property,
      tokenOverride: defaultLight,
      expectedToDiffer: false,
    }),
  });
}
for (const theme of ["gruvbox-light", "gruvbox-dark"]) {
  for (const { name, role, property, surface } of themedRoles.filter((r) =>
    r.name.endsWith("addition"),
  )) {
    fault(`${theme}-addition-green-${name}`, role, property, undefined, {
      theme,
      surface,
      planRow: 102,
      tokenOverride: Object.freeze({
        "--diff-addition": oldPalette.emerald500,
      }),
    });
  }
}

fault("moved-R-tinted-addition", "timeline-badge-R", "color", A, {
  surface: "issue",
  planRow: 103,
});
fault("modified-M-tinted-deletion", "timeline-badge-M", "color", D, {
  surface: "issue",
  planRow: 103,
});
fault(
  "context-line-tinted-addition",
  "code-context",
  "background-color",
  mix(A, 24),
  { surface: "source", planRow: 104 },
);
fault("context-number-tinted-deletion", "code-context-number", "color", D, {
  surface: "source",
  planRow: 104,
});
fault("unchanged-body-tinted-addition", "unchanged", "color", A, {
  planRow: 104,
});
fault(
  "frontmatter-live-key-tinted-deletion",
  "frontmatter-live-key",
  "color",
  D,
  { planRow: 104 },
);
for (const { name, prefix, surface, width } of fileSurfaces) {
  if (name !== "sidebar") {
    fault(
      `${name}-old-path-tinted-deletion`,
      `${prefix}-old-path`,
      "color",
      D,
      { surface, width, planRow: 104 },
    );
  }
  fault(`${name}-zero-tinted-addition`, `${prefix}-zero`, "color", A, {
    surface,
    width,
    planRow: 104,
  });
  fault(
    `${name}-none-cell-tinted-deletion`,
    `${prefix}-cell-none`,
    "background-color",
    D,
    { surface, width, planRow: 104 },
  );
}
fault("rendered-fold-tinted-addition", "fold", "background-color", mix(A, 24), {
  planRow: 105,
});
fault("source-separator-tinted-deletion", "code-separator", "color", D, {
  surface: "source",
  planRow: 105,
});
for (const status of ["approved", "changes_requested"]) {
  fault(
    `review-status-${status}-tinted-diff`,
    "review-status",
    "color",
    status === "approved" ? A : D,
    {
      status,
      planRow: 106,
    },
  );
}
for (const action of ["approve", "request-changes"]) {
  fault(
    `review-action-${action}-tinted-diff`,
    `review-action-${action}`,
    "color",
    action === "approve" ? A : D,
    {
      finishReview: true,
      planRow: 106,
    },
  );
}
fault(
  "independent-comment-tinted-addition",
  "comment",
  "background-color",
  mix(A, 6),
  { planRow: 106 },
);
fault(
  "independent-draft-tinted-addition",
  "draft",
  "background-color",
  mix(A, 26),
  { draft: true, planRow: 106 },
);
fault(
  "plain-fence-addition-wash",
  "fence-plain",
  "background-color",
  mix(A, 6),
  { planRow: 107 },
);
fault(
  "annotated-fence-cleared-transparent",
  "fence-annotated",
  "border-left-color",
  "transparent",
  {
    planRow: 107,
    additionalProperties: Object.freeze({ "background-color": "transparent" }),
  },
);

export const FAULTS = Object.freeze(catalogue);

// Spec v3 B covers actual frontmatter key/value td cells; no pending th branch.
export const PENDING_FAULTS = Object.freeze([]);

/** Mutate existing production targets; never remove or replace a component. */
export async function injectFault(page, fault) {
  return evaluate(
    page,
    async (spec) => {
      const fail = (message) => {
        throw new Error(`fault-injection ${spec.id}: ${message}`);
      };
      const tools = window.__diffColors;
      const roles = window.__diffRoles;
      if (!tools || !Array.isArray(roles))
        fail("measurement roles/color tools are not installed");
      const matches = roles.filter((r) => r.id === spec.role);
      if (matches.length !== 1)
        fail(`expected one role ${spec.role}, found ${matches.length}`);
      const role = matches[0];
      if (!Object.hasOwn(role.properties, spec.property))
        fail(`unmeasured property ${spec.property}`);
      window.__refreshDiffRole?.(role);
      const elements = [...role.elements];
      const count = elements.length;
      if (!count || new Set(elements).size !== count)
        fail("target count must be nonzero and unique");
      const checkTargets = () => {
        const current = window.__diffRoles.filter((r) => r.id === spec.role);
        if (current.length !== 1 || current[0].elements.length !== count)
          fail("target role/count changed");
        for (let index = 0; index < count; index++) {
          const element = elements[index];
          if (current[0].elements[index] !== element || !element.isConnected)
            fail(`target ${index} detached/replaced`);
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          if (
            !element.getClientRects().length ||
            !rect.width ||
            !rect.height ||
            style.display === "none" ||
            style.visibility !== "visible" ||
            Number(style.opacity) === 0
          )
            fail(`target ${index} is not visible`);
        }
      };
      const equal = (a, b) =>
        a.length === 4 &&
        b.length === 4 &&
        a[3] === b[3] &&
        a
          .slice(0, 3)
          .every(
            (channel, index) =>
              Math.abs(channel - b[index]) <= 1 / 255 + Number.EPSILON,
          );
      const sample = (element) => {
        const css = getComputedStyle(element)
          .getPropertyValue(spec.property)
          .trim();
        return {
          css,
          rgba: spec.property.startsWith("--")
            ? tools.resolve(element, `var(${spec.property})`)
            : tools.normalize(css),
        };
      };
      checkTargets();
      const before = elements.map(sample);
      // Capture independent recipe expectations BEFORE overriding tokens. For
      // baseline roles, clean-run baseline verification is the host's prerequisite.
      const recipe = role.properties[spec.property];
      const expected = elements.map((element, index) =>
        recipe === null ? before[index].rgba : tools.resolve(element, recipe),
      );
      if (before.some((sample, index) => !equal(sample.rgba, expected[index])))
        fail("clean target already differs from its independent recipe");
      const expectedToDiffer = spec.expectedToDiffer !== false;
      const intended =
        spec.value === undefined
          ? null
          : elements.map((element) => tools.resolve(element, spec.value));
      if (
        expectedToDiffer &&
        intended?.some((color, index) => equal(color, expected[index]))
      )
        fail("injected color equals expected; choose a distinguishing theme");

      if (spec.tokenOverride) {
        if (!Object.keys(spec.tokenOverride).length)
          fail("empty token mutation");
        for (const [token, value] of Object.entries(spec.tokenOverride)) {
          if (!["--diff-addition", "--diff-deletion"].includes(token))
            fail(`unsupported semantic token ${token}`);
          document.documentElement.style.setProperty(token, value, "important");
        }
      } else if (spec.mutation === "class-replacement") {
        if (!spec.removeClass || !spec.className || !intended)
          fail(
            "class replacement needs old/new classes and expected utility color",
          );
        for (const element of elements) {
          if (!element.classList.contains(spec.removeClass))
            fail(`actual component lacks ${spec.removeClass}`);
        }
        for (const element of elements) {
          element.classList.replace(spec.removeClass, spec.className);
          if (
            element.classList.contains(spec.removeClass) ||
            !element.classList.contains(spec.className)
          )
            fail("component class replacement did not apply");
        }
        // Deliberately no inline color fallback: a missing/generated-overridden
        // utility must fail the injection rather than fake a class mutation.
      } else {
        if (spec.value === undefined) fail("missing mutation value");
        if (role.locators) {
          if (!intended || role.locators.length !== count)
            fail(
              "shadow style mutation requires intended colors and exact locator count",
            );
          const roots = new Map();
          for (let index = 0; index < count; index++) {
            const element = elements[index];
            const root = element.getRootNode();
            const locator = role.locators[index];
            if (
              !(root instanceof ShadowRoot) ||
              document.querySelector(locator.host) !== root.host ||
              root.querySelectorAll(locator.path).length !== 1 ||
              root.querySelector(locator.path) !== element
            )
              fail(
                `shadow locator ${index} does not identify the actual target`,
              );
            const rules = roots.get(root) ?? [];
            rules.push(
              `${locator.path}{${spec.property}:${spec.value} !important}`,
            );
            roots.set(root, rules);
          }
          const styles = [];
          for (const [root, rules] of roots) {
            const style = document.createElement("style");
            style.textContent = rules.join("\n");
            root.append(style);
            if (!style.sheet) fail("shadow fault stylesheet was not installed");
            const cssText = [...style.sheet.cssRules]
              .map((rule) => rule.cssText)
              .join("\n");
            styles.push({ element: style, text: style.textContent, cssText });
          }
          role.faultStyle = { property: spec.property, intended, styles };
        } else {
          for (const element of elements)
            element.style.setProperty(spec.property, spec.value, "important");
        }
      }
      for (const [property, value] of Object.entries(
        spec.additionalProperties ?? {},
      )) {
        if (!Object.hasOwn(role.properties, property))
          fail(`unmeasured additional property ${property}`);
        for (const element of elements)
          element.style.setProperty(property, value, "important");
      }
      // Rebinding after a redraw is permitted only when the measurement layer
      // proves the retained shadow fault styles still affect the exact targets.
      role.faultInjected = true;
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      // Review buttons may transition their colors. Measure the completed
      // mutation, not an intermediate animation frame; do not disable product CSS.
      const transitions = elements
        .flatMap((element) => element.getAnimations())
        .filter(
          (animation) =>
            typeof CSSTransition !== "undefined" &&
            animation instanceof CSSTransition,
        );
      await Promise.all(
        transitions.map((animation) => animation.finished.catch(() => {})),
      );
      checkTargets();
      const after = elements.map(sample);
      for (let index = 0; index < count; index++) {
        const changed = !equal(before[index].rgba, after[index].rgba);
        const differs = !equal(expected[index], after[index].rgba);
        if (expectedToDiffer && (!changed || !differs))
          fail(`target ${index} has no effective distinguishing color fault`);
        if (!expectedToDiffer && (changed || differs))
          fail(`light control unexpectedly changed target ${index}`);
        if (intended && !equal(after[index].rgba, intended[index]))
          fail(`target ${index} does not compute to the injected color`);
        for (const [property, value] of Object.entries(
          spec.additionalProperties ?? {},
        )) {
          const actual = tools.normalize(
            getComputedStyle(elements[index]).getPropertyValue(property),
          );
          if (!equal(actual, tools.resolve(elements[index], value)))
            fail(`additional ${property} override did not take effect`);
        }
      }
      return {
        id: spec.id,
        role: spec.role,
        property: spec.property,
        before,
        after,
        expected,
        count,
        connected: elements.every((element) => element.isConnected),
        expectedToDiffer,
        mutation:
          spec.mutation ??
          (spec.tokenOverride ? "token-override" : "priority-override"),
        ...(spec.mutation === "class-replacement"
          ? { removedClass: spec.removeClass, replacementClass: spec.className }
          : {}),
      };
    },
    fault,
  );
}
