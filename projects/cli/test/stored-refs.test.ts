import { describe, expect, it } from "vitest";
import { fakeFetch, loggedInEnv, type Route, runCli } from "./harness.ts";

const me = {
  id: 2,
  login: "claude",
  display_name: "Claude",
  kind: "machine",
  owner: null,
};

const comment = {
  type: "comment",
  id: 123,
  author: me,
  body: "the decision was to migrate",
  created_at: "2026-08-11T10:30:00Z",
  edited_at: null,
};

const projects = [
  {
    id: 7,
    slug: "todou",
    name: "todou",
    description: "",
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: 9,
    slug: "mirror",
    name: "mirror",
    description: "",
    created_at: "2026-01-01T00:00:00Z",
  },
];

const issue = {
  id: 11,
  number: 3,
  title: "Fix the potato",
  body: "It sprouted.",
  status: {
    id: 1,
    name: "Todo",
    category: "open",
    color: "#6b7280",
    position: 0,
  },
  author: me,
  assignees: [],
  labels: [],
  created_at: "2026-08-11T10:00:00Z",
  updated_at: "2026-08-11T11:00:00Z",
};

const config = { format: { prefix: null, history: [] }, autolinks: [] };

/**
 * An address copied out of stored text goes straight back into the CLI
 * (T-266, and the second half of T-261 P4). The project is spelled as its
 * id, which is what a stored link carries and what the server reads.
 */
describe("the address a stored reference is written with", () => {
  it("opens a card named by project id", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/projects/7/issues/3", issue],
      ["GET", "/api/projects/7/issues/3/timeline", { items: [] }],
      ["GET", "/api/projects/7/references/config", config],
      ["GET", "/api/projects", projects],
      ["PUT", "/api/projects/7/issues/3/read", { __status: 204 }],
    ]);
    const result = await runCli(["issue", "view", "7/3"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Fix the potato");
    expect(calls.some((c) => c.url.includes("/api/projects/7/issues/3"))).toBe(
      true,
    );
  });

  it("says nothing about re-linking when the id was the spelling used", async () => {
    // The server answers an id with the canonical-slug header, the same as a
    // retired slug. Advising `todou project link` there would be telling
    // somebody to fix a spelling that is not broken.
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/7/issues/3",
        () =>
          new Response(JSON.stringify(issue), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-todou-canonical-slug": "todou",
            },
          }),
      ],
      ["GET", "/api/projects/7/issues/3/timeline", { items: [] }],
      ["GET", "/api/projects/7/references/config", config],
      ["GET", "/api/projects", projects],
      ["PUT", "/api/projects/7/issues/3/read", { __status: 204 }],
    ]);
    const result = await runCli(["issue", "view", "7/3"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("is now");
  });

  it("opens a comment named by a whole stored address", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/7/issues/3/comments/123", comment],
      ["GET", "/api/projects/7/references/config", config],
      ["GET", "/api/projects", projects],
    ]);
    const result = await runCli(
      ["comment", "view", "/projects/7/issues/3#comment-123"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("the decision was to migrate");
  });

  it("follows a comment that moved, and says where from", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/todou/issues/3/comments/123",
        {
          __status: 301,
          body: {
            moved_to: { slug: "mirror", number: 45, comment_id: 900 },
          },
        },
      ],
      ["GET", "/api/projects/mirror/issues/45/comments/900", comment],
      ["GET", "/api/projects/mirror/references/config", config],
      ["GET", "/api/projects", projects],
    ]);
    const result = await runCli(["comment", "view", "3", "123"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("moved from todou/3#comment-123");
    expect(result.stdout).toContain("the decision was to migrate");
  });

  it("says which card to read when only the card moved", async () => {
    // An issue redirect carries no comment id, and the one asked for belongs
    // to the project the card left: following it would name a stranger.
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/todou/issues/3/comments/123",
        {
          __status: 301,
          body: { moved_to: { slug: "mirror", number: 45 } },
        },
      ],
      ["GET", "/api/projects", projects],
    ]);
    const result = await runCli(["comment", "view", "3", "123"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("which moved to mirror/45");
    expect(result.stderr).toContain("todou comment list mirror/45");
  });
});

/**
 * One reference event type, spelled by comparing where it was written with
 * where it is being read (T-266).
 */
describe("reference events in the timeline", () => {
  const eventAt = (payload: Record<string, unknown>) => ({
    type: "event",
    id: 5,
    event_type: "referenced",
    actor: me,
    payload,
    created_at: "2026-08-11T10:30:00Z",
    agent_context: null,
  });

  const run = async (payload: Record<string, unknown>) => {
    const routes: Route[] = [
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        { items: [eventAt(payload)] },
      ],
      ["GET", "/api/projects/todou/references/config", config],
      ["GET", "/api/projects", projects],
    ];
    const { fetchImpl } = fakeFetch(routes);
    return runCli(["issue", "events", "3"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
  };

  it("spells a reference from this project in its own format", async () => {
    const result = await run({ by_project_id: 7, by_issue: 12 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("referenced (by #12)");
  });

  it("spells one from another project self-containedly", async () => {
    const result = await run({ by_project_id: 9, by_issue: 12 });
    expect(result.stdout).toContain("referenced (by mirror#12)");
  });

  it("reads a row from before the merge as local", async () => {
    const result = await run({ by_issue: 12 });
    expect(result.stdout).toContain("referenced (by #12)");
  });

  it("hands back a pasteable address for a project it cannot name", async () => {
    const result = await run({ by_project_id: 4242, by_issue: 12 });
    // `todou issue view 4242/12` is a real command, which is more use than
    // a dump of the payload.
    expect(result.stdout).toContain("referenced (by 4242/12)");
  });
});
