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
    // A cancelled fetch settles its promise on the cancellation, not on the
    // `queryFn` it has stopped waiting for, so `pending` is no evidence that
    // the late response has finished running. The macrotask is what this
    // case has to wait on to be asserting against a settled cache.
    await new Promise((r) => setTimeout(r, 0));

    expect(
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.queryKey),
    ).toEqual([]);
  });
});
