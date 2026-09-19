import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { QueryClient } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import type {
  IssueListItem,
  Member,
  MePrefs,
  Project,
  ReferenceConfig,
  TimelineEvent,
} from "@todou/shared";
import { describe, expect, it } from "vitest";
import { issueRefQuery } from "../src/api/issue-refs.ts";
import { prefsQuery } from "../src/api/prefs.ts";
import { membersQuery, projectsQuery } from "../src/api/queries.ts";
import { referenceConfigQuery } from "../src/api/references.ts";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { RICH_CHIP_SKIN } from "../src/components/shared/rich-chip.ts";
import { EventRow } from "../src/components/timeline/event-row.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";
// A module-graph edge to the sheets the second half of this file reads, so
// `vitest related src/components/shared/rich-chip.css` names this file.
import "../src/components/shared/comment-reference.css";
import "../src/components/shared/rich-chip.css";

/**
 * What a reader's own selection copies out of a rich reference (T-427).
 *
 * Two layers, and they prove different things. Everything above
 * "the sheet says so" is DOM: which characters sit in the one selectable
 * slot, and which of them are decoration sitting outside it. happy-dom lays
 * nothing out and applies no stylesheet, so it cannot see `user-select` or a
 * line fragment — that the browser honours these slots, and that an inline
 * chip does not push newlines into `text/plain`, is graded by
 * `scripts/rich-link-copy-smoke.mjs` against a real drag and a real Ctrl+C.
 */
const TITLE = "A parent card with a title nobody would want in a paste";

