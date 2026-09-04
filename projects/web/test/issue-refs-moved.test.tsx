import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueRefQuery } from "../src/api/issue-refs.ts";

const issue = (number: number, title: string) => ({
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
    kind: "human",
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
