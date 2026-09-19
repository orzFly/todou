import { evaluate } from "../lib/browser-cdp.mjs";
import { browserColorTools, colorsEqual } from "./diff-colors-color.mjs";
import { FIXTURE_MARKERS } from "./diff-colors-fixture.mjs";

// Fixed design recipes. None are read from the product's new semantic tokens.
export async function installRoles(page, config, bases) {
  await page.send("Runtime.evaluate", {
    expression: `window.__diffColors = (${browserColorTools.toString()})()`,
  });
  return evaluate(
    page,
    (
      { surface, width, draft, finishReview, status = "unreviewed" },
      base,
      markers,
    ) => {
      const all = (selector, root = document) => [
        ...root.querySelectorAll(selector),
      ];
      const shown = (e) =>
        e &&
        getComputedStyle(e).display !== "none" &&
        e.getClientRects().length > 0;
      const exact = (root, text, tag = "span") =>
        all(tag, root).filter((e) => e.textContent.trim() === text);
      const roles = [];
      const add = (id, elements, properties, contrast = false) =>
        roles.push({
          id,
          elements: [...new Set(elements)].filter(Boolean),
          properties,
          contrast,
        });
      const unchanged = (
        id,
        elements,
        properties = ["color", "background-color"],
      ) =>
        add(id, elements, Object.fromEntries(properties.map((p) => [p, null])));
      const A = base?.addition;
      const D = base?.deletion;
      const mix = (color, percentage, other = "transparent") =>
        `color-mix(in oklab, ${color} ${percentage}%, ${other})`;
      const text = (color) => mix("var(--foreground)", 75, color);
      const bg = (color, percentage) => ({
        "background-color": mix(color, percentage),
      });
      const deletion = { ...bg(D, 10), color: mix("var(--foreground)", 55, D) };
      const table = (selector) =>
        all(`.markdown-body table:not(.markdown-frontmatter) ${selector}`);
      if (surface === "rendered" && !draft && !finishReview) {
        add("word-ins", all("ins.spec-ins"), bg(A, 24));
        add("word-del", all("del.spec-del:not(.spec-del-block)"), {
          ...bg(D, 16),
          color: mix("var(--foreground)", 65, D),
        });
        add(
          "changed",
          all(
            ".spec-changed:not(tr):not(.spec-fence-diff):not(.spec-annotated):not(.spec-ins-block)",
          ),
          { ...bg(A, 6), "border-left-color": mix(A, 60) },
        );
        add("insert-block", all(".spec-ins-block:not(.spec-annotated)"), {
          ...bg(A, 12),
          "border-left-color": mix(A, 60),
        });
        add(
          "annotated-changed",
          all(
            ".spec-annotated.spec-changed:not(.spec-ins-block):not(.spec-fence-diff)",
          ),
          {
            ...bg(A, 6),
            "border-left-color": mix("var(--color-amber-500)", 60, A),
          },
        );
        add("annotated-insert", all(".spec-annotated.spec-ins-block"), {
          ...bg(A, 12),
          "border-left-color": mix("var(--color-amber-500)", 60, A),
        });
        add("structure", all(".spec-del-structure:not(.markdown-fence)"), {
          ...deletion,
          "border-left-color": mix(D, 60),
          "text-decoration-color": D,
        });
        add("structure-link", all(".spec-del-structure a"), {
          color: deletion.color,
          "text-decoration-color": D,
        });
        add("structure-code", all(".spec-del-structure code"), {
          color: deletion.color,
          "text-decoration-color": D,
        });
        add("table-th", table("th.spec-del-cell"), {
          ...deletion,
          "background-color": mix(D, 14, "var(--muted)"),
        });
        add("table-td", table("td.spec-del-cell"), deletion);
        add(
          "table-row",
          table("tr.spec-del-row td:not(.spec-del-cell)"),
          deletion,
        );
        add(
          "table-changed-border",
          table("tr.spec-changed:not(.spec-annotated)"),
          { "border-left-color": mix(A, 60) },
        );
        unchanged(
          "table-zebra",
          table("tbody tr:nth-child(2n):not(.spec-del-row)"),
          ["background-color"],
        );
        add(
          "frontmatter-key",
          all("table.markdown-frontmatter tr.spec-del-row td:first-child"),
          { ...deletion, "text-decoration-color": deletion.color },
        );
        add(
          "frontmatter-td",
          all("table.markdown-frontmatter tr.spec-del-row td:last-child"),
          { ...deletion, "text-decoration-color": deletion.color },
        );
        unchanged(
          "frontmatter-live-key",
          all("table.markdown-frontmatter tr:not(.spec-del-row) th"),
          ["color", "background-color"],
        );
        unchanged(
          "frontmatter-live-value",
          all("table.markdown-frontmatter tr:not(.spec-del-row) td"),
          ["color", "background-color"],
        );
        add("fence-plain", all(".spec-fence-diff:not(.spec-annotated)"), {
          "background-color": "transparent",
          "border-left-color": "transparent",
        });
        add("fence-annotated", all(".spec-fence-diff.spec-annotated"), {
          ...bg(A, 6),
          "border-left-color": mix("var(--color-amber-500)", 60, A),
        });
        unchanged(
          "comment",
          all(".spec-annotated:not(.spec-changed):not(.spec-ins-block)"),
          ["background-color", "border-left-color"],
        );
        unchanged("comment-mark", all("mark.spec-mark-comment"), [
          "background-color",
          "color",
        ]);
        unchanged(
          "unchanged",
          all(".markdown-body p").filter(
            (e) =>
              e.textContent.includes(markers.unchanged) &&
              !e.closest(
                ".spec-changed,.spec-ins-block,.spec-annotated,.spec-del-structure",
              ),
          ),
        );
        unchanged("fold", all(".spec-fold"), [
          "background-color",
          "color",
          "border-color",
        ]);
      }
      if (draft)
        unchanged("draft", all("mark.spec-mark-draft"), [
          "background-color",
          "color",
        ]);
      if (surface === "plain") {
        unchanged(
          "plain-body",
          all(".markdown-body p").filter((e) =>
            e.textContent.includes(markers.unchanged),
          ),
        );
        unchanged("plain-code", all("diffs-container").filter(shown), [
          "background-color",
          "color",
        ]);
        const shadow = all(".markdown-fence diffs-container")[0]?.shadowRoot;
        unchanged(
          "plain-code-line",
          shadow ? all("[data-line]", shadow).slice(0, 2) : [],
        );
        unchanged(
          "plain-code-syntax",
          shadow ? all("[data-line] [style]", shadow).slice(0, 2) : [],
        );
      }
      const statScope = (
        prefix,
        root,
        { summary = false, badges = false, rail = false } = {},
      ) => {
        const spans = root
          ? all("span", root).filter((e) => e.children.length === 0)
          : [];
        const positives = spans.filter((e) =>
          /^\+\d+$/.test(e.textContent.trim()),
        );
        const negatives = spans.filter((e) =>
          /^−\d+$/.test(e.textContent.trim()),
        );
        add(
          `${prefix}${summary ? "" : "-file"}-plus`,
          positives,
          { color: text(A) },
          true,
        );
        add(
          `${prefix}${summary ? "" : "-file"}-minus`,
          negatives,
          { color: text(D) },
          true,
        );
        if (summary) return;
        unchanged(
          `${prefix}-zero`,
          spans.filter((e) => e.textContent.trim() === "±0"),
        );
        const cells = { plus: [], minus: [], none: [] };
        for (const bar of root
          ? all("span[aria-hidden]", root).filter(
              (e) => e.querySelectorAll(":scope > i").length === 5,
            )
          : []) {
          const row = bar.closest("li") ?? bar.closest("a");
          const txt = row?.textContent ?? "";
          const plus = Number(txt.match(/\+(\d+)/)?.[1] ?? 0);
          const minus = Number(txt.match(/−(\d+)/)?.[1] ?? 0);
          let count =
            plus + minus ? Math.round((plus / (plus + minus)) * 5) : 0;
          if (plus && !count) count = 1;
          if (minus && count === 5) count = 4;
          all(":scope > i", bar).forEach((e, i) => {
            cells[i < count ? "plus" : minus ? "minus" : "none"].push(e);
          });
        }
        add(`${prefix}-cell-plus`, cells.plus, { "background-color": A });
        add(`${prefix}-cell-minus`, cells.minus, { "background-color": D });
        unchanged(`${prefix}-cell-none`, cells.none, ["background-color"]);
        if (badges) {
          for (const glyph of ["A", "D", "R", "M"]) {
            const es = root ? exact(root, glyph) : [];
            if (glyph === "A" || glyph === "D")
              add(
                `${prefix}-badge-${glyph}`,
                es,
                {
                  color: text(glyph === "A" ? A : D),
                  ...bg(glyph === "A" ? A : D, 15),
                },
                true,
              );
            else unchanged(`${prefix}-badge-${glyph}`, es);
          }
        }
        if (badges || rail)
          unchanged(
            `${prefix}-old-path`,
            spans.filter((e) => e.textContent.includes(markers.renamedFrom)),
          );
      };
      if (surface === "issue") {
        const entry = document.querySelector('[data-testid="spec-entry"]');
        statScope("entry", entry, { summary: true });
        statScope(
          "sidebar",
          document.querySelector('[data-testid="spec-sidebar"]'),
        );
        const title = all("a").find(
          (e) =>
            e.textContent.trim() === "Spec v2" &&
            !e.closest('[data-testid="spec-entry"]'),
        );
        const card = title?.parentElement?.parentElement;
        statScope("timeline-summary", title?.parentElement, { summary: true });
        statScope("timeline", card?.querySelector("ul"), { badges: true });
      }
      if (
        (surface === "files" || (surface === "rendered" && width >= 1024)) &&
        !draft &&
        !finishReview
      ) {
        const link = all('a[title="plan.md"]').find(shown);
        statScope("rail", link?.parentElement, { rail: true });
      }
      if (["rendered", "source", "plain"].includes(surface)) {
        unchanged(
          "review-status",
          exact(
            document,
            status === "unreviewed"
              ? "awaiting review"
              : status === "approved"
                ? "approved"
                : "changes requested",
          ).filter(shown),
        );
        if (surface === "source")
          unchanged(
            "display-wrap",
            all('button[aria-label="wrap long lines"]').filter(shown),
          );
        else
          unchanged(
            "display-fold",
            all('button[aria-label^="fold"]').filter(shown),
          );
      }
      if (finishReview) {
        roles.length = 0;
        unchanged(
          "review-action-approve",
          exact(document, "Approve", 'button,[role="menuitem"]').filter(shown),
        );
        unchanged(
          "review-action-request-changes",
          exact(document, "Request changes", 'button,[role="menuitem"]').filter(
            shown,
          ),
        );
      }
      window.__diffRoles = roles;
      return roles.map(({ id, elements, properties }) => ({
        id,
        count: elements.length,
        properties: Object.keys(properties),
      }));
    },
    config,
    bases,
    FIXTURE_MARKERS,
  );
}

