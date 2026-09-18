import type { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  type IssueListItem,
  MePrefs,
  type ReferenceConfig,
  type TimelineComment,
  TodouClient,
} from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commentRefQuery, issueRefQuery } from "../src/api/issue-refs.ts";
import { prefsQuery } from "../src/api/prefs.ts";
import { api, projectsQuery } from "../src/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import { IssueLink } from "../src/components/shared/issue-link.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const SLUG = "cost";
const author = {
  id: 1,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};
const config: ReferenceConfig = {
  format: { prefix: "C", history: [] },
  autolinks: [],
};

const issue = (number: number): IssueListItem => ({
  id: number,
  number,
  title: `Issue ${number}`,
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

const comment = (id: number): TimelineComment => ({
  type: "comment",
  id,
  author,
  body: `Complete preview body for comment ${id}`,
  created_at: "2026-08-12T00:00:00Z",
  component: null,
  edited_at: null,
  resolved_at: null,
  hidden_at: null,
  agent_context: null,
});

const clients: QueryClient[] = [];
function freshClient() {
  const client = testQueryClient();
  clients.push(client);
  return client;
}

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});

// These are logical API-call counts, not HTTP-envelope counts. Config,
// preferences and preview-only dependencies are prewarmed, but neither the
// issue nor the comment being measured is seeded. Real timers also cover
// the batcher's macrotask and the existing hover-card open delay.
describe("reference validity lookup cost", () => {
  it("shares one complete comment lookup across 100 mounted refs and a hover", async () => {
    const list = vi.spyOn(api, "listIssues").mockResolvedValue({
      items: [issue(7)],
      next_cursor: null,
    });
    const getComment = vi
      .spyOn(api, "getComment")
      .mockResolvedValue(comment(42));
    const client = freshClient();
    client.setQueryData(referenceConfigQuery(SLUG).queryKey, config);
    client.setQueryData(prefsQuery.queryKey, MePrefs.parse({}));
    client.setQueryData(referenceDirectoryQuery.queryKey, () => ({
      entries: [],
      contested: [],
    }));
    client.setQueryData(projectsQuery.queryKey, [
      {
        id: 1,
        slug: SLUG,
        name: "Cost fixture",
        description: "",
        created_at: "2026-08-12T00:00:00Z",
      },
    ]);

    const view = renderWithProviders(
      <div>
        {Array.from({ length: 100 }, (_, index) => (
          <IssueLink
            // The fixed duplicate-reference fixture never reorders.
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed fixture order
            key={index}
            slug={SLUG}
            number={7}
            commentId={42}
            pageSlug={SLUG}
          />
        ))}
      </div>,
      client,
    );
    const links = await waitFor(() => {
      const anchors = view.container.querySelectorAll(
        "a[data-comment-link='42']",
      );
      expect(anchors).toHaveLength(100);
      for (const anchor of anchors) {
        expect(anchor.textContent).toContain("comment by Alice");
        expect(anchor.getAttribute("href")).toBe(
          `/projects/${SLUG}/issues/7#comment-42`,
        );
      }
      return anchors;
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(SLUG, { numbers: [7], limit: 1 });
    expect(getComment).toHaveBeenCalledTimes(1);
    expect(getComment).toHaveBeenCalledWith(SLUG, 7, 42);
    const complete = {
      ...comment(42),
      at: { slug: SLUG, number: 7, commentId: 42 },
    };
    expect(client.getQueryData(commentRefQuery(SLUG, 7, 42).queryKey)).toEqual(
      complete,
    );

    // A second, completed-query burst must reuse the same full response too.
    const cached = await Promise.all(
      Array.from({ length: 100 }, () =>
        client.fetchQuery(commentRefQuery(SLUG, 7, 42)),
      ),
    );
    for (const result of cached) expect(result).toEqual(complete);
    expect(getComment).toHaveBeenCalledTimes(1);

    // Same helper gesture as comment-hover-card.test.tsx: React synthesizes
    // pointer-enter from pointer-over, not from a direct pointerEnter event.
    const first = links[0];
    if (first === undefined) throw new Error("repeated reference missing");
    fireEvent.pointerOver(first, { pointerType: "mouse", bubbles: true });
    await waitFor(() => {
      const card = document.querySelector("[data-slot='hover-card-content']");
      expect(card).not.toBeNull();
      expect(card?.textContent).toContain(comment(42).body);
      expect(card?.textContent).toContain("Alice");
    });
    expect(getComment).toHaveBeenCalledTimes(1); // hover adds zero comment GETs
    expect(list).toHaveBeenCalledTimes(1);
  }, 30_000);

  it.each([1, 10, 100])(
    "%i distinct comment queries cost exactly N logical GETs, with zero for fresh repeats",
    async (count) => {
      const getComment = vi
        .spyOn(api, "getComment")
        .mockImplementation(async (_slug, _number, id) => comment(id));
      const client = freshClient();
      const ids = Array.from({ length: count }, (_, index) => index + 1);
      const results = await Promise.all(
        ids.map((id) => client.fetchQuery(commentRefQuery(SLUG, 7, id))),
      );
      expect(getComment).toHaveBeenCalledTimes(count);
      expect(getComment.mock.calls).toEqual(ids.map((id) => [SLUG, 7, id]));
      expect(results).toEqual(
        ids.map((id) => ({
          ...comment(id),
          at: { slug: SLUG, number: 7, commentId: id },
        })),
      );
      const repeated = await Promise.all(
        ids.map((id) => client.fetchQuery(commentRefQuery(SLUG, 7, id))),
      );
      expect(repeated).toEqual(results);
      expect(getComment).toHaveBeenCalledTimes(count);
      expect(
        client.getQueryCache().findAll({ queryKey: ["comment-ref", SLUG, 7] }),
      ).toHaveLength(count);
    },
    30_000,
  );

  it("resolves 101 different issue refs using list chunks of 100 and 1", async () => {
    const list = vi
      .spyOn(api, "listIssues")
      .mockImplementation(async (_slug, query) => ({
        items: (Array.isArray(query?.numbers) ? query.numbers : []).map((n) =>
          issue(Number(n)),
        ),
        next_cursor: null,
      }));
    const getIssue = vi
      .spyOn(api, "getIssue")
      .mockRejectedValue(
        new Error(
          "Complete list fixtures must not need a single-target fallback",
        ),
      );
    const client = freshClient();
    const numbers = Array.from({ length: 101 }, (_, index) => index + 1);
    const results = await Promise.all(
      numbers.map((number) => client.fetchQuery(issueRefQuery(SLUG, number))),
    );
    expect(results).toEqual(numbers.map(issue));
    expect(list).toHaveBeenCalledTimes(2);
    const chunks = list.mock.calls.map(([slug, query]) => {
      expect(slug).toBe(SLUG);
      const requested = query?.numbers as number[];
      expect(requested.length).toBeGreaterThan(0);
      expect(requested.length).toBeLessThanOrEqual(100);
      expect(query?.limit).toBe(requested.length);
      expect(query?.limit).toBeLessThanOrEqual(100);
      return requested;
    });
    expect(chunks.map((chunk) => chunk.length)).toEqual([100, 1]);
    expect(chunks.flat()).toEqual(numbers);
    expect(new Set(chunks.flat()).size).toBe(101);
    expect(getIssue).not.toHaveBeenCalled();
    const repeated = await Promise.all(
      numbers.map((number) => client.fetchQuery(issueRefQuery(SLUG, number))),
    );
    expect(repeated).toEqual(results);
    expect(list).toHaveBeenCalledTimes(2);
    expect(getIssue).not.toHaveBeenCalled();
  }, 30_000);
});

// Match the shared client's positional JSON-envelope contract. This fixture
// deliberately returns a neutral { echo } body via request<T>, not a partial
// Issue/TimelineComment masquerading as an endpoint's response schema.
function envelopeFixture() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const envelopes: Array<Array<{ url: string }>> = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (String(url) === "/api/batch") {
      const { requests } = JSON.parse(String(init?.body)) as {
        requests: Array<{ url: string }>;
      };
      envelopes.push(requests);
      return Response.json({
        responses: requests.map((request) => ({
          status: 200,
          body: { echo: request.url },
        })),
      });
    }
    // Keep the direct-GET response valid so disabling batching fails the
    // measured envelope/call counts, rather than an unrelated JSON parse.
    return Response.json({ echo: String(url).replace(/^\/api/, "") });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls, envelopes };
}

