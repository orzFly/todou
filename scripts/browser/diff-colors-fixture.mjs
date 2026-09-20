import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { evaluate } from "../lib/browser-cdp.mjs";

/** Text identities for production nodes; these are source, never injected DOM. */
export const FIXTURE_MARKERS = Object.freeze({
  heading: "Diff palette specimen",
  wordBefore: "copper",
  wordAfter: "violet",
  wordParagraph: "The delivery palette keeps",
  inserted: "Entirely new paragraph: hummingbirds collect ultraviolet nectar.",
  insertedAnnotated:
    "New annotated paragraph: observatories record distant pulsars.",
  deleted: "Retired structure contains",
  deletedLink: "retired reference",
  deletedCode: "retired_switch",
  tableHeader: "Retired column",
  tableCell: "obsolete-alpha",
  tableRow: "Retired row",
  frontmatterKey: "retired_field",
  frontmatterValue: "frontmatter-only-value",
  plainFenceBefore: 'const palette = "copper";',
  plainFenceAfter: 'const palette = "violet";',
  annotatedFenceBefore: 'const reviewed = "before";',
  annotatedFenceAfter: 'const reviewed = "after";',
  independent: "Independent annotation remains on this unchanged sentence.",
  changedAnnotated: "Reviewed paragraph keeps the shared sentence and now says",
  unchanged: "Unchanged context sample stays neutral through every palette.",
  draft: "Select this unchanged draft sentence for a local review note.",
  draftBody: "Local draft palette note, staged through the selection composer.",
  commentBody: "Independent API annotation palette note.",
  precisionCommentBody:
    "Independent column-anchored API annotation palette note.",
  changedCommentBody: "Changed paragraph API annotation palette note.",
  insertedCommentBody: "Inserted paragraph API annotation palette note.",
  fenceCommentBody: "Modified fence API annotation palette note.",
  addedFile: "added.md",
  removedFile: "removed.md",
  modifiedFile: "modified.md",
  unchangedFile: "unchanged.md",
  renamedFrom: "rename-before.md",
  renamedTo: "rename-after.md",
});

function documents() {
  const m = FIXTURE_MARKERS;
  const context = (group) =>
    Array.from(
      { length: 12 },
      (_, i) =>
        `Stable ${group} context ${i + 1}: the reference material preserves its original wording and punctuation.`,
    ).join("\n\n");
  const fence = (annotated, newer) =>
    [
      "```ts",
      `// ${annotated ? "Reviewed" : "Ordinary"} palette fence`,
      "export function specimen() {",
      "  const stable = 42;",
      `  ${
        annotated
          ? newer
            ? m.annotatedFenceAfter
            : m.annotatedFenceBefore
          : newer
            ? m.plainFenceAfter
            : m.plainFenceBefore
      }`,
      `  return { stable, ${annotated ? "reviewed" : "palette"} };`,
      "}",
      "```",
    ].join("\n");
  const plan = (newer) =>
    `${[
      [
        "---",
        "title: Palette specimen",
        "owner: fixture",
        ...(!newer ? [`${m.frontmatterKey}: ${m.frontmatterValue}`] : []),
        "phase: review",
        "---",
      ].join("\n"),
      `# ${m.heading}`,
      m.independent,
      m.draft,
      "## Word comparison",
      `${m.wordParagraph} its ${newer ? m.wordAfter : m.wordBefore} accent beside the same stable wording.`,
      `${m.changedAnnotated} ${newer ? "tomorrow" : "yesterday"}.`,
      "## Retained boundary before removal",
      "The preceding boundary remains byte for byte identical.",
      ...(!newer
        ? [
            `${m.deleted} a [${m.deletedLink}](https://example.test/retired) and \`${m.deletedCode}\` descendants.`,
          ]
        : []),
      "## Retained boundary after removal",
      "The following boundary remains byte for byte identical.",
      "## Inserted paragraphs",
      "The insertion boundary remains present in both versions.",
      ...(newer ? [m.inserted, m.insertedAnnotated] : []),
      "## Surviving table",
      (newer
        ? [
            "| Service | Owner | Result |",
            "| --- | --- | --- |",
            "| Alpha | Team alpha | Stable alpha |",
            "| Beta | Team beta | Stable beta |",
            "| Gamma | Team gamma | Stable gamma |",
            "| Delta | Team delta | Stable delta |",
          ]
        : [
            `| Service | Owner | Result | ${m.tableHeader} |`,
            "| --- | --- | --- | --- |",
            `| Alpha | Team alpha | Stable alpha | ${m.tableCell} |`,
            "| Beta | Team beta | Stable beta | obsolete-beta |",
            `| ${m.tableRow} | Retired owner | Retired result | obsolete-row |`,
            "| Gamma | Team gamma | Stable gamma | obsolete-gamma |",
            "| Delta | Team delta | Stable delta | obsolete-delta |",
          ]
      ).join("\n"),
      "## Ordinary modified fence",
      fence(false, newer),
      "## Expandable unchanged context",
      context("first"),
      m.unchanged,
      "## Reviewed modified fence",
      fence(true, newer),
      "## Retained fold sample",
      context("last"),
      "The final reference boundary is unchanged.",
    ].join("\n\n")}\n`;
  const renamed = "# Moved document\n\nThe pure rename preserves every byte.\n";
  const unchanged =
    "# Unchanged document\n\nThe untouched file preserves every byte.\n";
  return [false, true].map((newer) => [
    { path: "plan.md", body: plan(newer) },
    { path: m.unchangedFile, body: unchanged },
    { path: newer ? m.renamedTo : m.renamedFrom, body: renamed },
    {
      path: m.modifiedFile,
      body: `# Modified document\n\nA separate file uses ${newer ? "updated" : "original"} wording.\n`,
    },
    newer
      ? {
          path: m.addedFile,
          body: "# New appendix\n\nBrand new implementation notes.\n",
        }
      : {
          path: m.removedFile,
          body: "# Obsolete appendix\n\nRetired deployment instructions.\n",
        },
  ]);
}

