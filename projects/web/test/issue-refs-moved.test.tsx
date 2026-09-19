import { QueryClient } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import {
  type IssueListItem,
  MePrefs,
  type ReferenceConfig,
  type TimelineComment,
} from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commentLocationQuery,
  commentRefQuery,
  issueRefQuery,
  type ResolvedIssueRef,
} from "../src/api/issue-refs.ts";
import { prefsQuery } from "../src/api/prefs.ts";
import { referenceConfigQuery } from "../src/api/references.ts";
import { IssueLink } from "../src/components/shared/issue-link.tsx";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const issue = (
  number: number,
  title: string,
): IssueListItem & { body: string } => ({
  id: number,
  number,
  title,
  body: "",
  status: {
    id: 1,
    name: "Todo",
    category: "open",
    color: "#6b7280",
    position: 0,
    is_default: true,
  },
  author: {
    id: 1,
    login: "user",
    display_name: "User",
    kind: "human" as const,
    avatar_url: null,
    owner: null,
  },
  assignees: [],
  labels: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  body_edited_at: null,
  open_questions: 0,
  spec_version: null,
  spec_review_status: null,
  spec_unresolved_comments: 0,
  unread: false,
  unread_comments: 0,
  muted: null,
  blocked_by: [],
  blocks: [],
  deleted_at: null,
  deleted_by: null,
  moves: [],
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * A reference to a card that has moved (T-231).
 *
 * The list endpoint excludes tombstones, so a moved card's ref is
 * indistinguishable from a ref to a number nobody used — which is why the
 * client probes the issue route before giving up.
 */
describe("references to a moved card", () => {
  afterEach(() => vi.unstubAllGlobals());

  const client = () =>
    new QueryClient({ defaultOptions: { queries: { retry: false } } });

  it("follows the redirect and resolves at the new address", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("numbers=")) {
        return json({ items: [], next_cursor: null });
      }
      if (url.includes("/projects/a/issues/123")) {
        return json({ moved_to: { slug: "b", number: 45 } }, 301);
      }
      if (url.includes("/projects/b/issues/45")) {
        return json(issue(45, "Landed in B"));
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    const resolved = await client().fetchQuery(issueRefQuery("a", 123));
    expect(resolved?.title).toBe("Landed in B");
    // The ref keeps the number it was written with; what changed is where
    // the title came from.
    expect(resolved?.number).toBe(45);
  });

  it("stays plain text when the reader cannot follow", async () => {
    vi.stubGlobal("fetch", (async (input: unknown) => {
      const url = String(input);
      if (url.includes("numbers=")) {
        return json({ items: [], next_cursor: null });
      }
      return json({ moved: true, title: "Gone" }, 410);
    }) as typeof fetch);

    expect(await client().fetchQuery(issueRefQuery("a", 123))).toBeNull();
  });

  it("stays plain text for a number nobody ever used", async () => {
    vi.stubGlobal("fetch", (async (input: unknown) => {
      const url = String(input);
      if (url.includes("numbers=")) {
        return json({ items: [], next_cursor: null });
      }
      return json({ error: { code: "not_found", message: "no" } }, 404);
    }) as typeof fetch);

    expect(await client().fetchQuery(issueRefQuery("a", 999))).toBeNull();
  });

  it("probes the misses only, once each", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("numbers=")) {
        return json({ items: [issue(101, "Still here")], next_cursor: null });
      }
      return json({ error: { code: "not_found", message: "no" } }, 404);
    }) as typeof fetch);

    const queries = client();
    await Promise.all([
      queries.fetchQuery(issueRefQuery("a", 101)),
      queries.fetchQuery(issueRefQuery("a", 102)),
      queries.fetchQuery(issueRefQuery("a", 103)),
    ]);

    // One list request for all three; a card the list returned is never
    // probed, and each miss is probed exactly once. The probes leave in the
    // same tick, so the client's batcher folds them into one envelope
    // outside test mode (pinned in @todou/shared's client suite).
    const lists = urls.filter((u) => u.includes("numbers="));
    const probes = urls.filter((u) => !u.includes("numbers="));
    expect(lists).toHaveLength(1);
    expect(probes.sort()).toEqual([
      "/api/projects/a/issues/102",
      "/api/projects/a/issues/103",
    ]);
  });
  it("probes unreadable source lists and resolves a numeric project ref at its authorized destination", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("numbers=")) {
        return json({ error: { code: "forbidden", message: "no list" } }, 403);
      }
      if (url.includes("/projects/9/issues/123")) {
        return json({ moved_to: { slug: "harbor", number: 30 } }, 301);
      }
      if (url.includes("/projects/harbor/issues/30")) {
        return json(issue(30, "Authorized destination"));
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    const queries = client();
    const [first, second] = await Promise.all([
      queries.fetchQuery(issueRefQuery("9", 123)),
      queries.fetchQuery(issueRefQuery("9", 123)),
    ]);
    expect(first).toEqual(second);
    expect(first?.at).toEqual({ slug: "harbor", number: 30 });
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain("/projects/9/issues?");
    expect(urls[0]).toContain("numbers=123");
    expect(urls[1]).toBe("/api/projects/9/issues/123");
    expect(urls[2]).toBe("/api/projects/harbor/issues/30");
  });

  it("does not confirm a redirect whose destination is unreadable", async () => {
    vi.stubGlobal("fetch", (async (input: unknown) => {
      const url = String(input);
      if (url.includes("numbers="))
        return json({ items: [], next_cursor: null });
      if (url.includes("/projects/9/issues/123")) {
        return json({ moved_to: { slug: "private", number: 30 } }, 301);
      }
      return json({ error: { code: "forbidden", message: "no" } }, 403);
    }) as typeof fetch);
    expect(await client().fetchQuery(issueRefQuery("9", 123))).toBeNull();
  });
  it("follows a moved comment and exposes its final full address", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/projects/9/issues/123/comments/7")) {
        return json(
          { moved_to: { slug: "harbor", number: 30, comment_id: 8 } },
          301,
        );
      }
      if (url.includes("/projects/harbor/issues/30/comments/8")) {
        return json({
          type: "comment",
          id: 8,
          body: "final",
          author: issue(30, "").author,
          created_at: "2026-01-01T00:00:00Z",
          edited_at: null,
          resolved_at: null,
          hidden_at: null,
          component: null,
          agent_context: null,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);
    const queries = client();
    const [first, repeated] = await Promise.all([
      queries.fetchQuery(commentRefQuery("9", 123, 7)),
      queries.fetchQuery(commentRefQuery("9", 123, 7)),
    ]);
    expect(first).toEqual(repeated);
    expect(first?.at).toEqual({ slug: "harbor", number: 30, commentId: 8 });
    expect(first?.id).toBe(8);
    expect(urls).toEqual([
      "/api/projects/9/issues/123/comments/7",
      "/api/projects/harbor/issues/30/comments/8",
    ]);
  });

  it("does not confirm an unreadable moved comment target", async () => {
    vi.stubGlobal("fetch", (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/projects/9/issues/123/comments/7")) {
        return json(
          { moved_to: { slug: "private", number: 30, comment_id: 8 } },
          301,
        );
      }
      return json({ error: { code: "forbidden" } }, 403);
    }) as typeof fetch);
    expect(await client().fetchQuery(commentRefQuery("9", 123, 7))).toBeNull();
  });
  it("locates a moved bare comment at its final address", async () => {
    vi.stubGlobal("fetch", (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/projects/9/comments/7")) {
        return json(
          { moved_to: { slug: "harbor", number: 30, comment_id: 8 } },
          301,
        );
      }
      if (url.includes("/projects/harbor/issues/30/comments/8")) {
        return json({
          type: "comment",
          id: 8,
          body: "found",
          author: issue(30, "").author,
          created_at: "2026-01-01T00:00:00Z",
          edited_at: null,
          resolved_at: null,
          hidden_at: null,
          component: null,
          agent_context: null,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);
    const located = await client().fetchQuery(commentLocationQuery("9", 7));
    expect(located).toMatchObject({
      slug: "harbor",
      issue_number: 30,
      comment: { id: 8 },
    });
  });
});

const refConfig = (prefix: string | null): ReferenceConfig => ({
  format: { prefix, history: [] },
  autolinks: [],
});

/**
 * How a reference to a moved card reads (T-274). One card throughout: written
 * as `homelab/CH-84`, living at `harbor/HB-30` since.
 */
describe("rendering a reference to a moved card", () => {
  afterEach(() => vi.unstubAllGlobals());

  const moved = (): ResolvedIssueRef => {
    const { body: _body, ...item } = issue(30, "emoji 选择器：搜索排序");
    return { ...item, at: { slug: "harbor", number: 30 } };
  };

  /** Nothing is meant to reach the network; a miss must not hang the render. */
  const offline = () =>
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(JSON.stringify({ error: { code: "not_found" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    );

  const seeded = ({
    destination = true,
    ref = moved(),
  }: {
    destination?: boolean;
    ref?: ResolvedIssueRef;
  } = {}): QueryClient => {
    const client = testQueryClient();
    client.setQueryData(prefsQuery.queryKey, MePrefs.parse({}));
    client.setQueryData(
      referenceConfigQuery("homelab").queryKey,
      refConfig("CH"),
    );
    if (destination) {
      client.setQueryData(
        referenceConfigQuery("harbor").queryKey,
        refConfig("HB"),
      );
    }
    client.setQueryData(issueRefQuery("homelab", 84).queryKey, ref);
    return client;
  };

  const linkOf = async (
    client: QueryClient,
    pageSlug: string | undefined,
    asWritten = false,
  ): Promise<HTMLAnchorElement> => {
    offline();
    const view = renderWithProviders(
      <IssueLink
        slug="homelab"
        number={84}
        pageSlug={pageSlug}
        asWritten={asWritten}
      />,
      client,
    );
    return await waitFor(() => {
      const el = view.container.querySelector("a");
      expect(el).not.toBeNull();
      expect(el?.textContent).toContain("emoji 选择器");
      return el as HTMLAnchorElement;
    });
  };

  it.each(["before", "after"] as const)(
    "renders one final comment token after an HTTP move with ref placement %s",
    async (placement) => {
      const queries = testQueryClient();
      queries.setQueryData(
        prefsQuery.queryKey,
        MePrefs.parse({ ref_placement_reference: placement }),
      );
      queries.setQueryData(
        referenceConfigQuery("homelab").queryKey,
        refConfig("CH"),
      );
      queries.setQueryData(
        referenceConfigQuery("harbor").queryKey,
        refConfig("HB"),
      );
      const finalComment: TimelineComment = {
        type: "comment",
        id: 8,
        body: "Moved comment body",
        author: issue(30, "").author,
        created_at: "2026-01-01T00:00:00Z",
        edited_at: null,
        resolved_at: null,
        hidden_at: null,
        component: null,
        agent_context: null,
      };
      const urls: string[] = [];
      vi.stubGlobal("fetch", (async (input: unknown) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("/projects/homelab/issues?")) {
          return json({ items: [], next_cursor: null });
        }
        if (url === "/api/projects/homelab/issues/84/comments/7") {
          return json(
            { moved_to: { slug: "harbor", number: 30, comment_id: 8 } },
            301,
          );
        }
        if (url === "/api/projects/homelab/issues/84") {
          return json({ moved_to: { slug: "harbor", number: 30 } }, 301);
        }
        if (url === "/api/projects/harbor/issues/30/comments/8") {
          return json(finalComment);
        }
        if (url === "/api/projects/harbor/issues/30") {
          return json(issue(30, "Moved parent"));
        }
        return json({ error: { code: "not_found" } }, 404);
      }) as typeof fetch);

      const view = renderWithProviders(
        <MarkdownView slug="homelab" issueNumber={1}>
          {"[CH-84#comment-7](/projects/homelab/issues/84#comment-7)"}
        </MarkdownView>,
        queries,
      );
      const rich = await waitFor(() => {
        const anchor = view.container.querySelector<HTMLAnchorElement>(
          "a[data-comment-link]",
        );
        expect(anchor).not.toBeNull();
        return anchor as HTMLAnchorElement;
      });
      const tokens = rich.querySelectorAll("[data-comment-ref]");
      expect(tokens).toHaveLength(1);
      const token = tokens[0] as HTMLElement;
      // Reject using the input commentId: the HTTP alias maps 7 to 8.
      expect(token.textContent).toBe("harbor/HB-30#comment-8");
      expect(token.childNodes).toHaveLength(1);
      expect(token.firstChild?.nodeType).toBe(Node.TEXT_NODE);
      expect(
        token.closest("[hidden], [aria-hidden='true'], .sr-only"),
      ).toBeNull();
      expect(getComputedStyle(token).display).not.toBe("none");
      expect(getComputedStyle(token).visibility).not.toBe("hidden");
      expect(getComputedStyle(token).visibility).not.toBe("collapse");
      expect(rich.textContent?.match(/#comment-\d+/g)).toEqual(["#comment-8"]);
      const authors = rich.querySelectorAll("[data-comment-author]");
      expect(authors).toHaveLength(1);
      expect(authors[0]?.textContent).toBe(" · by User");
      expect(token.contains(authors[0] ?? null)).toBe(false);
      expect(rich.textContent).toContain("Moved parent");
      expect(rich.getAttribute("data-comment-link")).toBe("8");
      expect(rich.getAttribute("data-issue-link")).toBe("30");
      expect(rich.getAttribute("data-issue-project")).toBe("harbor");
      expect(rich.getAttribute("href")).toBe(
        "/projects/harbor/issues/30#comment-8",
      );
      expect(rich.hash).toBe(`#comment-${rich.dataset.commentLink}`);
      expect(view.container.textContent).not.toContain("CH-84#comment-7");
      expect(urls).toEqual(
        expect.arrayContaining([
          "/api/projects/homelab/issues/84",
          "/api/projects/homelab/issues/84/comments/7",
          "/api/projects/harbor/issues/30",
          "/api/projects/harbor/issues/30/comments/8",
        ]),
      );
      expect(
        queries.getQueryData(issueRefQuery("homelab", 84).queryKey)?.at,
      ).toEqual({ slug: "harbor", number: 30 });
      expect(
        queries.getQueryData(commentRefQuery("homelab", 84, 7).queryKey),
      ).toMatchObject({
        id: 8,
        at: { slug: "harbor", number: 30, commentId: 8 },
      });
      for (const key of [
        issueRefQuery("homelab", 84).queryKey,
        commentRefQuery("homelab", 84, 7).queryKey,
      ]) {
        expect(queries.getQueryState(key)).toMatchObject({
          status: "success",
          fetchStatus: "idle",
          isInvalidated: false,
        });
      }
    },
  );

  it("spells the card where it lives now, not where it was written", async () => {
    const link = await linkOf(seeded(), "todou");
    expect(link.textContent).toBe("harbor/HB-30 emoji 选择器：搜索排序");
    expect(link.getAttribute("href")).toBe("/projects/harbor/issues/30");
    expect(link.getAttribute("data-issue-project")).toBe("harbor");
    expect(link.getAttribute("data-issue-link")).toBe("30");
    expect(link.title).toBe("harbor/HB-30 emoji 选择器：搜索排序 (Todo)");
  });

  it("names the project when the card moved out of the reader's own", async () => {
    // The regression this card is about: spelled at the written address this
    // reads `CH-84`, a bare ref that claims a card homelab no longer holds.
    const link = await linkOf(seeded(), "homelab");
    expect(link.textContent).toBe("harbor/HB-30 emoji 选择器：搜索排序");
    expect(link.getAttribute("data-issue-project")).toBe("harbor");
  });

  it("drops the project when the card moved into the reader's own", async () => {
    const link = await linkOf(seeded(), "harbor");
    expect(link.textContent).toBe("HB-30 emoji 选择器：搜索排序");
    expect(link.getAttribute("data-issue-project")).toBeNull();
  });

  it("keeps the written address where the sentence is about the address", async () => {
    // `moved this in from …`: following the card would point the link's own
    // words at the card the reader is already on.
    const link = await linkOf(seeded(), "harbor", true);
    expect(link.textContent).toBe("homelab/CH-84 emoji 选择器：搜索排序");
    expect(link.getAttribute("href")).toBe("/projects/harbor/issues/30");
  });

  it("leaves a card that never moved exactly as written", async () => {
    const { body: _body, ...stayed } = issue(84, "emoji 选择器：搜索排序");
    const link = await linkOf(seeded({ ref: stayed }), "todou");
    expect(link.textContent).toBe("homelab/CH-84 emoji 选择器：搜索排序");
    expect(link.getAttribute("href")).toBe("/projects/homelab/issues/84");
  });

  it("degrades to the numeric form until the destination's prefix lands", async () => {
    const link = await linkOf(seeded({ destination: false }), "todou");
    expect(link.textContent).toBe("harbor#30 emoji 选择器：搜索排序");
  });
});
