import { describe, expect, it } from "vitest";
import { TodouClient, TodouError } from "../src/client.ts";

type Captured = { url: string; init: RequestInit };

function mockFetch(
  status: number,
  body: unknown,
): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe("TodouClient", () => {
  it("builds csv query strings and skips undefined params", async () => {
    const { fetch, calls } = mockFetch(200, { items: [], next_cursor: null });
    const client = new TodouClient({ fetch });
    await client.listIssues("todou", {
      status: [1, 2],
      q: "potato",
      assignee: undefined,
    });
    expect(calls[0]?.url).toBe(
      "/api/projects/todou/issues?status=1%2C2&q=potato",
    );
  });

  it("sends bearer tokens when configured", async () => {
    const { fetch, calls } = mockFetch(200, { id: 1 });
    const client = new TodouClient({
      fetch,
      token: "todou_pat_x",
      baseUrl: "http://localhost:3000",
    });
    await client.me();
    expect(calls[0]?.url).toBe("http://localhost:3000/api/me");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer todou_pat_x");
  });

  it("throws TodouError with server error codes", async () => {
    const { fetch } = mockFetch(409, {
      error: { code: "conflict", message: "slug taken" },
    });
    const client = new TodouClient({ fetch });
    const err = await client
      .createProject({ slug: "x", name: "X", description: "" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TodouError);
    expect((err as TodouError).status).toBe(409);
    expect((err as TodouError).code).toBe("conflict");
  });

  it("returns undefined for 204 responses", async () => {
    const { fetch } = mockFetch(204, undefined);
    const client = new TodouClient({ fetch });
    await expect(client.logout()).resolves.toBeUndefined();
  });

  it("maps timeline last=true onto last=1", async () => {
    const { fetch, calls } = mockFetch(200, {
      items: [],
      prev_cursor: null,
      next_cursor: null,
    });
    const client = new TodouClient({ fetch });
    await client.getTimeline("todou", 42, { last: true, limit: 50 });
    expect(calls[0]?.url).toBe(
      "/api/projects/todou/issues/42/timeline?last=1&limit=50",
    );
  });
});