const author = {
  id: 1,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const refItem = (number: number): IssueListItem => ({
  id: number,
  number,
  title: TITLE,
  status: {
    id: 1,
    name: "Todo",
    category: "open",
    color: "#6b7280",
    position: 0,
    is_default: true,
  },
  author,
  assignees: [],
  labels: [],
  created_at: "2026-08-12T00:00:00Z",
  updated_at: "2026-08-12T00:00:00Z",
  body_edited_at: null,
  open_questions: 0,
  spec_version: null,
  spec_review_status: null,
  spec_unresolved_comments: 0,
  deleted_at: null,
  deleted_by: null,
  unread: false,
  unread_comments: 0,
  muted: null,
  blocked_by: [],
  blocks: [],
  moves: [],
});

const members: Member[] = [
  {
    user: {
      id: 7,
      login: "alicia",
      display_name: "Alicia Recent",
      kind: "human",
      avatar_url: null,
      owner: null,
    },
    role: "writer",
    created_at: "2026-01-01T00:00:00Z",
    owner_role: null,
  },
];

const PREFS: MePrefs = {
  show_weak_unread: true,
  ref_placement_list: "before",
  ref_placement_board: "own_line",
  ref_placement_detail: "before",
  ref_placement_reference: "before",
  boxed_ref_links: true,
  truncate_ref_title: true,
  show_repeated_ref_title: false,
};

function seeded(overrides: Partial<MePrefs> = {}): QueryClient {
  const client = testQueryClient();
  client.setQueryData(prefsQuery.queryKey, { ...PREFS, ...overrides });
  client.setQueryData(membersQuery("todou").queryKey, members);
  client.setQueryData<Project[]>(
    projectsQuery.queryKey,
    ["todou", "mirror"].map((slug, index) => ({
      id: index + 1,
      slug,
      name: slug,
      description: "",
      created_at: "2026-08-12T00:00:00Z",
    })),
  );
  for (const [slug, prefix] of [
    ["todou", "T"],
    ["mirror", "M"],
  ] as const) {
    client.setQueryData<ReferenceConfig>(referenceConfigQuery(slug).queryKey, {
      format: { prefix, history: [] },
      autolinks: [],
    });
    client.setQueryData(issueRefQuery(slug, 7).queryKey, refItem(7));
  }
  return client;
}

const linkTo = (root: ParentNode, selector = "a[data-issue-link='7']") =>
  waitFor(() => {
    const el = root.querySelector<HTMLAnchorElement>(selector);
    expect(el).not.toBeNull();
    return el as HTMLAnchorElement;
  });

/**
 * The characters a natural selection over this chip has to produce: the text
 * of the selectable slots in DOM order, with every decoration excluded by
 * sitting outside them rather than by being filtered here.
 */
function copyable(link: Element, attribute: string): string {
  const slots = [...link.querySelectorAll(`[${attribute}]`)];
  for (const slot of slots) {
    expect(slot.querySelector(`[${attribute}]`)).toBeNull();
    for (const inside of [slot, ...slot.querySelectorAll("*")]) {
      expect(
        inside.matches(
          "[data-ref-decoration], [data-ref-note], [data-mention-decoration], .ref-chip-title",
        ),
      ).toBe(false);
    }
  }
  return slots.map((slot) => slot.textContent).join("");
}

describe("an ordinary reference copies its canonical ref (T-427)", () => {
  it.each([
    { placement: "before", shown: `T-7 ${TITLE}` },
    { placement: "after", shown: `${TITLE} T-7` },
  ] as const)(
    "puts the ref in one slot and the title outside it, $placement",
    async ({ placement, shown }) => {
      const view = renderWithProviders(
        <MarkdownView slug="todou">
          {"see [T-7](/projects/todou/issues/7)"}
        </MarkdownView>,
        seeded({ ref_placement_reference: placement }),
      );
      const link = await linkTo(view.container);
      expect(link.textContent).toBe(shown);
      expect(copyable(link, "data-ref-token")).toBe("T-7");
      // The separator is a real character, so a long title has somewhere to
      // wrap — and it is a decoration, so it is not part of the identity.
      expect(
        [...link.querySelectorAll("[data-ref-decoration]")].map(
          (node) => node.textContent,
        ),
      ).toEqual([" "]);
    },
  );

  it("qualifies a foreign card without letting a space into the slot", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="todou">
        {"see [M-7](/projects/mirror/issues/7)"}
      </MarkdownView>,
      seeded(),
    );
    const link = await linkTo(view.container);
    expect(copyable(link, "data-ref-token")).toBe("mirror/M-7");
    expect(copyable(link, "data-ref-token")).not.toMatch(/\s/);
  });

  it.each([false, true])(
    "keeps the note for the current card out of the slot, truncate=%s",
    async (truncate_ref_title) => {
      const view = renderWithProviders(
        <MarkdownView slug="todou" issueNumber={7}>
          {
            "see [T-7](/projects/todou/issues/7) and [T-7](/projects/todou/issues/7)"
          }
        </MarkdownView>,
        seeded({ truncate_ref_title }),
      );
      await waitFor(() => {
        expect(
          view.container.querySelectorAll("a[data-issue-link='7']"),
        ).toHaveLength(2);
      });
      const links = [
        ...view.container.querySelectorAll<HTMLAnchorElement>(
          "a[data-issue-link='7']",
        ),
      ];
      expect(links.map((link) => link.textContent)).toEqual([
        "T-7 (current)",
        "T-7",
      ]);
      for (const link of links) {
        expect(copyable(link, "data-ref-token")).toBe("T-7");
      }
      expect(links[0]?.querySelector("[data-ref-note]")?.textContent).toBe(
        "(current)",
      );
      expect(links[1]?.querySelector("[data-ref-note]")).toBeNull();
    },
  );

  it("leaves the status glyph and the chip's own box out of the slot", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="todou">
        {"see [T-7](/projects/todou/issues/7)"}
      </MarkdownView>,
      seeded(),
    );
    const link = await linkTo(view.container);
    expect(link.querySelector("[data-ref-token] svg")).toBeNull();
    expect(link.querySelector("svg")?.getAttribute("class")).toContain(
      "ref-chip-icon",
    );
    // A flex box lays each child on its own line fragment, and the clipboard
    // serialises those fragments as newlines even where the DOM spells none.
    for (const element of [link, ...link.querySelectorAll("*")]) {
      const classes = (element.getAttribute("class") ?? "").split(" ");
      for (const banned of ["flex", "inline-flex", "grid", "inline-grid"]) {
        expect(classes).not.toContain(banned);
      }
    }
  });
});

describe("a mention copies its current login (T-427)", () => {
  it("holds @login in the slot and the avatar outside it", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="todou">{"see [@alice](/users/7)"}</MarkdownView>,
      seeded(),
    );
    const link = await linkTo(view.container, "a[data-mention-link='7']");
    expect(copyable(link, "data-mention-token")).toBe("@alicia");
    expect(link.classList.contains("mention-chip-body")).toBe(true);
    const decoration = link.querySelector("[data-mention-decoration]");
    expect(decoration?.querySelector("[data-mention-token]")).toBeNull();
    // The avatar's fallback is the reader's initials as real text; it has to
    // be inside the part the sheet makes unselectable.
    expect(decoration?.textContent).toBe("AR");
    expect(link.textContent).toBe("AR@alicia");
  });
});

