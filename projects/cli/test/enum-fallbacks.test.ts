import { describe, expect, it } from "vitest";
import { fakeFetch, type Route, runCli } from "./harness.ts";

const ENV = {
  TODOU_SERVER: "http://stub.test",
  TODOU_TOKEN: "tok",
  TODOU_PROJECT: "proj",
};
const author = { id: 2, login: "claude-agent", display_name: "Claude Agent" };
const createdAt = "2026-08-12T05:00:00.000Z";

function issue(reviewStatus: unknown) {
  return {
    id: 230,
    number: 23,
    title: "Review the design",
    body: "A spec to review.",
    status: {
      id: 1,
      name: "In Progress",
      category: "open",
      color: "#3b82f6",
      position: 0,
    },
    author,
    assignees: [],
    labels: [],
    created_at: createdAt,
    updated_at: createdAt,
    body_edited_at: null,
    spec_version: 2,
    spec_review_status: reviewStatus,
    spec_unresolved_comments: 0,
  };
}

const referenceRoutes: Route[] = [
  [
    "GET",
    "/api/projects/proj/references/config",
    { format: { prefix: null, history: [] }, autolinks: [] },
  ],
  ["GET", "/api/projects", { items: [], next_cursor: null }],
];

const surfaces = [
  { name: "spec status", argv: ["spec", "status", "23"] },
  { name: "spec list", argv: ["spec", "list"] },
  { name: "issue view", argv: ["issue", "view", "23", "--brief"] },
];

function statusRoutes(reviewStatus: unknown): Route[] {
  return [
    ...referenceRoutes,
    [
      "GET",
      "/api/projects/proj/issues/23/spec",
      {
        current_version: 2,
        review_status: reviewStatus,
        unresolved_comments: 0,
        files: [],
        versions: [],
      },
    ],
    [
      "GET",
      "/api/projects/proj/issues",
      { items: [issue(reviewStatus)], next_cursor: null },
    ],
    ["GET", "/api/projects/proj/issues/23", issue(reviewStatus)],
    ["PUT", "/api/projects/proj/issues/23/read", { __status: 204 }],
  ];
}

// Exercise the HTTP response -> command -> human output path, including the
// shared specVerdict caller in issue view. JSON serialization omits undefined,
// so those cases model a genuinely absent required wire field.
describe.each(surfaces)("$name review status compatibility", ({ argv }) => {
  it.each(["future_review_state", "constructor", "__proto__"])(
    "labels an unknown non-empty status %s",
    async (status) => {
      const { fetchImpl } = fakeFetch(statusRoutes(status));
      const run = await runCli(argv, { fetchImpl, env: ENV });

      expect(run.exitCode).toBe(0);
      expect(run.stderr).toBe("");
      expect(run.stdout).toContain(`unknown status: ${status}`);
      expect(run.stdout).not.toContain("undefined");
      expect(run.stdout).not.toContain("[object Object]");
      expect(run.stdout).not.toContain("function Object");
    },
  );

  it.each([
    ["unreviewed", "awaiting review"],
    ["approved", "approved"],
    ["changes_requested", "changes requested"],
    [null, "awaiting review"],
  ])("preserves the wording for %s", async (status, wording) => {
    const { fetchImpl } = fakeFetch(statusRoutes(status));
    const run = await runCli(argv, { fetchImpl, env: ENV });

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain(wording);
    expect(run.stdout).not.toContain("unknown status");
  });

  it.each([undefined, "", 42])(
    "rejects a missing or malformed required status: %s",
    async (status) => {
      const { fetchImpl } = fakeFetch(statusRoutes(status));
      const run = await runCli(argv, { fetchImpl, env: ENV });

      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("review_status must be a non-empty string");
      expect(run.stdout).toBe("");
    },
  );
});

it("keeps an unknown timeline review verdict in the scalar payload fallback", async () => {
  const { fetchImpl } = fakeFetch([
    ...statusRoutes("unreviewed"),
    [
      "GET",
      "/api/projects/proj/issues/23/timeline",
      {
        items: [
          {
            type: "event",
            id: 99,
            event_type: "spec_review",
            actor: author,
            created_at: createdAt,
            payload: {
              version: 2,
              verdict: "future_review_verdict",
              comment_id: null,
              annotation_count: 0,
            },
          },
        ],
        prev_cursor: null,
        next_cursor: null,
        total_count: 1,
      },
    ],
  ]);
  const run = await runCli(["issue", "view", "23", "--timeline"], {
    fetchImpl,
    env: ENV,
  });

  expect(run.exitCode).toBe(0);
  expect(run.stderr).toBe("");
  expect(run.stdout).toContain("verdict=future_review_verdict");
  expect(run.stdout).toContain("version=2");
  expect(run.stdout).not.toContain('reviewed ("future_review_verdict")');
  expect(run.stdout).not.toContain("undefined");
});
