import { describe, expect, it } from "vitest";
import { fakeFetch, loggedInEnv, type Route, runCli } from "./harness.ts";

const me = {
  id: 2,
  login: "claude",
  display_name: "Claude",
  kind: "machine",
  avatar_url: null,
  owner: null,
};
const statuses = [
  { id: 1, name: "Todo", category: "open", color: "#6b7280", position: 0 },
];

const blockRef = (over: Partial<Record<string, unknown>> = {}) => ({
  edge_id: 9,
  project_id: 7,
  project: "todou",
  number: 372,
  ref: "T-372",
  hidden: false,
  cleared_at: null,
  blocker_deleted: false,
  ...over,
});

const issue = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 11,
  number: 374,
  title: "Fix the potato",
  body: "It sprouted.",
  status: statuses[0],
  author: me,
  assignees: [],
  labels: [],
  created_at: "2026-09-11T10:00:00Z",
  updated_at: "2026-09-11T11:00:00Z",
  blocked_by: [],
  blocks: [],
  ...over,
});

const CARD = "/api/projects/todou/issues/374";

const viewRoutes = (over: Partial<Record<string, unknown>>): Route[] => [
  ["GET", CARD, issue(over)],
  ["PUT", `${CARD}/read`, {}],
];

/**
 * `issue view`'s header is the one place an agent looks before deciding
 * whether to start on a card, so what these pin is that the block lines are
 * in the DEFAULT output and say the thing the refs cannot — not the prose
 * around them.
 */