describe("reference GET transport cost", () => {
  it("carries three logical GET subrequests in one batch:true HTTP envelope", async () => {
    const fixture = envelopeFixture();
    const client = new TodouClient({ fetch: fixture.fetch, batch: true });
    const paths = [
      `/projects/${SLUG}/issues?limit=5`,
      `/projects/${SLUG}/issues/7/comments/42`,
      `/projects/${SLUG}/issues/7/comments/43`,
    ];
    const results = await Promise.all([
      client.request<{ echo: string }>("GET", `/projects/${SLUG}/issues`, {
        query: { limit: 5 },
      }),
      ...paths
        .slice(1)
        .map((path) => client.request<{ echo: string }>("GET", path)),
    ]);

    expect(results).toEqual(paths.map((path) => ({ echo: path })));
    expect(fixture.calls).toHaveLength(1); // physical HTTP requests
    expect(fixture.calls[0]?.url).toBe("/api/batch");
    expect(fixture.calls[0]?.init.method).toBe("POST");
    expect(fixture.envelopes).toHaveLength(1); // envelopes
    expect(fixture.envelopes[0]).toEqual(paths.map((url) => ({ url })));
    expect(fixture.envelopes.flat()).toHaveLength(3); // logical GETs, not one
  }, 30_000);
});