function fixtureError(message) {
  return new Error(`diff-colors fixture: ${message}`);
}

/** Seed only the loopback API started by createBrowserStack. */
export async function seedDiffFixture(serverPort) {
  if (!Number.isInteger(serverPort) || serverPort <= 0 || serverPort > 65535)
    throw fixtureError(
      "seedDiffFixture requires the isolated API's numeric port",
    );
  const base = `http://127.0.0.1:${serverPort}/api`;
  let cookie = "";
  const call = async (method, path, body, token) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token
          ? { authorization: `Bearer ${token}` }
          : cookie
            ? { cookie }
            : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const setCookie = response.headers.get("set-cookie");
    if (!token && setCookie) cookie = setCookie.split(";", 1)[0];
    const text = await response.text();
    if (!response.ok)
      throw fixtureError(`${method} ${path} -> ${response.status}: ${text}`);
    return text === "" ? null : JSON.parse(text);
  };
  await call("POST", "/auth/login");
  const viewer = await call("GET", "/me");
  if (!cookie) throw fixtureError("isolated login returned no session cookie");
  const suffix = randomUUID().slice(0, 8);
  const slug = `diff-colors-${suffix}`;
  const project = await call("POST", "/projects", {
    slug,
    name: "Diff colors fixture",
    description: "Isolated browser palette samples",
  });
  const submitter = await call("POST", "/agents", {
    login: `palette-agent-${suffix}`,
    display_name: "Palette Submitter",
  });
  await call("PUT", `/projects/${slug}/members/${submitter.id}`, {
    role: "writer",
  });
  const credential = await call("POST", `/agents/${submitter.id}/tokens`, {
    name: "Isolated palette fixture",
  });
  if (!credential?.token)
    throw fixtureError("agent credential API returned no token");
  const actor = await call("GET", "/me", undefined, credential.token);
  if (actor.id !== submitter.id || actor.id === viewer.id)
    throw fixtureError(
      "agent credential did not establish a distinct submitter",
    );
  const [before, after] = documents();
  const currentBody = after.find((file) => file.path === "plan.md").body;
  const anchorAt = (text) => {
    const lines = currentBody.split("\n");
    const matches = lines.flatMap((line, i) =>
      line.includes(text) ? [i + 1] : [],
    );
    if (matches.length !== 1)
      throw fixtureError(`ambiguous annotation anchor: ${text}`);
    return {
      path: "plan.md",
      version: 2,
      line_start: matches[0],
      line_end: matches[0],
    };
  };
  const m = FIXTURE_MARKERS;
  const annotationInputs = [
    { anchor: anchorAt(m.independent), body: m.commentBody },
    {
      anchor: {
        ...anchorAt(m.independent),
        col_start: 1,
        col_end: m.independent.length,
      },
      body: m.precisionCommentBody,
    },
    { anchor: anchorAt(m.changedAnnotated), body: m.changedCommentBody },
    { anchor: anchorAt(m.insertedAnnotated), body: m.insertedCommentBody },
    { anchor: anchorAt(m.annotatedFenceAfter), body: m.fenceCommentBody },
  ];
  const issues = {};
  for (const status of ["unreviewed", "approved", "changes_requested"]) {
    const issue = await call("POST", `/projects/${slug}/issues`, {
      title: `Diff palette ${status}`,
      body: "Production spec surfaces for an isolated palette fixture.",
    });
    const path = `/projects/${slug}/issues/${issue.number}/spec`;
    const first = await call(
      "POST",
      `${path}/push`,
      {
        files: before,
        message: "Palette baseline",
      },
      credential.token,
    );
    const second = await call(
      "POST",
      `${path}/push`,
      {
        files: after,
        message: "Palette comparison",
        if_version: first.version,
      },
      credential.token,
    );
    if (
      first.unchanged ||
      second.unchanged ||
      first.version !== 1 ||
      second.version !== 2
    )
      throw fixtureError(
        `${status}: two distinct pushes did not create v1 and v2`,
      );
    for (const [version, expected] of [
      [first.version, before],
      [second.version, after],
    ]) {
      const stored = await call("GET", `${path}/files?version=${version}`);
      if (
        stored.version !== version ||
        stored.files.length !== expected.length ||
        expected.some(
          (file) =>
            !stored.files.some(
              (saved) => saved.path === file.path && saved.body === file.body,
            ),
        )
      )
        throw fixtureError(
          `${status}: v${version} file readback differs from submitted source`,
        );
    }
    const annotations = await call("POST", `${path}/reviews`, {
      version: second.version,
      verdict: "comment",
      comments: annotationInputs,
    });
    const review =
      status === "unreviewed"
        ? null
        : await call("POST", `${path}/reviews`, {
            version: second.version,
            verdict: status === "approved" ? "approve" : "request_changes",
            body: `Palette fixture ${status} review.`,
          });
    const info = await call("GET", path);
    const comments = await call("GET", `${path}/comments`);
    if (
      info.current_version !== second.version ||
      info.review_status !== status ||
      info.versions.length !== 2 ||
      info.versions.some(
        (version, index) =>
          version.number !== index + 1 || version.author.id !== submitter.id,
      )
    )
      throw fixtureError(
        `${status}: spec identity or review status readback is wrong`,
      );
    if (
      annotations.comment_ids.length !== annotationInputs.length ||
      annotationInputs.some(
        (input, i) =>
          !comments.items.some(
            (item) =>
              item.comment_id === annotations.comment_ids[i] &&
              item.body === input.body &&
              item.anchor.quote ===
                currentBody.split("\n")[input.anchor.line_start - 1],
          ),
      )
    )
      throw fixtureError(`${status}: API annotation readback is incomplete`);
    issues[status] = {
      id: issue.id,
      number: issue.number,
      version: second.version,
      baseline: first.version,
      firstPush: first,
      secondPush: second,
      annotationReviewId: annotations.event_id,
      commentIds: annotations.comment_ids,
      reviewId: review?.event_id ?? null,
      status: info.review_status,
    };
  }
  return {
    slug,
    projectId: project.id,
    number: issues.unreviewed.number,
    issues,
    cookie,
    viewerId: viewer.id,
    submitterId: submitter.id,
    markers: m,
    files: { before, after },
  };
}