describe("todou issue view · block lines", () => {
  const env = loggedInEnv("todou");

  it("prints both directions beside the spec line", async () => {
    const { fetchImpl } = fakeFetch(
      viewRoutes({
        blocked_by: [blockRef()],
        blocks: [blockRef({ edge_id: 10, number: 375, ref: "T-375" })],
      }),
    );
    const res = await runCli(["issue", "view", "374", "--brief"], {
      fetchImpl,
      env,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("blocked by: T-372");
    expect(res.stdout).toContain("blocks: T-375");
  });

  it("marks a cleared edge and a blocker in the trash", async () => {
    const { fetchImpl } = fakeFetch(
      viewRoutes({
        blocked_by: [
          blockRef({ cleared_at: "2026-09-12T09:00:00Z" }),
          blockRef({
            edge_id: 11,
            number: 373,
            ref: "T-373",
            blocker_deleted: true,
          }),
        ],
      }),
    );
    const res = await runCli(["issue", "view", "374", "--brief"], {
      fetchImpl,
      env,
    });
    expect(res.stdout).toContain("T-372 (cleared)");
    // The one thing the ref cannot say: this edge will not clear itself.
    expect(res.stdout).toContain("T-373 (in the trash)");
  });

  it("counts the edges whose far end the reader cannot see", async () => {
    const { fetchImpl } = fakeFetch(
      viewRoutes({
        blocked_by: [
          blockRef({
            project_id: null,
            project: null,
            number: null,
            ref: null,
            hidden: true,
          }),
          blockRef({
            edge_id: 12,
            project_id: null,
            project: null,
            number: null,
            ref: null,
            hidden: true,
          }),
        ],
      }),
    );
    const res = await runCli(["issue", "view", "374", "--brief"], {
      fetchImpl,
      env,
    });
    expect(res.stdout).toContain("blocked by: 2 cards you cannot see");
  });

  it("says nothing at all when the card has no blocks", async () => {
    const { fetchImpl } = fakeFetch(viewRoutes({}));
    const res = await runCli(["issue", "view", "374", "--brief"], {
      fetchImpl,
      env,
    });
    expect(res.stdout).not.toContain("blocked by:");
    expect(res.stdout).not.toContain("blocks:");
  });

  it("qualifies a `#N` from another project and leaves a prefixed one alone", async () => {
    const { fetchImpl } = fakeFetch(
      viewRoutes({
        blocked_by: [
          blockRef({ project: "acme", project_id: 9, number: 31, ref: "#31" }),
          blockRef({
            edge_id: 13,
            project: "kela",
            project_id: 8,
            number: 4,
            ref: "K-4",
          }),
        ],
      }),
    );
    const res = await runCli(["issue", "view", "374", "--brief"], {
      fetchImpl,
      env,
    });
    expect(res.stdout).toContain("acme#31");
    expect(res.stdout).toContain("K-4");
  });
});

describe("todou issue block / unblock", () => {
  const env = loggedInEnv("todou");

  it("sends one POST per ref and prints the card's two directions", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["POST", `${CARD}/blocked-by`, { blocked_by: [blockRef()] }],
      ["GET", CARD, issue({ blocked_by: [blockRef()] })],
    ]);
    const res = await runCli(["issue", "block", "374", "--by", "T-372"], {
      fetchImpl,
      env,
    });
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ ref: "T-372" });
    expect(res.stdout).toContain("blocked by: T-372");
  });

  it("splits a comma list and takes both directions at once", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["POST", `${CARD}/blocked-by`, { blocked_by: [blockRef()] }],
      ["POST", `${CARD}/blocks`, { blocks: [blockRef({ edge_id: 14 })] }],
      ["GET", CARD, issue()],
    ]);
    const res = await runCli(
      ["issue", "block", "374", "--by", "T-372,T-373", "--blocks", "T-375"],
      { fetchImpl, env },
    );
    expect(res.exitCode).toBe(0);
    const posted = calls.filter((c) => c.init.method === "POST");
    expect(posted).toHaveLength(3);
    expect(posted.map((c) => JSON.parse(String(c.init.body)).ref)).toEqual([
      "T-372",
      "T-373",
      "T-375",
    ]);
  });

  it("refuses to run with neither direction named", async () => {
    const { fetchImpl } = fakeFetch([]);
    const res = await runCli(["issue", "block", "374"], { fetchImpl, env });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("name at least one issue");
  });

  it("finds the edge id itself, by any spelling of the far end", async () => {
    for (const typed of ["T-372", "todou#372", "todou/372", "#372", "372"]) {
      const { fetchImpl, calls } = fakeFetch([
        ["GET", CARD, issue({ blocked_by: [blockRef()] })],
        ["DELETE", `${CARD}/blocked-by/9`, null],
      ]);
      const res = await runCli(["issue", "unblock", "374", "--by", typed], {
        fetchImpl,
        env,
      });
      expect(res.exitCode, typed).toBe(0);
      expect(
        calls.some(
          (c) =>
            c.init.method === "DELETE" &&
            c.url.endsWith("/issues/374/blocked-by/9"),
        ),
        typed,
      ).toBe(true);
    }
  });

  it("does not read a bare number as a card of another project", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        CARD,
        issue({
          blocked_by: [
            blockRef({
              project: "acme",
              project_id: 9,
              number: 31,
              ref: "#31",
            }),
          ],
        }),
      ],
    ]);
    const res = await runCli(["issue", "unblock", "374", "--by", "31"], {
      fetchImpl,
      env,
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("no --by block on 31");
  });

  it("points at the api escape hatch when the edge is one it cannot name", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        CARD,
        issue({
          blocked_by: [
            blockRef({
              project_id: null,
              project: null,
              number: null,
              ref: null,
              hidden: true,
            }),
          ],
        }),
      ],
    ]);
    const res = await runCli(["issue", "unblock", "374", "--by", "T-372"], {
      fetchImpl,
      env,
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("cards you cannot see");
  });
});

describe("todou issue list --blocked", () => {
  const env = loggedInEnv("todou");

  it("passes the filter through, and refuses both at once", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/projects/todou/issues", { items: [], next_cursor: null }],
    ]);
    const res = await runCli(["issue", "list", "--blocked"], {
      fetchImpl,
      env,
    });
    expect(res.exitCode).toBe(0);
    expect(new URL(calls[0]?.url as string).searchParams.get("blocked")).toBe(
      "true",
    );

    const both = await runCli(["issue", "list", "--blocked", "--unblocked"], {
      fetchImpl: fakeFetch([]).fetchImpl,
      env,
    });
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toContain("mutually exclusive");
  });

  it("asks for the unblocked ones as blocked=false", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/projects/todou/issues", { items: [], next_cursor: null }],
    ]);
    await runCli(["issue", "list", "--unblocked"], { fetchImpl, env });
    expect(new URL(calls[0]?.url as string).searchParams.get("blocked")).toBe(
      "false",
    );
  });
});
