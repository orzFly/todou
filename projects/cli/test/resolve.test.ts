import { TodouClient } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors.ts";
import {
  resolveAssignees,
  resolveClosedStatus,
  resolveLabels,
  resolveStatus,
} from "../src/resolve.ts";
import { fakeFetch } from "./harness.ts";

const statuses = [
  { id: 1, name: "Todo", category: "open", color: "#6b7280", position: 0 },
  { id: 2, name: "Done", category: "closed", color: "#22c55e", position: 1 },
  { id: 3, name: "Wontfix", category: "closed", color: "#ef4444", position: 2 },
];
const labels = [
  { id: 7, name: "bug", color: "#ef4444" },
  { id: 8, name: "chore", color: "#3b82f6" },
];
const me = {
  id: 2,
  login: "claude",
  display_name: "Claude",
  kind: "machine",
  owner: null,
};
const members = [
  { user: me, role: "writer", created_at: "2026-08-11T00:00:00Z" },
  {
    user: { ...me, id: 1, login: "user", kind: "human" },
    role: "admin",
    created_at: "2026-08-11T00:00:00Z",
  },
];

function client() {
  const { fetchImpl } = fakeFetch([
    ["GET", "/api/projects/todou/statuses", statuses],
    ["GET", "/api/projects/todou/labels", labels],
    ["GET", "/api/projects/todou/members", members],
    ["GET", "/api/me", me],
  ]);
  return new TodouClient({ fetch: fetchImpl });
}

describe("resolveStatus", () => {
  it("matches case-insensitively", async () => {
    expect((await resolveStatus(client(), "todou", "done")).id).toBe(2);
  });

  it("lists alternatives on a miss", async () => {
    const err = await resolveStatus(client(), "todou", "nope").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).hint).toContain("Todo");
  });
});

describe("resolveClosedStatus", () => {
  it("picks the first closed status by position", async () => {
    expect((await resolveClosedStatus(client(), "todou")).name).toBe("Done");
  });

  it("honors the override", async () => {
    expect((await resolveClosedStatus(client(), "todou", "wontfix")).id).toBe(
      3,
    );
  });
});

describe("resolveLabels", () => {
  it("maps names to labels without fetching for an empty list", async () => {
    const { fetchImpl, calls } = fakeFetch([]);
    const empty = new TodouClient({ fetch: fetchImpl });
    expect(await resolveLabels(empty, "todou", [])).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(
      (await resolveLabels(client(), "todou", ["BUG"])).map((l) => l.id),
    ).toEqual([7]);
  });
});

describe("resolveAssignees", () => {
  it("resolves 'me' via /me and logins via members", async () => {
    expect(await resolveAssignees(client(), "todou", ["me", "user"])).toEqual([
      2, 1,
    ]);
  });

  it("rejects unknown logins with the member list", async () => {
    const err = await resolveAssignees(client(), "todou", ["ghost"]).catch(
      (e: unknown) => e,
    );
    expect((err as CliError).hint).toContain("user");
  });
});
