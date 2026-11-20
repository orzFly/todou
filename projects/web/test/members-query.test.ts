import { QueryClient } from "@tanstack/react-query";
import { TodouError } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, membersQuery } from "../src/api/queries.ts";

describe("membersQuery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The pages that suspend on it must still render for a guest (T-788).
  it("reads a refused member list as an empty one", async () => {
    vi.spyOn(api, "listMembers").mockRejectedValue(
      new TodouError(403, "forbidden", "requires reader role (member.list)"),
    );
    const client = new QueryClient();
    expect(await client.fetchQuery(membersQuery("ui"))).toEqual([]);
  });

  it("still fails on anything else", async () => {
    vi.spyOn(api, "listMembers").mockRejectedValue(
      new TodouError(404, "not_found", "project not found"),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await expect(client.fetchQuery(membersQuery("ui"))).rejects.toThrow(
      "project not found",
    );
  });
});
