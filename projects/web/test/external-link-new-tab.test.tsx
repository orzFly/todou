import { cleanup, waitFor } from "@testing-library/react";
import type { IssueListItem, MePrefs, ReferenceConfig } from "@todou/shared";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueRefQuery } from "../src/api/issue-refs.ts";
import { prefsQuery } from "../src/api/prefs.ts";
import { referenceConfigQuery } from "../src/api/references.ts";
import { isExternalHref } from "../src/components/shared/body-anchor.tsx";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { AnnotatedMarkdown } from "../src/components/spec/annotated-markdown.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

vi.mock("@pierre/diffs/react", () => ({
  CodeView: () => null,
  MultiFileDiff: () => null,
}));

afterEach(cleanup);

const PREFS: MePrefs = {
  show_weak_unread: true,
  ref_placement_list: "before",
  ref_placement_board: "own_line",
  ref_placement_detail: "before",
  ref_placement_reference: "before",
  boxed_ref_links: true,
  truncate_ref_title: true,
  show_repeated_ref_title: false,
  open_external_links_in_new_tab: false,
  project_icon_fallback: "colorful_text",
  user_avatar_fallback: "monochrome_text",
};

const config: ReferenceConfig = {
  format: { prefix: "T", history: [] },
  autolinks: [
    { id: 1, prefix: "JIRA-", url_template: "https://jira.example/<num>" },
  ],
};

const card: IssueListItem = {
  id: 7,
  number: 7,
  title: "Target card",
  status: {
    id: 1,
    name: "Todo",
    category: "open",
    color: "#888888",
    position: 1,
    is_default: true,
  },
  author: {
    id: 1,
    login: "user",
    display_name: "User",
    kind: "human",
    avatar_url: null,
    owner: null,
  },
  assignees: [],
  labels: [],
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
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
};

const origin = window.location.origin;

/** Links that leave todou, each a different way of writing one. */
const EXTERNAL = [
  "https://github.com/o/r/pull/1",
  "https://jira.example/5",
  "https://ci.example/run",
  "http://plain.example/",
];

/**
 * One of every kind of link a body can carry. The image link is an external
 * link too; the stored issue reference, the attachment and the same-origin
 * URL are todou's own, and the rest are not pages at all.
 */
const BODY = [
  "[a pull request](https://github.com/o/r/pull/1)",
  "JIRA-5",
  "[![badge](https://img.example/b.png)](https://ci.example/run)",
  "<http://plain.example/>",
  "[T-7](/projects/todou/issues/7)",
  `[settings](${origin}/projects/todou/settings)`,
  "[board](/projects/todou/board)",
  "[notes](/api/projects/todou/attachments/9/download/notes.txt)",
  "[top](#top)",
  "[mail](mailto:noreply@example.com)",
].join("\n\n");

function seeded(open_external_links_in_new_tab: boolean) {
  const client = testQueryClient();
  client.setQueryData(prefsQuery.queryKey, {
    ...PREFS,
    open_external_links_in_new_tab,
  });
  client.setQueryData(referenceConfigQuery("todou").queryKey, config);
  client.setQueryData(issueRefQuery("todou", 7).queryKey, card);
  return client;
}

const RENDERERS: ReadonlyArray<{
  name: string;
  ui: () => ReactElement;
  /** Whether issue references and autolinks resolve here: a project's own. */
  refs: boolean;
}> = [
  {
    // An issue body, a comment, a questions card and a document card.
    name: "markdown on an issue",
    ui: () => (
      <MarkdownView slug="todou" issueNumber={1}>
        {BODY}
      </MarkdownView>
    ),
    refs: true,
  },
  {
    // The issue, comment and spec-annotation hover cards.
    name: "markdown in a hover card",
    ui: () => <MarkdownView slug="todou">{BODY}</MarkdownView>,
    refs: true,
  },
  {
    name: "markdown outside a project",
    ui: () => <MarkdownView>{BODY}</MarkdownView>,
    refs: false,
  },
  {
    name: "a spec document",
    ui: () => (
      <AnnotatedMarkdown
        slug="todou"
        issueNumber={1}
        body={BODY}
        annotations={[]}
        onStage={() => {}}
        onEditDraft={() => {}}
        onRemoveDraft={() => {}}
        onResolve={() => {}}
      />
    ),
    refs: true,
  },
];

async function anchors(ui: ReactElement, newTab: boolean, refs: boolean) {
  const view = renderWithProviders(ui, seeded(newTab));
  return waitFor(() => {
    const all = [...view.container.querySelectorAll("a")];
    // Wait for the slowest link to settle: the card behind the stored ref,
    // and the autolink, which needs the project's reference config.
    if (refs) {
      expect(
        view.container.querySelector("a[data-issue-link='7']"),
      ).not.toBeNull();
    }
    expect(
      all.some((a) => a.getAttribute("href") === "https://jira.example/5"),
    ).toBe(refs);
    expect(all.length).toBeGreaterThanOrEqual(refs ? 10 : 9);
    return all;
  });
}

describe("open external links in a new tab (T-552)", () => {
  for (const { name, ui, refs } of RENDERERS) {
    it(`${name}: off leaves every link in this tab`, async () => {
      const all = await anchors(ui(), false, refs);
      for (const a of all) {
        expect(a.getAttribute("target"), a.href).toBeNull();
        expect(a.getAttribute("rel"), a.href).toBeNull();
      }
    });

    it(`${name}: on opens only the external links in a new tab`, async () => {
      const all = await anchors(ui(), true, refs);
      const opened = all
        .filter((a) => a.getAttribute("target") === "_blank")
        .map((a) => a.getAttribute("href"));
      const expected = EXTERNAL.filter(
        (href) => refs || href !== "https://jira.example/5",
      );
      expect(opened.sort()).toEqual(expected.sort());
      for (const a of all) {
        if (a.getAttribute("target") === "_blank") {
          expect(a.getAttribute("rel"), a.href).toBe("noopener noreferrer");
        } else {
          expect(a.getAttribute("target"), a.href).toBeNull();
          expect(a.getAttribute("rel"), a.href).toBeNull();
        }
      }
    });
  }
});

describe("isExternalHref", () => {
  it.each([
    ["https://github.com/o/r", true],
    ["HTTP://Other.Example/x", true],
    ["//protocol-relative.example/x", true],
    [`${origin}/projects/todou/issues/7`, false],
    ["/projects/todou/board", false],
    ["notes.md", false],
    ["#top", false],
    ["?q=1", false],
    ["mailto:noreply@example.com", false],
    ["javascript:alert(1)", false],
    [undefined, false],
  ])("%s → %s", (href, expected) => {
    expect(isExternalHref(href)).toBe(expected);
  });
});