async function waitFor(page, label, probe, ...args) {
  const deadline = Date.now() + 30_000;
  let state;
  while (Date.now() < deadline) {
    if (page.fixtureErrors.length)
      throw fixtureError(`${label}: ${page.fixtureErrors.join("; ")}`);
    state = await evaluate(page, probe, ...args);
    if (state?.error) throw fixtureError(`${label}: ${state.error}`);
    if (state === true || state?.ready) return state;
    await sleep(100);
  }
  const rejections = await evaluate(
    page,
    () => window.__diffFixtureRejections ?? [],
  );
  throw fixtureError(
    `${label} timed out: ${JSON.stringify({
      state,
      console: page.fixtureConsole,
      pendingRequests: [...page.fixtureRequests.values()].filter(
        (entry) => !new URL(entry.url).pathname.startsWith("/api/"),
      ),
      rejections,
    })}`,
  );
}

async function clickButton(page, label, text, selector = "button") {
  await waitFor(
    page,
    label,
    (text, selector) => {
      const button = [...document.querySelectorAll(selector)].find(
        (node) =>
          (node.textContent.trim() === text ||
            node.getAttribute("aria-label") === text) &&
          node.getBoundingClientRect().height > 0 &&
          !node.disabled,
      );
      if (!button) return { ready: false, missing: text };
      button.scrollIntoView({ block: "center", behavior: "instant" });
      button.click();
      return true;
    },
    text,
    selector,
  );
}

async function prepareRendered(page, comparing) {
  await waitFor(
    page,
    "rendered markdown",
    (heading) => {
      const root = document.querySelector('[data-testid="annotated-markdown"]');
      return { ready: !!root?.textContent.includes(heading) };
    },
    FIXTURE_MARKERS.heading,
  );
  // Let cold lazy code render before fold expansion reparses the markdown.
  await prepareFences(page, comparing);
  if (comparing) {
    // Open every fold except the last. The retained fold has its own long,
    // unchanged section; it never hides one of the required changed samples.
    await waitFor(page, "rendered folds", () => ({
      ready: document.querySelectorAll(".spec-fold").length >= 2,
      folds: document.querySelectorAll(".spec-fold").length,
    }));
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await evaluate(page, () => {
        const folds = [...document.querySelectorAll(".spec-fold")];
        if (folds.length === 1) return { done: true };
        if (!folds.length) return { error: "rendered fold sample disappeared" };
        const first = folds[0];
        const key = first.getAttribute("data-fold-key");
        first.scrollIntoView({ block: "center", behavior: "instant" });
        first.click();
        return { key };
      });
      if (result.error) throw fixtureError(result.error);
      if (result.done) break;
      await waitFor(
        page,
        "fold expansion",
        (key) =>
          ![...document.querySelectorAll(".spec-fold")].some(
            (node) => node.getAttribute("data-fold-key") === key,
          ),
        result.key,
      );
      if (attempt === 29)
        throw fixtureError("too many rendered folds to prepare");
    }
  }
  await waitFor(
    page,
    "rendered role readiness",
    (m, comparing) => {
      const visible = (node) =>
        !!node &&
        node.getBoundingClientRect().width > 0 &&
        node.getBoundingClientRect().height > 0 &&
        getComputedStyle(node).visibility !== "hidden";
      const contains = (selector, text) =>
        [...document.querySelectorAll(selector)].some(
          (node) => visible(node) && node.textContent.includes(text),
        );
      const roles = [
        [
          "independent annotation",
          ".spec-annotated:not(.spec-changed):not(.spec-ins-block)",
          m.independent,
        ],
        [
          "unchanged context",
          '[data-testid="annotated-markdown"] p',
          m.unchanged,
        ],
        ["draft source", '[data-testid="annotated-markdown"] p', m.draft],
        ...(comparing
          ? [
              ["word insertion", "ins.spec-ins", m.wordAfter],
              ["word deletion", "del.spec-del", m.wordBefore],
              ["whole insertion", ".spec-ins-block", m.inserted],
              [
                "annotated insertion",
                ".spec-ins-block.spec-annotated",
                m.insertedAnnotated,
              ],
              [
                "annotated change",
                ".spec-changed.spec-annotated",
                m.changedAnnotated,
              ],
              ["deleted structure", ".spec-del-structure", m.deleted],
              [
                "deleted link descendant",
                ".spec-del-structure a",
                m.deletedLink,
              ],
              [
                "deleted code descendant",
                ".spec-del-structure code",
                m.deletedCode,
              ],
              [
                "deleted table header",
                "table:not(.markdown-frontmatter) th.spec-del-cell",
                m.tableHeader,
              ],
              [
                "deleted table cell",
                "table:not(.markdown-frontmatter) td.spec-del-cell",
                m.tableCell,
              ],
              [
                "deleted table row",
                "table:not(.markdown-frontmatter) tr.spec-del-row",
                m.tableRow,
              ],
              // applyOverlay restores deleted frontmatter rows with two td cells.
              [
                "frontmatter deleted key",
                ".markdown-frontmatter tr.spec-del-row td:first-child",
                m.frontmatterKey,
              ],
              [
                "frontmatter deleted value",
                ".markdown-frontmatter tr.spec-del-row td:last-child",
                m.frontmatterValue,
              ],
            ]
          : []),
      ];
      const missing = roles
        .filter(([, selector, text]) => !contains(selector, text))
        .map(([role]) => role);
      if (comparing && !visible(document.querySelector(".spec-fold")))
        missing.push("retained fold");
      if (comparing) {
        const cells = [
          ...document.querySelectorAll(
            ".markdown-frontmatter tr.spec-del-row td",
          ),
        ];
        if (
          cells.length !== 2 ||
          cells.some(
            (cell) =>
              !getComputedStyle(cell).textDecorationLine.includes(
                "line-through",
              ),
          )
        ) {
          missing.push("frontmatter key and value deletion lines");
        }
      }
      return { ready: missing.length === 0, missing };
    },
    FIXTURE_MARKERS,
    comparing,
  );
  await prepareFences(page, comparing);
}

