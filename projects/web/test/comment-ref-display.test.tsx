import { waitFor } from "@testing-library/react";
import type {
  IssueListItem,
  MePrefs,
  Project,
  ReferenceConfig,
  ReferenceDirectory,
  TimelineComment,
} from "@todou/shared";
import { describe, expect, it } from "vitest";
import {
  commentLocationQuery,
  commentRefQuery,
  issueRefQuery,
  type LocatedComment,
  type ResolvedCommentRef,
  type ResolvedIssueRef,
} from "../src/api/issue-refs.ts";
import { prefsQuery } from "../src/api/prefs.ts";
import { projectsQuery } from "../src/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import {
  RICH_CHIP_LABEL,
  RICH_CHIP_STRUCTURE,
  RICH_CHIP_TITLE_CAP,
} from "../src/components/shared/rich-chip.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const TITLE =
  "A long issue title that should be capped without cutting the comment identity";
const author = {
  id: 1,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};
const issue: IssueListItem = {
  id: 7,
  number: 7,
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
};
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

function seeded(
  prefs: Partial<MePrefs> = {},
  {
    slug = "todou",
    prefix = "T",
    displayName = "Alice",
  }: {
    slug?: string;
    prefix?: string | null;
    displayName?: string;
  } = {},
) {
  const client = testQueryClient();
  const cache = client.getQueryCache();
  // Build with the production options, including their real staleTime. A
  // key-only query with stale data can exercise the fallback instead of success.
  cache.build<MePrefs, Error, MePrefs, string[]>(client, {
    ...prefsQuery,
    initialData: { ...PREFS, ...prefs },
  });
  const readableSlugs = slug === "todou" ? ["todou"] : ["todou", slug];
  cache.build<Project[], Error, Project[], string[]>(client, {
    ...projectsQuery,
    initialData: readableSlugs.map((home, index) => ({
      id: index + 1,
      slug: home,
      name: home,
      description: "",
      created_at: "2026-08-12T00:00:00Z",
    })),
  });
  // The grammar enables bare comment tokens only when the viewer's reference
  // directory is available. Null models an unavailable directory, leaving the
  // token as plain text before CommentLink can consume the seeded location.
  cache.build<
    ReferenceDirectory | null,
    Error,
    ReferenceDirectory | null,
    string[]
  >(client, {
    ...referenceDirectoryQuery,
    initialData: { entries: [], contested: [] },
  });
  for (const home of readableSlugs) {
    cache.build<ReferenceConfig, Error, ReferenceConfig, string[]>(client, {
      ...referenceConfigQuery(home),
      initialData: {
        format: { prefix: home === slug ? prefix : "T", history: [] },
        autolinks: [],
      },
    });
  }
  cache.build<ResolvedIssueRef | null>(client, {
    ...issueRefQuery(slug, 7),
    initialData: issue,
  });
  for (const id of [42, 43]) {
    const comment: TimelineComment = {
      type: "comment",
      id,
      author: { ...author, display_name: displayName },
      body: "Comment body",
      created_at: "2026-08-12T00:00:00Z",
      component: null,
      edited_at: null,
      resolved_at: null,
      hidden_at: null,
      agent_context: null,
    };
    cache.build<ResolvedCommentRef | null>(client, {
      ...commentRefQuery(slug, 7, id),
      initialData: { ...comment, at: { slug, number: 7, commentId: id } },
    });
    cache.build<LocatedComment | null>(client, {
      ...commentLocationQuery("todou", id),
      initialData: {
        slug,
        issue_number: 7,
        issue_ref: `${slug}#7`,
        comment,
      },
    });
  }
  return client;
}

const sources = ["stored", "preview bare"] as const;
type Source = (typeof sources)[number];
const commentSource = (source: Source, id = 42, slug = "todou") =>
  source === "stored"
    ? `[written comment](/projects/${slug}/issues/7#comment-${id})`
    : `#comment-${id}`;
const issueSource = "[written issue](/projects/todou/issues/7)";
const contexts = [
  { context: "current", issueNumber: 7 },
  { context: "noncurrent", issueNumber: 8 },
  { context: "no current context", issueNumber: undefined },
] as const;
const preferences = [false, true].flatMap((show_repeated_ref_title) =>
  (["before", "after"] as const).flatMap((ref_placement_reference) =>
    [false, true].map((truncate_ref_title) => ({
      show_repeated_ref_title,
      ref_placement_reference,
      truncate_ref_title,
    })),
  ),
);

const richLinks = (root: ParentNode, count: number) =>
  waitFor(() => {
    const links = [
      ...root.querySelectorAll<HTMLAnchorElement>("a[data-issue-link='7']"),
    ];
    expect(links).toHaveLength(count);
    return links;
  });

