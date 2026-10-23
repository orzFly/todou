import { describe, expect, it } from "vitest";
import { fakeFetch, loggedInEnv, type Route, runCli } from "./harness.ts";

const AT = "2026-09-01T00:00:00.000Z";
const entry = (
  project_id: number,
  number: number,
  comment_id: number | null = null,
  more = 0,
) => ({ project_id, number, comment_id, more, created_at: AT });

const REFS = {
  linked_from: [entry(2, 5, 501), entry(2, 7), entry(9, 3)],
  links_to: [entry(2, 7, 601, 2), entry(4, 8)],
};

const routes = (refs: unknown): Route[] => [
  ["GET", "/api/projects/todou/issues/16/references", refs],
  [
    "GET",
    "/api/projects",
    [
      { id: 2, slug: "todou" },
      { id: 4, slug: "acme" },
    ],
  ],
  [
    "GET",
    "/api/projects/todou/references/config",
    { format: { prefix: "T", history: [] }, autolinks: [] },
  ],
  [
    "GET",
    "/api/projects/todou/issues",
    (_init: RequestInit, url: URL) => ({
      items: (url.searchParams.get("numbers") ?? "")
        .split(",")
        .filter((n) => n !== "7")
        .map((n) => ({ number: Number(n), title: `card ${n}` })),
      next_cursor: null,
    }),
  ],
  [
    "GET",
    "/api/projects/acme/issues",
    { items: [{ number: 8, title: "over there" }], next_cursor: null },
  ],
];

describe("todou issue refs", () => {
  const env = loggedInEnv("todou");

  it("prints both directions, titled where a title came back", async () => {
    const { fetchImpl } = fakeFetch(routes(REFS));
    const res = await runCli(["issue", "refs", "16"], { fetchImpl, env });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trimEnd().split("\n")).toEqual([
      "linked from (3)",
      "  T-5  card 5  (#comment-501)",
      "  T-7  (body)  ⇄",
      "  9/3  (body)",
      "links to (2)",
      "  T-7  (#comment-601 +2)  ⇄",
      "  acme#8  over there  (body)",
    ]);
  });

  it("says none for an empty side", async () => {
    const { fetchImpl } = fakeFetch(
      routes({ linked_from: [], links_to: REFS.links_to }),
    );
    const res = await runCli(["issue", "refs", "16"], { fetchImpl, env });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("linked from (0)\n  none\nlinks to (2)");
  });

  it("hands --json the response untouched, with no title reads", async () => {
    const { fetchImpl, calls } = fakeFetch(routes(REFS));
    const res = await runCli(["issue", "refs", "16", "--json"], {
      fetchImpl,
      env,
    });
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual(REFS);
    expect(calls.some((c) => c.url.includes("numbers="))).toBe(false);
  });
});