async function prepareFences(page, comparing) {
  // Each fence must finish its real lazy/shadow render, even below the fold.
  await waitFor(page, "both fence wrappers mounted", () => ({
    ready: document.querySelectorAll(".markdown-fence").length === 2,
    count: document.querySelectorAll(".markdown-fence").length,
  }));
  const count = 2;
  for (let index = 0; index < count; index++) {
    await evaluate(
      page,
      (index) =>
        document
          .querySelectorAll(".markdown-fence")
          [index].scrollIntoView({ block: "center", behavior: "instant" }),
      index,
    );
    await waitFor(
      page,
      `fence ${index + 1} lazy host mounted`,
      (index) => ({
        ready: !!document
          .querySelectorAll(".markdown-fence")
          [index]?.querySelector("diffs-container"),
      }),
      index,
    );
    await evaluate(
      page,
      async (index) => {
        const host = document
          .querySelectorAll(".markdown-fence")
          [index]?.querySelector("diffs-container");
        if (!host) throw new Error("fence host disappeared before scroll");
        host.scrollIntoView({ block: "center", behavior: "instant" });
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
      },
      index,
    );
    await waitFor(
      page,
      `fence ${index + 1} shadow lines`,
      (index, comparing) => {
        const wrapper = document.querySelectorAll(".markdown-fence")[index];
        if (!wrapper) return { error: "fence wrapper disappeared" };
        const shadow = wrapper.querySelector("diffs-container")?.shadowRoot;
        if (shadow?.querySelector("[data-error-wrapper]"))
          return { error: "Pierre reported a fence render error" };
        const addition = shadow?.querySelector(
          '[data-line-type="change-addition"]',
        );
        const deletion = shadow?.querySelector(
          '[data-line-type="change-deletion"]',
        );
        const visible = (node) =>
          !!node &&
          node.getBoundingClientRect().height > 0 &&
          getComputedStyle(node).visibility !== "hidden";
        const decorationReady =
          !comparing ||
          (wrapper.classList.contains("spec-changed") &&
            wrapper.classList.contains("spec-fence-diff") &&
            wrapper.classList.contains("spec-annotated") === (index === 1));
        const describe = (node) => {
          if (!node) return null;
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return {
            tag: node.tagName,
            type: node.getAttribute("data-line-type"),
            rect: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            },
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            text: node.textContent.slice(0, 160),
            html: node.outerHTML.slice(0, 800),
          };
        };
        const census = {};
        for (const node of shadow?.querySelectorAll("[data-line-type]") ?? []) {
          const type = node.getAttribute("data-line-type");
          census[type] = (census[type] ?? 0) + 1;
        }
        const ready =
          decorationReady &&
          (comparing
            ? visible(addition) && visible(deletion)
            : visible(shadow?.querySelector("[data-line]")));
        return {
          ready,
          host: !!shadow,
          annotated: wrapper.classList.contains("spec-annotated"),
          decorationReady,
          ...(!ready
            ? {
                census,
                wrapper: describe(wrapper),
                hostNode: describe(shadow?.host),
                addition: describe(addition),
                deletion: describe(deletion),
                lines: [...(shadow?.querySelectorAll("[data-line]") ?? [])]
                  .slice(0, 8)
                  .map(describe),
                ancestors: [
                  wrapper.parentElement,
                  wrapper.parentElement?.parentElement,
                ].map(describe),
                shadowHtml: [...(shadow?.children ?? [])]
                  .filter((node) => !["STYLE", "LINK"].includes(node.tagName))
                  .map((node) => node.outerHTML)
                  .join("")
                  .slice(0, 5000),
              }
            : {}),
        };
      },
      index,
      comparing,
    );
  }
}