describe("the slots stop at the markdown body (T-427)", () => {
  const event: TimelineEvent = {
    type: "event",
    id: 1,
    event_type: "referenced",
    actor: author,
    agent_context: null,
    payload: { by_issue: 7 },
    created_at: "2026-08-12T00:00:00Z",
  };

  it("leaves a timeline event row an ordinary anchor", async () => {
    const view = renderWithProviders(
      <EventRow event={event} slug="todou" />,
      seeded(),
    );
    const link = await linkTo(view.container);
    expect(link.className).toBe("font-medium hover:underline");
    expect(
      link.querySelector(
        "[data-ref-token], [data-ref-decoration], [data-ref-note]",
      ),
    ).toBeNull();
    expect(link.textContent).toBe(`T-7 ${TITLE}`);
  });
});

/**
 * The sheet is what actually hands the browser these slots, and no test that
 * runs under happy-dom can watch it do so. Read as text it still answers one
 * question a class name cannot: whether the rule is still written down.
 */
describe("the sheet says which parts are selectable (T-427)", () => {
  // Anchored on the package directory vitest runs from: under this setup
  // `import.meta.url` is not a `file:` URL, so the path helpers reject it.
  const css = readFileSync(
    resolve(process.cwd(), "src/components/shared/rich-chip.css"),
    "utf8",
  );
  // Comments go first, whole-file: a comma inside one otherwise splits into
  // selectors of its own and the rule after it is filed under prose.
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = new Map<string, string>();
  for (const [, selector, body] of rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const one of (selector ?? "").split(",")) {
      const key = one.trim();
      if (key !== "") blocks.set(key, (blocks.get(key) ?? "") + (body ?? ""));
    }
  }
  const declares = (selector: string, property: string, value: string) => {
    const body = blocks.get(selector);
    expect(body, `no rule for ${selector}`).toBeDefined();
    expect(body).toMatch(
      new RegExp(`(^|[;{\\s])${property}:\\s*${value}\\s*;`),
    );
  };

  it.each([
    ".ref-chip-body [data-ref-token]",
    ".mention-chip-body [data-mention-token]",
  ])("makes %s an atom the browser selects whole", (selector) => {
    declares(selector, "user-select", "all");
    declares(selector, "-webkit-user-select", "all");
  });

  it.each([
    ".ref-chip-body .ref-chip-icon",
    ".ref-chip-body [data-ref-decoration]",
    ".ref-chip-body [data-ref-note]",
    ".ref-chip-body .ref-chip-title",
    ".mention-chip-body [data-mention-decoration]",
  ])("keeps %s out of a selection on its own terms", (selector) => {
    // Written on the node, not inherited from a root `none`: engines differ
    // on whether `user-select` reaches a child of an `all` ancestor.
    declares(selector, "user-select", "none");
    declares(selector, "-webkit-user-select", "none");
  });

  it("lays the chip out inline, with no flex anywhere in the sheet", () => {
    declares(".ref-chip-body", "display", "inline");
    expect(rules).not.toMatch(/display:\s*(inline-)?flex/);
  });

  // The title's max-width gives back exactly what the border adds, and the
  // two live in different files. Change the skin's padding on its own and
  // this is what says so, instead of 6px of overhang at 390px.
  it("gives the title back what the skin's own box costs it", () => {
    expect(RICH_CHIP_SKIN).toContain("px-[0.3em]");
    expect(RICH_CHIP_SKIN.split(" ")).toContain("border");
    declares(
      ".ref-chip-body.border",
      "--ref-chip-inset",
      "calc\\(0.6em \\+ 2px\\)",
    );
    declares(".ref-chip-body", "--ref-chip-inset", "0px");
    expect(blocks.get(".ref-chip-body .ref-chip-title")).toContain(
      "calc(100% - var(--ref-chip-inset))",
    );
  });

  // A leading of the chip's own drops the title below the prose, because
  // `overflow: hidden` makes its bottom edge the baseline and
  // `vertical-align: bottom` only lands that edge on the line's baseline
  // when the box is as tall as the line box (T-460 measured 2.59px at 320,
  // 390 and 1280px). Both chips carry the rule, and a sheet that quietly
  // gets its own leading back is the shape the browser smoke grades.
  it.each([
    [".ref-chip-body", "rich-chip.css"],
    [".comment-link-body", "comment-reference.css"],
  ])("gives %s the body's own leading", (selector, file) => {
    const sheet = readFileSync(
      resolve(process.cwd(), `src/components/shared/${file}`),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    let body: string | undefined;
    for (const [, one, rule] of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if ((one ?? "").trim() === selector) body = (body ?? "") + (rule ?? "");
    }
    expect(body, `no rule for ${selector} in ${file}`).toBeDefined();
    expect(body).toMatch(/(^|[;{\s])line-height:\s*inherit\s*;/);
  });
});
