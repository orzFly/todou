import { QueryClient } from "@tanstack/react-query";
import type { PublicUser } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { userQuery } from "../src/api/users.ts";

const alice: PublicUser = {
  id: 7,
  login: "alice",
  display_name: "Alice Potato",
  kind: "human",
  avatar_url: null,
  owner: null,
  created_at: "2026-01-01T00:00:00Z",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("userQuery's alias seeding (T-414)", () => {
  it("leaves a cleared cache empty when the response lands late", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let release: (user: PublicUser) => void = () => undefined;
    vi.spyOn(api, "getUser").mockReturnValue(
      new Promise<PublicUser>((resolve) => {
        release = resolve;
      }),
    );

    const pending = client.fetchQuery(userQuery("7")).catch(() => undefined);
    expect(api.getUser).toHaveBeenCalledTimes(1);

    // Logging out clears the cache mid-read (shell.tsx). That cancels and
    // removes the query, but `api.getUser` holds no signal, so the response
    // still arrives here afterwards.
    client.clear();
    expect(client.getQueryCache().getAll()).toHaveLength(0);

    release(alice);
    await pending;
    // A macrotask, not just `await pending`: the fetch promise settles the
    // moment clear() cancels the query, which is before the response has
    // reached the seeding line at all. Everything the late response runs is
    // microtasks, and one macrotask drains all of them — without this the
    // case would pass against an implementation that does repopulate.
    await new Promise((r) => setTimeout(r, 0));

    expect(
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.queryKey),
    ).toEqual([]);
  });
});