async function prepareSource(page) {
  await waitFor(
    page,
    "source diff mounted",
    () => document.querySelectorAll("diffs-container").length > 0,
  );
  // Pure unchanged and pure renamed entries mount their source only on demand.
  await waitFor(page, "unchanged source file controls", () => ({
    ready:
      [...document.querySelectorAll('button[aria-expanded="false"]')].filter(
        (node) => node.textContent.includes("show file"),
      ).length === 2,
  }));
  await evaluate(page, () => {
    for (const node of document.querySelectorAll(
      'button[aria-expanded="false"]',
    )) {
      if (node.textContent.includes("show file")) node.click();
    }
  });
  await waitFor(page, "all source files mounted", () => ({
    ready: document.querySelectorAll("diffs-container").length === 6,
  }));
  for (let index = 0; index < 6; index++) {
    await evaluate(
      page,
      (index) =>
        document
          .querySelectorAll("diffs-container")
          [index].scrollIntoView({ block: "center", behavior: "instant" }),
      index,
    );
    await waitFor(
      page,
      `source file ${index + 1} real lines`,
      (index) => {
        const host = document.querySelectorAll("diffs-container")[index];
        const shadow = host?.shadowRoot;
        if (shadow?.querySelector("[data-error-wrapper]"))
          return { error: "Pierre reported a source render error" };
        return {
          ready: !!shadow?.querySelector("[data-line]")?.getBoundingClientRect()
            .height,
        };
      },
      index,
    );
  }
  await evaluate(page, () => {
    const plan = document.querySelector('[data-file-diff="plan.md"]');
    if (!plan) throw new Error("source plan.md entry is missing");
    plan.scrollIntoView({ block: "start", behavior: "instant" });
  });
  await waitFor(page, "source additions and deletions", () => {
    const plan = document.querySelector(
      '[data-file-diff="plan.md"] diffs-container',
    )?.shadowRoot;
    return {
      ready:
        !!plan?.querySelector('[data-line-type="change-addition"]') &&
        !!plan.querySelector('[data-line-type="change-deletion"]'),
    };
  });
}

async function prepareIssue(page, version) {
  await waitFor(
    page,
    "issue spec entry and sidebar",
    (version) => ({
      ready:
        !!document
          .querySelector('[data-testid="spec-entry"]')
          ?.textContent.includes(`Spec v${version}`) &&
        !!document.querySelector('[data-testid="spec-sidebar"]'),
    }),
    version,
  );
  await evaluate(page, () => {
    document.querySelector('[data-testid="reveal-all-eye"]')?.click();
    for (const button of document.querySelectorAll(
      'button[aria-label="expand file list"]',
    ))
      button.click();
    const sidebar = document.querySelector('[data-testid="spec-sidebar"]');
    for (
      let parent = sidebar?.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      if (parent instanceof HTMLDetailsElement && !parent.open)
        parent.querySelector("summary")?.click();
    }
  });
  await waitFor(
    page,
    "issue timeline and sidebar statistics",
    (m, version) => {
      const sidebar = document.querySelector('[data-testid="spec-sidebar"]');
      const title = [...document.querySelectorAll("a")].find(
        (node) =>
          node.textContent.trim() === `Spec v${version}` &&
          node.closest('[data-testid="spec-entry"]') === null &&
          node.closest('[data-testid="spec-sidebar"]') === null,
      );
      const card = title?.parentElement?.parentElement;
      const ready =
        !!sidebar?.querySelector("ul") &&
        !!card?.querySelector("ul") &&
        [m.addedFile, m.removedFile, m.modifiedFile, m.renamedTo].every(
          (path) => card.textContent.includes(path),
        ) &&
        card.textContent.includes("±0") &&
        sidebar.textContent.includes("±0");
      return {
        ready,
        sidebar: !!sidebar,
        card: !!card,
        text: card?.textContent.slice(0, 400),
      };
    },
    FIXTURE_MARKERS,
    version,
  );
}