export async function installCodeRoles(page, { surface, kind }) {
  return evaluate(
    page,
    ({ surface, kind }) => {
      const roles = window.__diffRoles;
      const color = window.__diffColors;
      const selector =
        surface === "source"
          ? '[data-file-diff="plan.md"] diffs-container'
          : ".spec-fence-diff:not(.spec-annotated) diffs-container";
      const host = document.querySelector(selector);
      if (
        !host?.shadowRoot?.querySelector(
          '[data-line-type="change-addition"]',
        ) ||
        !host.shadowRoot.querySelector('[data-line-type="change-deletion"]')
      )
        throw new Error(
          "fixture: no actual Pierre addition/deletion shadow lines in the required plan/fence",
        );
      const shadow = host.shadowRoot;
      const pre = shadow.querySelector("pre");
      const base = {
        addition: getComputedStyle(pre).getPropertyValue(
          "--diffs-addition-base",
        ),
        deletion: getComputedStyle(pre).getPropertyValue(
          "--diffs-deletion-base",
        ),
      };
      const rgba = {
        addition: color.resolve(pre, "var(--diffs-addition-base)"),
        deletion: color.resolve(pre, "var(--diffs-deletion-base)"),
      };
      const css = (c) => `color(srgb ${c[0]} ${c[1]} ${c[2]} / ${c[3]})`;
      for (const side of ["addition", "deletion"]) {
        const lines = [
          ...shadow.querySelectorAll(`[data-line-type="change-${side}"]`),
        ];
        const content = lines.filter(
          (e) => e.matches("[data-line]") && e.closest("[data-content]"),
        );
        const gutter = lines.filter(
          (e) =>
            e.matches("[data-column-number]") &&
            e.querySelector("[data-line-number-content]"),
        );
        roles.push({
          id: `code-${side}-line`,
          elements: content.slice(0, 2),
          properties: { "background-color": null, color: null },
          contrast: false,
        });
        roles.push({
          id: `code-${side}-number`,
          elements: gutter
            .slice(0, 2)
            .map((e) => e.querySelector("[data-line-number-content]")),
          properties: { color: null },
          contrast: false,
        });
        roles.push({
          id: `code-${side}-gutter`,
          elements: gutter.slice(0, 2),
          properties: { "background-color": null },
          contrast: false,
        });
        roles.push({
          id: `code-${side}-base`,
          elements: [pre],
          properties: { [`--diffs-${side}-base`]: null },
          contrast: false,
        });
        const syntax = content
          .flatMap((e) => [...e.querySelectorAll("[style]")])
          .slice(0, 2);
        roles.push({
          id: `code-${side}-syntax`,
          elements: syntax,
          properties: { color: null, "background-color": null },
          contrast: false,
        });
      }
      if (surface === "source") {
        roles.push({
          id: "code-context",
          elements: [
            ...shadow.querySelectorAll(
              '[data-content] [data-line][data-line-type="context"]',
            ),
          ].slice(0, 2),
          properties: { color: null, "background-color": null },
        });
        roles.push({
          id: "code-context-number",
          elements: [
            ...shadow.querySelectorAll(
              '[data-column-number][data-line-type="context"] [data-line-number-content]',
            ),
          ].slice(0, 2),
          properties: { color: null, "background-color": null },
        });
        roles.push({
          id: "code-separator",
          elements: [
            ...shadow.querySelectorAll("[data-separator-content]"),
          ].slice(0, 2),
          properties: { color: null, "background-color": null },
        });
        const unchangedShadow = document.querySelector(
          '[data-file-unchanged="unchanged.md"] diffs-container',
        )?.shadowRoot;
        const unchangedLines = unchangedShadow
          ? [
              ...unchangedShadow.querySelectorAll("[data-content] [data-line]"),
            ].filter((e) =>
              e.textContent.includes("untouched file preserves every byte"),
            )
          : [];
        roles.push({
          id: "unchanged-file-shadow",
          elements: unchangedLines,
          properties: { color: null, "background-color": null },
        });
        const renamedShadow = document.querySelector(
          '[data-file-diff="rename-after.md"] diffs-container',
        )?.shadowRoot;
        const renamedLines = renamedShadow
          ? [
              ...renamedShadow.querySelectorAll("[data-content] [data-line]"),
            ].filter((e) =>
              e.textContent.includes("pure rename preserves every byte"),
            )
          : [];
        roles.push({
          id: "renamed-file-shadow",
          elements: renamedLines,
          properties: { color: null, "background-color": null },
        });
        // Pierre replaces painted shadow nodes after async highlight/scroll work.
        // Preserve each sample's host, structural identity, and exact content so
        // a redraw can be rebound without filtering away a missing sample.
        for (const role of roles.filter(
          (r) => r.id.startsWith("code-") || r.id.endsWith("-file-shadow"),
        )) {
          role.locators = role.elements.map((element) => {
            const host = element.getRootNode().host;
            const wrapper = host.closest(
              "[data-file-diff],[data-file-unchanged]",
            );
            const attribute = wrapper.hasAttribute("data-file-diff")
              ? "data-file-diff"
              : "data-file-unchanged";
            const path = [];
            for (
              let node = element;
              node && node !== host.shadowRoot;
              node = node.parentElement
            ) {
              const peers = [...node.parentNode.children].filter(
                (p) => p.tagName === node.tagName,
              );
              path.unshift(
                `${node.tagName.toLowerCase()}:nth-of-type(${peers.indexOf(node) + 1})`,
              );
            }
            return {
              host: `[${attribute}="${CSS.escape(wrapper.getAttribute(attribute))}"] diffs-container`,
              path: path.join(" > "),
              text: element.textContent,
              tag: element.tagName,
            };
          });
        }
        window.__refreshDiffRole = (role) => {
          if (!role.locators) return;
          const faultStyle = role.faultInjected ? role.faultStyle : null;
          const verifyFaultStyle = (elements) => {
            if (!faultStyle) return;
            if (
              faultStyle.intended.length !== elements.length ||
              !faultStyle.styles.length ||
              faultStyle.styles.some(
                ({ element, text, cssText }) =>
                  !element.isConnected ||
                  element.textContent !== text ||
                  !element.sheet ||
                  [...element.sheet.cssRules]
                    .map((rule) => rule.cssText)
                    .join("\n") !== cssText,
              )
            )
              throw new Error(
                `fixture: ${role.id} injected shadow stylesheet or target count changed`,
              );
            for (const [index, element] of elements.entries()) {
              const actual = window.__diffColors.normalize(
                getComputedStyle(element).getPropertyValue(faultStyle.property),
              );
              const expected = faultStyle.intended[index];
              if (
                !faultStyle.styles.some(
                  (style) =>
                    style.element.getRootNode() === element.getRootNode(),
                ) ||
                !Array.isArray(expected) ||
                expected.length !== 4 ||
                actual[3] !== expected[3] ||
                actual
                  .slice(0, 3)
                  .some(
                    (value, channel) =>
                      Math.abs(value - expected[channel]) >
                      1 / 255 + Number.EPSILON,
                  )
              )
                throw new Error(
                  `fixture: ${role.id} rebound sample ${index} no longer carries the injected ${faultStyle.property}`,
                );
            }
          };
          if (role.elements.every((e) => e.isConnected)) {
            verifyFaultStyle(role.elements);
            return;
          }
          if (role.faultInjected && !faultStyle)
            throw new Error(
              `fixture: injected ${role.id} nodes were replaced; cannot rebind a fault target`,
            );
          if (role.locators.length !== role.elements.length)
            throw new Error(
              `fixture: ${role.id} sample count changed before redraw`,
            );
          const fresh = role.locators.map((locator) => {
            const node = document
              .querySelector(locator.host)
              ?.shadowRoot?.querySelector(locator.path);
            if (
              !node?.isConnected ||
              node.tagName !== locator.tag ||
              node.textContent !== locator.text
            )
              throw new Error(
                `fixture: ${role.id} redraw lost required host/path/content ${locator.host} ${locator.path}`,
              );
            return node;
          });
          if (new Set(fresh).size !== fresh.length)
            throw new Error(
              `fixture: ${role.id} redraw merged distinct samples`,
            );
          verifyFaultStyle(fresh);
          role.elements = fresh;
        };
      }
      return {
        addition: css(rgba.addition),
        deletion: css(rgba.deletion),
        rgba,
        raw: base,
        kind,
      };
    },
    { surface, kind },
  );
}

