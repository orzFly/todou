import { QueryClient } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import {
  type IssueListItem,
  MePrefs,
  type ReferenceConfig,
} from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueRefQuery, type ResolvedIssueRef } from "../src/api/issue-refs.ts";
import { prefsQuery } from "../src/api/prefs.ts";
import { referenceConfigQuery } from "../src/api/references.ts";
import { IssueLink } from "../src/components/shared/issue-link.tsx";
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