async function stageDraft(page) {
  await evaluate(
    page,
    (text) => {
      const paragraph = [
        ...document.querySelectorAll('[data-testid="annotated-markdown"] p'),
      ].find((node) => node.textContent === text);
      if (!paragraph) throw new Error("draft source paragraph is missing");
      paragraph.scrollIntoView({ block: "center", behavior: "instant" });
      const range = document.createRange();
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      if (nodes.length === 0)
        throw new Error("draft paragraph has no selectable text");
      // Production column mapping requires text-node endpoints, as a user's
      // character selection supplies; selectNodeContents uses element endpoints.
      range.setStart(nodes[0], 0);
      range.setEnd(nodes.at(-1), nodes.at(-1).textContent.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    },
    FIXTURE_MARKERS.draft,
  );
  await waitFor(page, "selection comment action", () => {
    const button = [
      ...document.querySelectorAll("button[data-annotation-ui]"),
    ].find((node) => /^Comment L\d/.test(node.textContent.trim()));
    if (!button) return { ready: false };
    button.click();
    return true;
  });
  await waitFor(page, "spec comment composer", () => {
    const editor = document.querySelector(
      '[contenteditable="true"][aria-label="Spec comment"]',
    );
    if (!editor) return { ready: false };
    editor.focus();
    return true;
  });
  await page.send("Input.insertText", { text: FIXTURE_MARKERS.draftBody });
  await clickButton(page, "stage draft comment", "Stage comment");
  await waitFor(
    page,
    "staged draft annotation",
    (text) => {
      const marks = [...document.querySelectorAll(".spec-mark-draft")];
      const finish = [
        ...document.querySelectorAll('button[aria-label^="Finish review"]'),
      ];
      return {
        ready:
          marks.some(
            (node) =>
              node.textContent.includes(text) &&
              node.getBoundingClientRect().height > 0,
          ) &&
          finish.some(
            (node) =>
              node.getAttribute("aria-label") === "Finish review (1 staged)",
          ),
        marks: marks.map((node) => ({
          text: node.textContent,
          html: node.outerHTML,
          height: node.getBoundingClientRect().height,
        })),
        finish: finish.map((node) => ({
          label: node.getAttribute("aria-label"),
          text: node.textContent,
        })),
        paragraph: [
          ...document.querySelectorAll('[data-testid="annotated-markdown"] p'),
        ].find((node) => node.textContent.includes(text))?.outerHTML,
        editors: [...document.querySelectorAll('[contenteditable="true"]')].map(
          (node) => ({
            label: node.getAttribute("aria-label"),
            text: node.textContent,
          }),
        ),
        drafts: Object.keys(localStorage)
          .filter((key) => key.startsWith("todou-spec-review:"))
          .map((key) => ({ key, value: localStorage.getItem(key) })),
      };
    },
    FIXTURE_MARKERS.draft,
  );
}

/**
 * Every call owns a fresh incognito context. Close the returned page normally;
 * its close method also disposes that context and any local review draft.
 * surfaces: rendered, source, issue, plain (no comparison), files (mobile).
 * finishReview opens the actual verdict dialog without submitting a review.
 */
export async function openDiffPage(browser, base, fixture, options = {}) {
  const {
    surface = "rendered",
    status = "unreviewed",
    theme = "light",
    width = surface === "files" ? 390 : 1280,
    height = 1000,
    draft = false,
    finishReview = false,
    systemTheme = "light",
    warmup = ["rendered", "source", "files"].includes(surface),
  } = options;
  if (!["rendered", "source", "issue", "plain", "files"].includes(surface))
    throw fixtureError(`unknown page surface ${surface}`);
  if (surface === "files" && width >= 1024)
    throw fixtureError("Files popover needs a viewport below lg (1024px)");
  if (draft && !["rendered", "plain", "files"].includes(surface))
    throw fixtureError("draft selection requires a rendered page");
  const issue = fixture.issues[status];
  if (!issue) throw fixtureError(`unknown review status ${status}`);
  const preference = typeof theme === "string" ? theme : theme.value;
  const lightThemes = [
    "light",
    "pico-light",
    "solarized-light",
    "vs-light",
    "github-light",
    "catppuccin-latte",
    "gruvbox-light",
  ];
  const kind =
    preference === "system"
      ? systemTheme
      : (options.kind ??
        (typeof theme === "object" ? theme.kind : undefined) ??
        (lightThemes.includes(preference) ? "light" : "dark"));
  const route = `/projects/${fixture.slug}/issues/${issue.number}`;
  const url = new URL(
    surface === "issue"
      ? route
      : `${route}/spec?${new URLSearchParams({
          file: "plan.md",
          v: String(issue.version),
          ...(surface === "plain" ? {} : { compare: String(issue.baseline) }),
          view: surface === "source" ? "source" : "rendered",
        })}`,
    base,
  ).href;
  const context = await browser.newContext();
  let page;
  try {
    const equals = fixture.cookie.indexOf("=");
    if (equals < 1) throw fixtureError("invalid fixture session cookie");
    page = await context.newPage({
      viewport: { width, height, deviceScaleFactor: 1, mobile: width < 640 },
      cookie: {
        name: fixture.cookie.slice(0, equals),
        value: fixture.cookie.slice(equals + 1),
        url,
      },
      scripts: [
        `localStorage.setItem('todou-theme', ${JSON.stringify(preference)});
        localStorage.setItem('todou-theme-kind', ${JSON.stringify(kind)});
        localStorage.setItem('todou-spec-fold', 'on');
        window.__diffFixtureRejections = [];
        window.addEventListener('unhandledrejection', (event) => {
          window.__diffFixtureRejections.push(String(event.reason?.stack ?? event.reason));
        });`,
      ],
    });
    const closePage = page.close.bind(page);
    let closing;
    page.close = () =>
      (closing ??= (async () => {
        try {
          await closePage();
        } finally {
          await context.close();
        }
      })());
    page.fixture = {
      surface,
      status,
      theme: preference,
      kind,
      width,
      height,
      issue,
      url,
    };
    page.fixtureErrors = [];
    page.fixtureConsole = [];
    const requests = new Map();
    page.fixtureRequests = requests;
    const networkDiagnostic = (entry) => {
      page.fixtureConsole.push(entry);
      if (page.fixtureConsole.length > 80) page.fixtureConsole.shift();
    };
    page.on("Network.requestWillBeSent", ({ requestId, type, request }) => {
      requests.set(requestId, {
        url: request.url,
        type,
        startedAt: Date.now(),
      });
      if (type === "Font" || /\.(woff2?|ttf|otf)(?:\?|$)/i.test(request.url))
        networkDiagnostic({ type: "font-request", url: request.url });
    });
    page.on("Page.frameNavigated", ({ frame }) => {
      networkDiagnostic({
        type: "frame-navigation",
        url: frame.url,
        frameId: frame.id,
        parentId: frame.parentId,
        loaderId: frame.loaderId,
      });
    });
    page.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
      page.fixtureErrors.push(
        exceptionDetails.exception?.description ?? exceptionDetails.text,
      );
    });
    page.on("Runtime.consoleAPICalled", ({ type, args }) => {
      const message = args
        .map((arg) => arg.value ?? arg.description ?? "")
        .join(" ");
      if (type === "error" || type === "warning") {
        page.fixtureConsole.push({ type, message: message.slice(0, 1500) });
        if (page.fixtureConsole.length > 20) page.fixtureConsole.shift();
      }
      if (
        (type === "error" || type === "warning") &&
        /pierre|CodeView failed/i.test(message)
      )
        page.fixtureErrors.push(message);
    });
    page.on("Network.responseReceived", ({ response }) => {
      if (response.status >= 400)
        networkDiagnostic({
          type: "http-error",
          status: response.status,
          url: response.url,
        });
      if (
        response.status >= 400 &&
        new URL(response.url).pathname.startsWith("/api/")
      )
        page.fixtureErrors.push(
          `API ${response.status}: ${new URL(response.url).pathname}`,
        );
    });
    page.on(
      "Network.loadingFailed",
      ({
        requestId,
        type,
        errorText,
        canceled,
        blockedReason,
        corsErrorStatus,
      }) => {
        networkDiagnostic({
          type: "network-error",
          resourceType: type,
          url: requests.get(requestId)?.url,
          errorText,
          canceled,
          blockedReason,
          corsErrorStatus,
        });
        requests.delete(requestId);
      },
    );
    page.on("Network.loadingFinished", ({ requestId }) =>
      requests.delete(requestId),
    );
    await page.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: systemTheme }],
    });
    const startPlain = warmup || surface === "plain";
    const initialUrl = startPlain
      ? new URL(
          `${route}/spec?${new URLSearchParams({
            file: "plan.md",
            v: String(issue.version),
            compare: String(issue.baseline),
            view: "rendered",
          })}`,
          base,
        ).href
      : url;
    await page.navigate(initialUrl);
    await waitFor(
      page,
      "production initial route and theme",
      (preference, kind, systemTheme, surface, expectedUrl) => ({
        ready:
          location.href === expectedUrl &&
          document.documentElement?.dataset.theme ===
            (preference === "system" ? systemTheme : preference) &&
          document.documentElement?.classList.contains("dark") ===
            (kind === "dark") &&
          localStorage.getItem("todou-theme") === preference &&
          !!document.querySelector(
            surface === "issue"
              ? '[data-testid="spec-entry"]'
              : '[data-testid="annotated-markdown"], [data-file-diff]',
          ),
        theme: document.documentElement?.dataset.theme ?? null,
        text: document.body?.innerText.slice(0, 350),
      }),
      preference,
      kind,
      systemTheme,
      surface,
      initialUrl,
    );
    if (startPlain) {
      try {
        await clickButton(
          page,
          "turn production comparison off",
          `comparing against v${issue.baseline}, turn comparing off`,
        );
        await waitFor(page, "real plain reading state", () => ({
          ready:
            !!document.querySelector(
              'button[aria-label="turn comparing on"][aria-pressed="false"]',
            ) &&
            document.querySelectorAll(
              ".spec-fence-diff, ins.spec-ins, del.spec-del",
            ).length === 0,
        }));
        const timeOrigin = await evaluate(page, () => performance.timeOrigin);
        page.fixture.warmupUrl = await evaluate(page, () => location.href);
        await prepareFences(page, false);
        if (warmup && surface !== "plain") {
          await clickButton(
            page,
            "restore production comparison",
            "turn comparing on",
          );
          await waitFor(
            page,
            "comparison restored in same document",
            (baseline, timeOrigin) => ({
              ready:
                performance.timeOrigin === timeOrigin &&
                !!document.querySelector(
                  `button[aria-label="comparing against v${baseline}, turn comparing off"][aria-pressed="true"]`,
                ),
              timeOrigin: performance.timeOrigin,
            }),
            issue.baseline,
            timeOrigin,
          );
          if (surface === "source") {
            await clickButton(
              page,
              "open production source link",
              "source",
              'fieldset[aria-label="comparison view"] a',
            );
            await waitFor(
              page,
              "source comparison route",
              (baseline) => ({
                ready:
                  new URLSearchParams(location.search).get("compare") ===
                    String(baseline) &&
                  !!document.querySelector('[data-file-diff="plan.md"]'),
              }),
              issue.baseline,
            );
          }
          page.fixture.warmupReady = true;
        }
      } catch (error) {
        throw fixtureError(
          `plain production preparation failed: ${error.message}`,
        );
      }
    }
    page.fixture.url = await evaluate(page, () => location.href);
    if (surface === "issue") await prepareIssue(page, issue.version);
    else if (surface === "source") await prepareSource(page);
    else await prepareRendered(page, surface !== "plain");
    if (draft) await stageDraft(page);
    if (finishReview) {
      if (surface === "issue")
        throw fixtureError("finishReview needs a spec page");
      if (surface === "files")
        throw fixtureError(
          "finishReview and Files are separate overlay samples",
        );
      await clickButton(
        page,
        "open review dialog",
        draft ? "Finish review (1 staged)" : "Finish review",
      );
      await waitFor(page, "review verdict controls", () => {
        const controls = [
          ...document.querySelectorAll('[role="dialog"] button'),
        ];
        const visible = (node) =>
          !!node && node.getBoundingClientRect().height > 0;
        return {
          ready:
            ["Comment", "Approve", "Request changes"].every((text) =>
              controls.some(
                (node) => node.textContent.trim() === text && visible(node),
              ),
            ) &&
            ["Approve", "Request changes"].every((text) =>
              controls.some(
                (node) => node.textContent.trim() === text && !node.disabled,
              ),
            ),
          controls: controls.map((node) => ({
            text: node.textContent.trim(),
            disabled: node.disabled,
            height: node.getBoundingClientRect().height,
            html: node.outerHTML.slice(0, 1000),
          })),
          activeElement: document.activeElement?.outerHTML.slice(0, 1000),
          body: document.body.innerText.slice(-2500),
        };
      });
    }
    if (surface === "files") {
      await waitFor(page, "open mobile Files", () => {
        const button = [...document.querySelectorAll("button")].find(
          (node) =>
            /^Files \(/.test(node.textContent.trim()) &&
            node.getBoundingClientRect().height > 0,
        );
        if (!button) return { ready: false };
        button.scrollIntoView({ block: "center", behavior: "instant" });
        button.click();
        return true;
      });
      await waitFor(
        page,
        "mobile Files contents",
        (m) => {
          const popup = document.querySelector(
            "[data-radix-popper-content-wrapper]",
          );
          return {
            ready:
              !!popup &&
              popup.getBoundingClientRect().height > 0 &&
              [
                m.addedFile,
                m.removedFile,
                m.renamedTo,
                m.unchangedFile,
                m.modifiedFile,
              ].every((path) => popup.textContent.includes(path)) &&
              popup.textContent.includes("±0"),
          };
        },
        FIXTURE_MARKERS,
      );
    }
    const fontLoad = await evaluate(page, async () => {
      let timer;
      try {
        return await Promise.race([
          document.fonts
            .load('12px "Geist Variable"', "Palette specimen")
            .then((faces) => ({
              loaded: faces.map((face) => ({
                family: face.family,
                status: face.status,
              })),
            }))
            .catch((error) => ({ error: String(error) })),
          new Promise((resolve) => {
            timer = setTimeout(
              () => resolve({ error: "Geist load exceeded 8 seconds" }),
              8000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    });
    await waitFor(
      page,
      "production fonts",
      (fontLoad) => ({
        ready:
          document.fonts.status === "loaded" &&
          document.fonts.check('12px "Geist Variable"'),
        status: document.fonts.status,
        check: document.fonts.check('12px "Geist Variable"'),
        bodyFamily: getComputedStyle(document.body).fontFamily,
        fontLoad,
        faces: [...document.fonts].map((face) => ({
          family: face.family,
          status: face.status,
          weight: face.weight,
          style: face.style,
          unicodeRange: face.unicodeRange,
        })),
        fontFaceRules: (() => {
          const rules = [];
          const visit = (list, href) => {
            for (const rule of list) {
              if (rule.type === CSSRule.FONT_FACE_RULE)
                rules.push({
                  stylesheet: href,
                  family: rule.style.getPropertyValue("font-family"),
                  src: rule.style.getPropertyValue("src"),
                  unicodeRange: rule.style.getPropertyValue("unicode-range"),
                });
              if (rule.cssRules) visit(rule.cssRules, href);
            }
          };
          for (const sheet of document.styleSheets) {
            try {
              visit(sheet.cssRules, sheet.href);
            } catch (error) {
              rules.push({ stylesheet: sheet.href, error: String(error) });
            }
          }
          return rules;
        })(),
        resources: performance
          .getEntriesByType("resource")
          .filter((entry) => /\.(woff2?|ttf|otf)(?:\?|$)/i.test(entry.name))
          .map((entry) => ({
            path: new URL(entry.name).pathname,
            duration: entry.duration,
            transferSize: entry.transferSize,
            responseStatus: entry.responseStatus,
          })),
      }),
      fontLoad,
    );
    await waitFor(page, "finite page animations settled", () => {
      const active = document.getAnimations().filter((animation) => {
        const timing = animation.effect?.getComputedTiming();
        return (
          timing &&
          Number.isFinite(timing.endTime) &&
          (animation.pending ||
            animation.playState === "running" ||
            animation.playState === "paused")
        );
      });
      return {
        ready: active.length === 0,
        active: active.map((animation) => ({
          name:
            animation.animationName ??
            animation.transitionProperty ??
            animation.id,
          state: animation.playState,
          pending: animation.pending,
          currentTime: animation.currentTime,
          endTime: animation.effect.getComputedTiming().endTime,
          target: animation.effect.target?.tagName,
        })),
      };
    });
    if (page.fixtureErrors.length)
      throw fixtureError(page.fixtureErrors.join("; "));
    return page;
  } catch (error) {
    if (page) await page.close();
    else await context.close();
    throw error;
  }
}