export async function measureRoles(page, config, state = "normal") {
  const roles = await evaluate(page, () =>
    window.__diffRoles.map((r) => ({ id: r.id, count: r.elements.length })),
  );
  const rows = [];
  const scan = async (id, onlyIndex) => {
    const role = window.__diffRoles.find((r) => r.id === id);
    const indices =
      onlyIndex === null ? role.elements.map((_, i) => i) : [onlyIndex];
    if (onlyIndex !== null)
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      );
    window.__refreshDiffRole?.(role);
    const results = [];
    for (const index of indices) {
      const e = role.elements[index];
      if (onlyIndex === null)
        e.scrollIntoView({
          block: "center",
          inline: "center",
          behavior: "instant",
        });
      const ancestors = [];
      for (
        let node = e;
        node;
        node = node.parentElement ?? node.getRootNode()?.host
      )
        ancestors.push(node);
      await Promise.all(
        ancestors
          .flatMap((node) => node.getAnimations())
          .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime))
          .map((a) => a.finished.catch(() => {})),
      );
      const rect = e.getBoundingClientRect();
      const css = getComputedStyle(e);
      if (
        !e.isConnected ||
        !e.getClientRects().length ||
        !rect.width ||
        !rect.height ||
        css.visibility !== "visible" ||
        Number(css.opacity) === 0
      ) {
        results.push({
          index,
          classification: "fixture",
          reason: "required production node is not connected and visible",
          node: {
            connected: e.isConnected,
            tag: e.tagName,
            text: e.textContent.trim().slice(0, 100),
            rect: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            },
            display: css.display,
            visibility: css.visibility,
            opacity: css.opacity,
            hostConnected: e.getRootNode()?.host?.isConnected ?? null,
          },
        });
        continue;
      }
      const props = [];
      for (const [property, recipe] of Object.entries(role.properties)) {
        const actual = property.startsWith("--")
          ? window.__diffColors.resolve(e, `var(${property})`)
          : window.__diffColors.normalize(css.getPropertyValue(property));
        props.push({
          property,
          actual,
          expected:
            recipe === null ? null : window.__diffColors.resolve(e, recipe),
          kind: recipe === null ? "baseline" : "color",
        });
      }
      const link = role.id.startsWith("rail-") ? e.closest("a[title]") : null;
      const selected =
        !!link &&
        new URL(link.href).searchParams.get("file") ===
          new URL(location.href).searchParams.get("file");
      if (selected && !link.classList.contains("bg-muted")) {
        results.push({
          index,
          classification: "fixture",
          reason: "selected file route has no production selected styling",
        });
        continue;
      }
      results.push({
        index,
        props,
        selected,
        count: role.elements.length,
        text: e.textContent.trim().slice(0, 100),
        contrast: role.contrast ? window.__diffColors.contrast(e) : null,
      });
    }
    return results;
  };
  if (state === "normal") {
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 0,
      y: 0,
    });
    await evaluate(
      page,
      async () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
  }
  for (const role of roles) {
    if (!role.count) {
      rows.push({
        ...config,
        state,
        role: role.id,
        classification: "fixture",
        reason: "required role has zero production nodes",
      });
      continue;
    }
    // Normal samples share one browser call per role; every node still gets
    // scrolled, checked, and measured. Hover retains actual pointer interaction.
    if (state === "normal") {
      for (const measured of await evaluate(page, scan, role.id, null))
        rows.push({ ...config, state, role: role.id, ...measured });
      continue;
    }
    for (let index = 0; index < role.count; index++) {
      const position = await evaluate(
        page,
        async (id, index) => {
          const role = window.__diffRoles.find((r) => r.id === id);
          window.__refreshDiffRole?.(role);
          const e = role.elements[index];
          e.scrollIntoView({
            block: "center",
            inline: "center",
            behavior: "instant",
          });
          const ancestors = [];
          for (
            let node = e;
            node;
            node = node.parentElement ?? node.getRootNode()?.host
          )
            ancestors.push(node);
          await Promise.all(
            ancestors
              .flatMap((node) => node.getAnimations())
              .filter((a) =>
                Number.isFinite(a.effect?.getComputedTiming().endTime),
              )
              .map((a) => a.finished.catch(() => {})),
          );
          const b = e.getBoundingClientRect();
          return {
            x: Math.max(0, Math.min(innerWidth - 1, b.x + b.width / 2)),
            y: Math.max(0, Math.min(innerHeight - 1, b.y + b.height / 2)),
          };
        },
        role.id,
        index,
      );
      await page.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: position.x,
        y: position.y,
      });
      for (const measured of await evaluate(page, scan, role.id, index))
        rows.push({ ...config, state, role: role.id, ...measured });
    }
  }
  return rows;
}