function expectTitle(link: HTMLAnchorElement, shown: boolean, capped: boolean) {
  const comment = link.hasAttribute("data-comment-link");
  const title = link.querySelector(
    comment ? "[data-comment-title]" : ".truncate",
  );
  if (!shown) {
    expect(title).toBeNull();
    expect(link.textContent).not.toContain(TITLE);
    return;
  }
  expect(title?.textContent).toBe(TITLE);
  if (comment) {
    expect(title?.classList.contains("comment-reference-title")).toBe(true);
  } else {
    for (const name of RICH_CHIP_LABEL.split(" ")) {
      expect(title?.classList.contains(name)).toBe(true);
    }
  }
  expect(title?.classList.contains(RICH_CHIP_TITLE_CAP)).toBe(capped);
}

function expectComment(
  link: HTMLAnchorElement,
  {
    current = false,
    token = current ? "#comment-42" : "T-7#comment-42",
    id = 42,
    slug = "todou",
    name = "Alice",
    title = false,
    placement = "before",
    capped = true,
  }: {
    current?: boolean;
    token?: string;
    id?: number;
    slug?: string;
    name?: string;
    title?: boolean;
    placement?: "before" | "after";
    capped?: boolean;
  } = {},
) {
  expect(link.getAttribute("data-comment-link")).toBe(String(id));
  expect(link.getAttribute("href")).toBe(
    `/projects/${slug}/issues/7#comment-${id}`,
  );
  expect(link.querySelectorAll("[data-comment-ref]")).toHaveLength(1);
  const identity = link.querySelector("[data-comment-ref]");
  const body = link.querySelector(".comment-reference-body");
  expect(link.classList.contains("comment-link-body")).toBe(true);
  expect(link.classList.contains("inline-flex")).toBe(false);
  expect(body).not.toBeNull();
  expect(identity?.parentElement).toBe(body);
  const parts = [...link.querySelectorAll("[data-ref-part]")];
  expect(parts.length).toBeGreaterThan(0);
  expect(parts.map((part) => part.textContent).join("")).toBe(token);
  for (const part of parts) {
    expect(part.closest("[data-comment-ref]")).toBe(identity);
    expect(part.querySelector("[data-ref-part]")).toBeNull();
    expect(
      part.closest(
        "[data-comment-title], [data-comment-decoration], [data-comment-author]",
      ),
    ).toBeNull();
  }
  for (const node of [identity, ...parts]) {
    for (let element = node; element; element = element.parentElement) {
      expect(element.hasAttribute("hidden")).toBe(false);
      expect(element.getAttribute("aria-hidden")).not.toBe("true");
      expect(getComputedStyle(element).display).not.toBe("none");
      expect(getComputedStyle(element).visibility).not.toBe("hidden");
      for (const name of [
        "hidden",
        "invisible",
        "sr-only",
        "truncate",
        RICH_CHIP_TITLE_CAP,
      ]) {
        expect(element.classList.contains(name)).toBe(false);
      }
    }
  }
  expect(link.querySelectorAll("[data-comment-author]")).toHaveLength(1);
  const by = link.querySelector("[data-comment-author]");
  expect(by?.parentElement).toBe(body);
  expect(identity?.contains(by)).toBe(false);
  expect(by?.textContent).toBe(` by ${name}`);
  expect(by?.classList.contains("truncate")).toBe(false);
  expect(by?.classList.contains(RICH_CHIP_TITLE_CAP)).toBe(false);
  expect(by?.querySelector("[data-ref-part]")).toBeNull();
  const suffix = `#comment-${id}`;
  const issueRef = token.slice(0, -suffix.length);
  const label = title
    ? placement === "before"
      ? `${issueRef} ${TITLE} · ${suffix}`
      : `${TITLE} · ${token}`
    : token;
  const titleNode = link.querySelector("[data-comment-title]");
  const decorations = [...link.querySelectorAll("[data-comment-decoration]")];
  expect(decorations.map((node) => node.textContent).join("")).toBe(
    title ? (placement === "before" ? "  · " : " · ") : "",
  );
  for (const decoration of decorations) {
    expect(decoration.querySelector("[data-ref-part]")).toBeNull();
    expect(decoration.closest("[data-comment-ref]")).toBe(identity);
  }
  if (title) {
    expect(titleNode?.querySelector("[data-ref-part]")).toBeNull();
    expect(titleNode?.closest("[data-comment-ref]")).toBe(identity);
  }
  expect(identity?.textContent).toBe(label);
  const undecorated = identity?.cloneNode(true) as Element;
  for (const decoration of undecorated.querySelectorAll(
    "[data-comment-title], [data-comment-decoration]",
  )) {
    decoration.remove();
  }
  expect(undecorated.textContent).toBe(token);
  expect(link.textContent).toBe(`${label} by ${name}`);
  expect(link.textContent).not.toContain("current");
  if (current) {
    expect(titleNode).toBeNull();
    expect(issueRef).toBe("");
  }
  expect(link.querySelectorAll("svg")).toHaveLength(1);
  expect(link.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  expectTitle(link, title, capped);
}

describe.each(sources)("%s comment display through MarkdownView", (source) => {
  it.each([
    {
      placement: "before",
      current: false,
      repeated: false,
      expected: `T-7 ${TITLE} · #comment-42 by Alice`,
    },
    {
      placement: "after",
      current: false,
      repeated: false,
      expected: `${TITLE} · T-7#comment-42 by Alice`,
    },
    {
      placement: "before",
      current: false,
      repeated: true,
      expected: "T-7#comment-42 by Alice",
    },
    {
      placement: "after",
      current: false,
      repeated: true,
      expected: "T-7#comment-42 by Alice",
    },
    {
      placement: "before",
      current: true,
      repeated: false,
      expected: "#comment-42 by Alice",
    },
    {
      placement: "after",
      current: true,
      repeated: false,
      expected: "#comment-42 by Alice",
    },
    {
      placement: "before",
      current: true,
      repeated: true,
      expected: "#comment-42 by Alice",
    },
    {
      placement: "after",
      current: true,
      repeated: true,
      expected: "#comment-42 by Alice",
    },
  ] as const)(
    "exact display: $placement, current=$current, repeated=$repeated",
    async ({ placement, current, repeated, expected }) => {
      const written = commentSource(source);
      const view = renderWithProviders(
        <MarkdownView
          slug="todou"
          issueNumber={current ? 7 : 8}
          preview={source === "preview bare"}
        >
          {repeated ? `${written} then ${written}` : written}
        </MarkdownView>,
        seeded({ ref_placement_reference: placement }),
      );
      const links = await richLinks(view.container, repeated ? 2 : 1);
      const link = links[repeated ? 1 : 0]!;
      expect(link.textContent).toBe(expected);
      expectComment(link, {
        current,
        title: !current && !repeated,
        placement,
      });
    },
  );

  for (const { context, issueNumber } of contexts) {
    it.each(preferences)(
      `${context}: repeated titles=$show_repeated_ref_title, placement=$ref_placement_reference, truncate=$truncate_ref_title`,
      async (prefs) => {
        const client = seeded(prefs);
        // A bare preview must use the fresh location response as initialComment;
        // it must not accidentally pass thanks to the stored-link cache entry.
        if (source === "preview bare") {
          client.removeQueries({
            queryKey: commentRefQuery("todou", 7, 42).queryKey,
          });
        }
        const written = commentSource(source);
        const view = renderWithProviders(
          <>
            <MarkdownView
              slug="todou"
              issueNumber={issueNumber}
              preview={source === "preview bare"}
            >
              {`${written} then ${written}`}
            </MarkdownView>
            {source === "stored" && (
              <MarkdownView slug="todou" issueNumber={issueNumber}>
                {`${issueSource} then ${issueSource}`}
              </MarkdownView>
            )}
          </>,
          client,
        );
        const links = await richLinks(
          view.container,
          source === "stored" ? 4 : 2,
        );
        for (const [index, link] of links.slice(0, 2).entries()) {
          expectComment(link, {
            current: context === "current",
            title:
              context !== "current" &&
              (index === 0 || prefs.show_repeated_ref_title),
            placement: prefs.ref_placement_reference,
            capped: prefs.truncate_ref_title,
          });
        }
        // Ordinary issue references remain the negative control for the same
        // preferences: current/repeat suppression must not become comment-only.
        for (const [index, link] of links.slice(2).entries()) {
          const current =
            context === "current" && !prefs.show_repeated_ref_title;
          const title =
            !current && (index === 0 || prefs.show_repeated_ref_title);
          const labels = current
            ? ["current"]
            : title
              ? prefs.ref_placement_reference === "before"
                ? ["T-7", TITLE]
                : [TITLE, "T-7"]
              : ["T-7"];
          expect(link.getAttribute("href")).toBe("/projects/todou/issues/7");
          expect(link.hasAttribute("data-comment-link")).toBe(false);
          expect(
            link.querySelector(
              "[data-comment-ref], [data-ref-part], [data-comment-title], [data-comment-decoration], [data-comment-author]",
            ),
          ).toBeNull();
          expect(link.classList.contains("comment-link-body")).toBe(false);
          expect(link.querySelector(".comment-reference-body")).toBeNull();
          for (const name of RICH_CHIP_STRUCTURE.split(" ")) {
            expect(link.classList.contains(name)).toBe(true);
          }
          expect([...link.children].map((child) => child.textContent)).toEqual([
            "",
            ...labels,
          ]);
          expect(link.textContent).toBe(labels.join(""));
          expect(link.querySelectorAll("svg")).toHaveLength(1);
          expect(
            link.querySelector("svg")?.classList.contains("lucide-circle-dot"),
          ).toBe(true);
          expect(link.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
            "true",
          );
          expect(link.getAttribute("title")).toBe(
            prefs.ref_placement_reference === "before"
              ? `T-7 ${TITLE} (Todo)`
              : `${TITLE} T-7 (Todo)`,
          );
          expectTitle(link, title, prefs.truncate_ref_title);
        }
      },
    );
  }

  it("keeps two comments by the same author distinct", async () => {
    const view = renderWithProviders(
      <MarkdownView
        slug="todou"
        issueNumber={7}
        preview={source === "preview bare"}
      >
        {`${commentSource(source, 42)} then ${commentSource(source, 43)}`}
      </MarkdownView>,
      seeded({ show_repeated_ref_title: true }),
    );
    const links = await richLinks(view.container, 2);
    for (const [index, id] of [42, 43].entries()) {
      expectComment(links[index]!, {
        current: true,
        id,
        token: `#comment-${id}`,
      });
    }
    expect(links[0]?.textContent).not.toBe(links[1]?.textContent);
    expect(links[0]?.getAttribute("href")).not.toBe(
      links[1]?.getAttribute("href"),
    );
  });

  it.each([
    { prefix: "M", token: "mirror/M-7#comment-42" },
    { prefix: null, token: "mirror#7#comment-42" },
  ])(
    "qualifies a foreign comment with prefix=$prefix",
    async ({ prefix, token }) => {
      const view = renderWithProviders(
        <MarkdownView
          slug="todou"
          issueNumber={7}
          preview={source === "preview bare"}
        >
          {commentSource(source, 42, "mirror")}
        </MarkdownView>,
        seeded({}, { slug: "mirror", prefix }),
      );
      const [link] = await richLinks(view.container, 1);
      expectComment(link!, { token, slug: "mirror", title: true });
      expect(link?.getAttribute("data-issue-project")).toBe("mirror");
    },
  );

  it.each([
    { displayName: "  Alice  ", name: "Alice" },
    { displayName: "", name: "alice" },
    { displayName: "   ", name: "alice" },
  ])("uses displayNameOf for '$displayName'", async ({ displayName, name }) => {
    const view = renderWithProviders(
      <MarkdownView
        slug="todou"
        issueNumber={7}
        preview={source === "preview bare"}
      >
        {commentSource(source)}
      </MarkdownView>,
      seeded({}, { displayName }),
    );
    const [link] = await richLinks(view.container, 1);
    expectComment(link!, { current: true, name });
  });
});

describe("comment reference source boundaries", () => {
  it("leaves an unresolved bare token in stored Markdown as text", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="todou">
        {`#comment-42 then ${commentSource("stored")}`}
      </MarkdownView>,
      seeded(),
    );
    const [link] = await richLinks(view.container, 1);
    expectComment(link!, { title: true });
    expect(view.container.querySelectorAll("a")).toHaveLength(1);
    expect(view.container.querySelector("p")?.firstChild?.textContent).toBe(
      "#comment-42 then ",
    );
  });

  it("does not tokenize inline code or an external link label, or count them as a first mention", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="todou" preview>
        {"`#comment-42` then " +
          "[#comment-42](https://example.com/note) then #comment-42 then #comment-42"}
      </MarkdownView>,
      seeded(),
    );
    const links = await richLinks(view.container, 2);
    expectComment(links[0]!, { title: true });
    expectComment(links[1]!);
    expect(view.container.querySelector("code")?.textContent).toBe(
      "#comment-42",
    );
    expect(view.container.querySelector("code a")).toBeNull();
    const external = view.container.querySelector(
      "a[href='https://example.com/note']",
    );
    expect(external?.textContent).toBe("#comment-42");
    expect(external?.querySelector("[data-comment-ref]")).toBeNull();
    expect(view.container.querySelectorAll("a")).toHaveLength(3);
  });

  it("takes a stored comment's identity from its href, not its formatted label", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="todou" issueNumber={7}>
        {"[**T-99#comment-999**](/projects/todou/issues/7#comment-42)"}
      </MarkdownView>,
      seeded(),
    );
    const [link] = await richLinks(view.container, 1);
    expectComment(link!, { current: true });
    expect(view.container.querySelector("strong")).toBeNull();
    expect(view.container.textContent).not.toContain("999");
  });
});