export const rowKey = (row) =>
  [
    row.theme,
    row.width,
    row.surface,
    row.status,
    row.draft ? "draft" : row.finishReview ? "review-dialog" : "published",
    row.state,
    row.selected ? "selected" : "unselected",
    row.role,
    row.index ?? 0,
  ].join("|");
export function assess(rows, baseline = null) {
  const failures = [];
  if (baseline && rows.length) {
    const pagePrefix = `${rowKey(rows[0]).split("|").slice(0, 5).join("|")}|`;
    const observed = new Set(
      rows.flatMap((r) =>
        (r.props ?? [])
          .filter((p) => p.kind === "baseline")
          .map((p) => `${rowKey(r)}|${p.property}`),
      ),
    );
    for (const key of Object.keys(baseline))
      if (key.startsWith(pagePrefix) && !observed.has(key))
        failures.push({
          classification: "fixture",
          role: key.split("|").at(-3),
          property: key.split("|").at(-1),
          reason: "required baseline sample disappeared",
          key,
        });
  }
  for (const row of rows) {
    if (row.classification) {
      failures.push(row);
      continue;
    }
    for (const p of row.props) {
      const expected = p.expected ?? baseline?.[`${rowKey(row)}|${p.property}`];
      if (p.kind === "baseline" && baseline === null) continue;
      if (
        !Array.isArray(expected) ||
        expected.length !== 4 ||
        !expected.every((n) => Number.isFinite(n) && n >= 0 && n <= 1)
      )
        failures.push({
          ...row,
          props: undefined,
          property: p.property,
          classification: "baseline-missing",
          reason: "expected RGBA missing or malformed",
        });
      else if (!colorsEqual(p.actual, expected))
        failures.push({
          ...row,
          props: undefined,
          property: p.property,
          expected,
          actual: p.actual,
          classification: p.kind,
        });
    }
    if (row.contrast !== null && row.contrast < 4.5)
      failures.push({
        ...row,
        props: undefined,
        property: "contrast",
        actual: row.contrast,
        expected: 4.5,
        classification: "contrast",
      });
  }
  return failures;
}
