import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import stringWidth from "string-width";
import { afterAll, describe, expect, it } from "vitest";
import { loadCliConfig, saveCliConfig } from "../src/config.ts";
import {
  fakeFetch,
  loggedInEnv,
  parseNdjson,
  type Route,
  runCli,
  virtualClock,
} from "./harness.ts";

const me = {
  id: 2,
  login: "claude",
  display_name: "Claude",
  kind: "machine",
  owner: null,
};
const statuses = [
  { id: 1, name: "Todo", category: "open", color: "#6b7280", position: 0 },
  { id: 2, name: "Done", category: "closed", color: "#22c55e", position: 1 },
];
const labels = [{ id: 7, name: "bug", color: "#ef4444" }];
const issue = {
  id: 11,
  number: 3,
  title: "Fix the potato",
  body: "It sprouted.",
  status: statuses[0],
  author: me,
  assignees: [me],
  labels,
  created_at: "2026-08-11T10:00:00Z",
  updated_at: "2026-08-11T11:00:00Z",
};

describe("whoami", () => {
  it("prints identity, and raw JSON under --json", async () => {
    const { fetchImpl } = fakeFetch([["GET", "/api/me", me]]);
    const human = await runCli(["whoami"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toBe("claude (Claude) · machine @ http://stub.test\n");

    const json = await runCli(["whoami", "--json"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(JSON.parse(json.stdout)).toEqual(me);
  });

  it("fails with guidance when no server is configured", async () => {
    const result = await runCli(["whoami"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no server configured");
    expect(result.stderr).toContain("todou login");
  });

  it("fails with guidance when the server has no token", async () => {
    const result = await runCli(["whoami"], {
      env: { TODOU_SERVER: "http://stub.test" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not logged in to http://stub.test");
  });
});

describe("project list", () => {
  it("renders a slug/name table", async () => {
    const projects = [
      { id: 1, slug: "dogfood", name: "Dogfood", description: "sandbox" },
    ];
    const { fetchImpl } = fakeFetch([["GET", "/api/projects", projects]]);
    const result = await runCli(["project", "list"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(result.stdout).toBe("dogfood  Dogfood  sandbox\n");
  });
});

describe("issue list", () => {
  it("resolves filter names to ids in the query", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/projects/todou/statuses", statuses],
      ["GET", "/api/projects/todou/labels", labels],
      [
        "GET",
        "/api/projects/todou/issues",
        { items: [issue], next_cursor: null },
      ],
    ]);
    const result = await runCli(
      ["issue", "list", "--status", "todo", "--label", "bug", "--limit", "5"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    const listCall = calls.find((c) => c.url.includes("/issues?"));
    const url = new URL(listCall?.url ?? "", "http://stub.test");
    expect(url.searchParams.get("status")).toBe("1");
    expect(url.searchParams.get("label")).toBe("7");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(result.stdout).toContain("#3");
    expect(result.stdout).toContain("Fix the potato");
  });

  it("takes --status repeated or comma-split, as one filter (T-184)", async () => {
    const twoStatuses = [
      ...statuses,
      { id: 3, name: "In Progress", category: "open", color: "#3b82f6" },
    ];
    const listRoutes = (): Route[] => [
      ["GET", "/api/projects/todou/statuses", twoStatuses],
      [
        "GET",
        "/api/projects/todou/issues",
        { items: [issue], next_cursor: null },
      ],
    ];
    const statusParam = async (argv: string[]) => {
      const { fetchImpl, calls } = fakeFetch(listRoutes());
      const result = await runCli(argv, {
        fetchImpl,
        env: loggedInEnv("todou"),
      });
      expect(result.exitCode).toBe(0);
      const listCall = calls.find((c) => c.url.includes("/issues?"));
      return new URL(listCall?.url ?? "", "http://stub.test").searchParams.get(
        "status",
      );
    };

    const repeated = await statusParam([
      "issue",
      "list",
      "--status",
      "Todo",
      "--status",
      "In Progress",
    ]);
    const split = await statusParam([
      "issue",
      "list",
      "--status",
      "Todo,In Progress",
    ]);
    expect(repeated).toBe("1,3");
    expect(split).toBe(repeated);
    // A single value still spells the query string it always did.
    expect(await statusParam(["issue", "list", "--status", "todo"])).toBe("1");
  });

  it("still refuses --status alongside --open (T-184)", async () => {
    const { fetchImpl } = fakeFetch([]);
    const result = await runCli(
      ["issue", "list", "--status", "Todo", "--open"],
      {
        fetchImpl,
        env: loggedInEnv("todou"),
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("mutually exclusive");
  });

  it("maps --open/--closed to the category param and rejects combos", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/projects/todou/issues", { items: [], next_cursor: null }],
    ]);
    const result = await runCli(["issue", "list", "--closed"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.stdout).toBe("no issues\n");
    expect(calls[0]?.url).toContain("category=closed");

    const combo = await runCli(["issue", "list", "--open", "--closed"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(combo.exitCode).toBe(1);
    expect(combo.stderr).toContain("mutually exclusive");
  });

  it("requires a project", async () => {
    const { fetchImpl } = fakeFetch([]);
    const result = await runCli(["issue", "list"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no project selected");
    expect(result.stderr).toContain("todou project link");
  });

  it("closes the list with a count", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/todou/issues",
        { items: [issue, { ...issue, id: 12, number: 4 }], next_cursor: null },
      ],
    ]);
    const result = await runCli(["issue", "list"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trimEnd().split("\n").at(-1)).toBe("2 issues");
  });

  it("says one issue in the singular", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/todou/issues",
        { items: [issue], next_cursor: null },
      ],
    ]);
    const result = await runCli(["issue", "list"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.stdout.trimEnd().split("\n").at(-1)).toBe("1 issue");
  });

  it("folds the count into the more-available line", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/todou/issues",
        { items: [issue], next_cursor: "c9" },
      ],
    ]);
    const result = await runCli(["issue", "list"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.stdout.trimEnd().split("\n").at(-1)).toBe(
      "1 issue shown · more available (raise --limit)",
    );
  });

  it("aligns a CJK title against an ASCII one", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/todou/issues",
        {
          items: [
            { ...issue, title: "淡化 JSON 的存在" },
            { ...issue, id: 12, number: 4, title: "ascii title" },
          ],
          next_cursor: null,
        },
      ],
    ]);
    const result = await runCli(["issue", "list"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    const [first, second] = result.stdout.split("\n");
    // Terminal columns, not UTF-16 indices: `.indexOf` is exactly the measure
    // the old padEnd used, and it is the one that left the CJK row six
    // columns short of its neighbour.
    const column = (line: string | undefined) =>
      stringWidth((line ?? "").slice(0, (line ?? "").indexOf("Todo")));
    expect(column(first)).toBe(column(second));
  });
});

describe("issue view", () => {
  const timelinePages = [
    {
      items: [
        {
          type: "comment",
          id: 1,
          author: me,
          body: "first",
          created_at: "2026-08-11T10:30:00Z",
          edited_at: null,
        },
      ],
      prev_cursor: null,
      next_cursor: "c1",
    },
    {
      items: [
        {
          type: "event",
          id: 2,
          event_type: "status_changed",
          actor: me,
          payload: {
            from: { id: 1, name: "Todo" },
            to: { id: 2, name: "Done" },
          },
          created_at: "2026-08-11T10:45:00Z",
        },
      ],
      prev_cursor: "c1",
      next_cursor: null,
    },
  ];

  it("stitches the full timeline across pages", async () => {
    let page = 0;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issue],
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        () => {
          const reply = timelinePages[page];
          page += 1;
          return reply;
        },
      ],
    ]);
    const result = await runCli(["issue", "view", "3", "--json"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      issue: { number: number };
      timeline: unknown[];
      next_cursor: string | null;
    };
    expect(parsed.issue.number).toBe(3);
    expect(parsed.timeline).toHaveLength(2);
    // The tail cursor rides along so a follow-up watch can --since it.
    expect(parsed.next_cursor).toBe("c1");
  });

  it("renders body, comments, and events for humans", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issue],
      ["GET", "/api/projects/todou/issues/3/timeline", timelinePages[1]],
    ]);
    const result = await runCli(["issue", "view", "3"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.stdout).toContain("#3 Fix the potato");
    expect(result.stdout).toContain("It sprouted.");
    expect(result.stdout).toContain("status_changed (Todo → Done)");
    expect(result.stdout).toContain("assignees: Claude");
    expect(result.stdout).toContain("opened by Claude");
  });

  it("names people by display name, falling back to the login (T-149)", async () => {
    const nameless = { ...me, id: 4, login: "newcomer", display_name: "   " };
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issue],
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        {
          items: [
            {
              type: "comment",
              id: 1,
              author: { ...me, display_name: "Claude Agent" },
              body: "first",
              created_at: "2026-08-11T10:30:00Z",
              edited_at: null,
            },
            {
              type: "comment",
              id: 2,
              author: nameless,
              body: "second",
              created_at: "2026-08-11T10:35:00Z",
              edited_at: null,
            },
          ],
          prev_cursor: null,
          next_cursor: null,
        },
      ],
    ]);
    const result = await runCli(["issue", "view", "3"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.stdout).toContain("Claude Agent commented");
    expect(result.stdout).toContain("newcomer commented");
  });

  it("spells out event payloads and appends spec command hints", async () => {
    const event = (id: number, event_type: string, payload: unknown) => ({
      type: "event",
      id,
      event_type,
      actor: me,
      payload,
      created_at: "2026-08-11T10:45:00Z",
    });
    const page = {
      items: [
        event(1, "label_added", {
          label: { id: 7, name: "bug", color: "#ef4444" },
        }),
        event(2, "assigned", { user: { id: 2, login: "claude" } }),
        event(3, "referenced", { by_issue: 9, by_comment: 41 }),
        event(10, "cross_referenced", { by_project: "mirror", by_issue: 4 }),
        event(4, "attachment_added", {
          attachment: { id: 5, filename: "shot.png", size: 123 },
        }),
        event(5, "spec_pushed", {
          version: 2,
          message: "tighten scope",
          added: ["plan.md"],
          changed: ["design.md", "api.md"],
          removed: [],
        }),
        event(6, "spec_review", {
          version: 2,
          verdict: "request_changes",
          comment_id: null,
          annotation_count: 4,
        }),
        event(7, "spec_comments_resolved", {
          comment_ids: [11, 12],
          paths: ["design.md"],
        }),
        event(8, "closed", { from: null, to: { id: 2, name: "Done" } }),
        event(9, "spec_review", {
          version: 3,
          verdict: "approve",
          comment_id: null,
          annotation_count: 0,
        }),
      ],
      prev_cursor: null,
      next_cursor: null,
    };
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issue],
      ["GET", "/api/projects/todou/issues/3/timeline", page],
      [
        "GET",
        "/api/projects/todou/references/config",
        { format: { prefix: "T", history: [] }, autolinks: [] },
      ],
    ]);
    const result = await runCli(["issue", "view", "3"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("label_added (bug)");
    expect(result.stdout).toContain("assigned (@claude)");
    expect(result.stdout).toContain("referenced (by T-9)");
    // Self-contained: never spelled with this project's prefix, which
    // would point at an unrelated card here.
    expect(result.stdout).toContain("cross_referenced (by mirror#4)");
    expect(result.stdout).toContain("attachment_added (shot.png)");
    expect(result.stdout).toContain(
      "spec_pushed (v2: 1 added, 2 changed — tighten scope · use `todou spec pull 3 --version 2 <empty-dir>` to view)",
    );
    expect(result.stdout).toContain(
      "spec_review (v2 changes requested, 4 annotation(s) · use `todou spec comments 3 --unresolved` to view)",
    );
    expect(result.stdout).toContain(
      "spec_review (v3 approved · use `todou spec pull 3 --version 3 <empty-dir>` to view)",
    );
    expect(result.stdout).toContain(
      "spec_comments_resolved (2 annotation(s) on design.md)",
    );
    expect(result.stdout).toContain("closed (? → Done)");
  });

  it("renders renames and edited markers", async () => {
    const page = {
      items: [
        {
          type: "comment",
          id: 1,
          author: me,
          body: "first",
          created_at: "2026-08-11T10:30:00Z",
          edited_at: "2026-08-11T10:40:00Z",
        },
        {
          type: "event",
          id: 2,
          event_type: "title_changed",
          actor: me,
          payload: { from: "Old potato", to: "Fix the potato" },
          created_at: "2026-08-11T10:45:00Z",
        },
      ],
      prev_cursor: null,
      next_cursor: null,
    };
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issue],
      ["GET", "/api/projects/todou/issues/3/timeline", page],
    ]);
    const result = await runCli(["issue", "view", "3"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.stdout).toContain("commented (edited)");
    expect(result.stdout).toContain('renamed "Old potato" → "Fix the potato"');
    expect(result.stdout).not.toContain("title_changed (");
  });

  it("rejects a non-numeric issue number", async () => {
    const { fetchImpl } = fakeFetch([]);
    const result = await runCli(["issue", "view", "abc"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("positive integer");
  });

  it("accepts the show alias, project/number refs, and issue URLs", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issue],
      ["GET", "/api/projects/todou/issues/3/timeline", timelinePages[1]],
    ]);
    const viaShow = await runCli(["issue", "show", "3"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(viaShow.exitCode).toBe(0);
    expect(viaShow.stdout).toContain("#3 Fix the potato");

    // no TODOU_PROJECT here: the ref itself supplies the project
    const viaRef = await runCli(["issue", "view", "todou/3"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(viaRef.exitCode).toBe(0);
    expect(viaRef.stdout).toContain("#3 Fix the potato");

    const viaUrl = await runCli(
      ["issue", "view", "http://stub.test/projects/todou/issues/3"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(viaUrl.exitCode).toBe(0);

    const agreeing = await runCli(["issue", "view", "todou/3", "-p", "todou"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(agreeing.exitCode).toBe(0);
  });

  it("rejects a ref contradicting -p, and a URL on a foreign server", async () => {
    const { fetchImpl } = fakeFetch([]);
    const conflict = await runCli(
      ["issue", "view", "dogfood/3", "-p", "todou"],
      {
        fetchImpl,
        env: loggedInEnv(),
      },
    );
    expect(conflict.exitCode).toBe(1);
    expect(conflict.stderr).toContain('says project "dogfood"');

    const elsewhere = await runCli(
      ["issue", "view", "https://other.example/projects/todou/issues/3"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(elsewhere.exitCode).toBe(1);
    expect(elsewhere.stderr).toContain("active server");
  });
});

describe("issue view slices", () => {
  const entry = (id: number) => ({
    type: "comment",
    id,
    author: me,
    body: `entry ${id}`,
    created_at: `2026-08-11T10:${String(id).padStart(2, "0")}:00Z`,
    edited_at: null,
  });
  const page = {
    items: [entry(1), entry(2), entry(3), entry(4)],
    prev_cursor: null,
    next_cursor: null,
  };
  const routes = (): Route[] => [
    ["GET", "/api/projects/todou/issues/3", issue],
    ["GET", "/api/projects/todou/issues/3/timeline", page],
    ["PUT", "/api/projects/todou/issues/3/read", {}],
  ];

  it("--brief keeps the header and meta, drops body and timeline", async () => {
    const { fetchImpl } = fakeFetch(routes());
    const result = await runCli(["issue", "view", "3", "--brief"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("#3 Fix the potato");
    expect(result.stdout).toContain("status: Todo");
    expect(result.stdout).toContain("opened by Claude");
    expect(result.stdout).not.toContain("It sprouted.");
    expect(result.stdout).not.toContain("── timeline ──");
    expect(result.stdout).not.toContain("cursor:");
  });

  it("--brief fetches no timeline and leaves the read marker alone", async () => {
    const { fetchImpl, calls } = fakeFetch(routes());
    const result = await runCli(["issue", "view", "3", "--brief"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    // Nothing was shown, so nothing may be marked read — and the timeline
    // pages are the request this flag exists to skip.
    expect(calls.filter((c) => c.url.includes("/timeline"))).toHaveLength(0);
    expect(calls.filter((c) => c.url.includes("/read"))).toHaveLength(0);
  });

  it("--brief emits issue and ref_format alone under --json", async () => {
    const { fetchImpl } = fakeFetch(routes());
    const result = await runCli(["issue", "view", "3", "--brief", "--json"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["issue", "ref_format"]);
  });

  it("--timeline drops the body but keeps the header and cursor", async () => {
    const { fetchImpl } = fakeFetch(routes());
    const result = await runCli(["issue", "view", "3", "--timeline"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("#3 Fix the potato");
    expect(result.stdout).not.toContain("It sprouted.");
    expect(result.stdout).toContain("── timeline ──");
    expect(result.stdout).toContain("entry 4");
  });

  it("--last keeps the newest N and says what it dropped", async () => {
    const { fetchImpl } = fakeFetch(routes());
    const result = await runCli(["issue", "view", "3", "--last", "2"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("… 2 earlier entries");
    expect(result.stdout).toContain("entry 3");
    expect(result.stdout).toContain("entry 4");
    expect(result.stdout).not.toContain("entry 1");
  });

  it("--last says entry in the singular", async () => {
    const { fetchImpl } = fakeFetch(routes());
    const result = await runCli(["issue", "view", "3", "--last", "3"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.stdout).toContain("… 1 earlier entry");
  });

  it("--last past the end elides nothing", async () => {
    const { fetchImpl } = fakeFetch(routes());
    const result = await runCli(["issue", "view", "3", "--last", "40"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.stdout).not.toContain("earlier entr");
    expect(result.stdout).toContain("entry 1");
  });

  it("--last slices the JSON timeline the same way", async () => {
    const { fetchImpl } = fakeFetch(routes());
    const result = await runCli(
      ["issue", "view", "3", "--last", "2", "--json"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    const parsed = JSON.parse(result.stdout) as {
      timeline: Array<{ id: number }>;
    };
    expect(parsed.timeline.map((i) => i.id)).toEqual([3, 4]);
  });

  it("still marks read up to the newest entry under --last", async () => {
    const { fetchImpl, calls } = fakeFetch(routes());
    await runCli(["issue", "view", "3", "--last", "1"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    const read = calls.find((c) => c.url.includes("/read"));
    expect(JSON.parse(String(read?.init.body))).toEqual({
      up_to: "2026-08-11T10:04:00Z",
    });
  });

  it("refuses --brief with --timeline or --last", async () => {
    const { fetchImpl } = fakeFetch(routes());
    const both = await runCli(["issue", "view", "3", "--brief", "--timeline"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toContain("opposite halves");

    const trimmed = await runCli(
      ["issue", "view", "3", "--brief", "--last", "2"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(trimmed.exitCode).toBe(1);
    expect(trimmed.stderr).toContain("no timeline for --last to trim");
  });

  it("rejects a --last that is not a positive integer", async () => {
    const { fetchImpl } = fakeFetch(routes());
    const result = await runCli(["issue", "view", "3", "--last", "0"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--last");
  });
});

describe("issue view, several numbers (T-184)", () => {
  const card = (number: number, title: string) => ({
    ...issue,
    id: number * 10,
    number,
    title,
  });
  const entry = (number: number, at: string) => ({
    type: "comment",
    id: number,
    author: me,
    body: `on ${number}`,
    created_at: at,
    edited_at: null,
  });
  const gone = {
    __status: 404,
    body: { error: { code: "not_found", message: "issue not found" } },
  };
  const routes = (): Route[] => [
    ["GET", "/api/projects/todou/issues/3", card(3, "Fix the potato")],
    ["GET", "/api/projects/todou/issues/4", card(4, "Water the field")],
    [
      "GET",
      "/api/projects/todou/issues/3/timeline",
      {
        items: [entry(3, "2026-08-11T10:30:00Z")],
        prev_cursor: null,
        next_cursor: "c3",
      },
    ],
    [
      "GET",
      "/api/projects/todou/issues/4/timeline",
      {
        items: [entry(4, "2026-08-11T10:40:00Z")],
        prev_cursor: null,
        next_cursor: "c4",
      },
    ],
    ["PUT", "/api/projects/todou/issues/3/read", { __status: 204 }],
    ["PUT", "/api/projects/todou/issues/4/read", { __status: 204 }],
  ];

  it("prints the cards in the order asked for, ruled apart", async () => {
    const { fetchImpl } = fakeFetch(routes());
    const result = await runCli(["issue", "view", "4", "3"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.indexOf("#4 Water the field")).toBeLessThan(
      result.stdout.indexOf("#3 Fix the potato"),
    );
    expect(result.stdout).toContain("────────");
    // Each card keeps its own resume point — one batch, two watches.
    expect(result.stdout).toContain("cursor: c4");
    expect(result.stdout).toContain("cursor: c3");
  });

  it("reports a bad number in place, keeps the rest, and exits 1", async () => {
    const { fetchImpl } = fakeFetch([
      ...routes(),
      ["GET", "/api/projects/todou/issues/9", gone],
    ]);
    const result = await runCli(["issue", "view", "3", "9", "4"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    // A typo must never read as "that card is quiet".
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("#9 · error: issue not found (404)");
    expect(result.stdout).toContain("#3 Fix the potato");
    expect(result.stdout).toContain("#4 Water the field");
  });

  it("keeps the single-number --json shape untouched", async () => {
    const { fetchImpl } = fakeFetch(routes());
    const result = await runCli(["issue", "view", "3", "--json"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      "issue",
      "next_cursor",
      "ref_format",
      "timeline",
    ]);
    expect(parsed.next_cursor).toBe("c3");
  });

  it("wraps two or more in an items envelope, failures included", async () => {
    const { fetchImpl } = fakeFetch([
      ...routes(),
      ["GET", "/api/projects/todou/issues/9", gone],
    ]);
    const result = await runCli(["issue", "view", "3", "9", "--json"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      items: Array<Record<string, unknown>>;
      ref_format: unknown;
    };
    expect(Object.keys(parsed).sort()).toEqual(["items", "ref_format"]);
    expect(parsed.items.map((i) => i.number)).toEqual([3, 9]);
    expect(parsed.items[0]?.next_cursor).toBe("c3");
    expect(parsed.items[1]?.error).toEqual({
      status: 404,
      code: "not_found",
      message: "issue not found",
    });
  });

  it("--brief on a batch fetches no timeline and marks nothing read", async () => {
    const { fetchImpl, calls } = fakeFetch(routes());
    const result = await runCli(["issue", "view", "3", "4", "--brief"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("#3 Fix the potato");
    expect(result.stdout).toContain("#4 Water the field");
    expect(calls.filter((c) => c.url.includes("/timeline"))).toHaveLength(0);
    expect(calls.filter((c) => c.url.includes("/read"))).toHaveLength(0);
  });

  it("reads a repeated number once and says so", async () => {
    const { fetchImpl, calls } = fakeFetch(routes());
    const result = await runCli(["issue", "view", "3", "4", "3"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("duplicate 3 ignored");
    expect(
      calls.filter((c) => c.url.endsWith("/api/projects/todou/issues/3")),
    ).toHaveLength(1);
  });

  it("refuses a batch that spans two projects", async () => {
    const { fetchImpl } = fakeFetch([]);
    const result = await runCli(["issue", "view", "todou/3", "dogfood/4"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      '"todou/3" says project "todou" but "dogfood/4" says "dogfood"',
    );
  });
});

const botOne = {
  id: 5,
  login: "bot-one",
  display_name: "Bot One",
  kind: "machine",
  owner: null,
};

describe("comment list", () => {
  const comment = (id: number, author: typeof me, body: string) => ({
    type: "comment",
    id,
    author,
    body,
    created_at: `2026-08-11T10:${String(id).padStart(2, "0")}:00Z`,
    edited_at: null,
  });
  const statusEvent = {
    type: "event",
    id: 40,
    event_type: "status_changed",
    actor: me,
    payload: { from: { id: 1, name: "Todo" }, to: { id: 2, name: "Done" } },
    created_at: "2026-08-11T10:50:00Z",
  };
  const pages = [
    {
      items: [comment(1, me, "first\n\nsecond paragraph"), statusEvent],
      prev_cursor: null,
      next_cursor: "c1",
    },
    {
      items: [
        comment(2, botOne, "a reply about migrations"),
        comment(3, me, "third"),
      ],
      prev_cursor: "c1",
      next_cursor: null,
    },
  ];
  // Fresh per test: the stub walks the pages by call order, the way a
  // forward drain asks for them.
  const timelineRoute = (): Route => {
    let page = 0;
    return [
      "GET",
      "/api/projects/todou/issues/3/timeline",
      () => {
        const reply = pages[page];
        page += 1;
        return reply;
      },
    ];
  };

  it("prints every comment whole, each headed by its id", async () => {
    const { fetchImpl, calls } = fakeFetch([timelineRoute()]);
    const result = await runCli(["comment", "list", "3"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("comment 1 · Claude commented");
    expect(result.stdout).toContain("comment 2 · Bot One commented");
    // The whole body, not the one-line summary a watch prints — the point
    // of the command is reading what was said without truncation.
    expect(result.stdout).toContain("second paragraph");
    // Events are `issue events`' half.
    expect(result.stdout).not.toContain("status_changed");
    expect(result.stdout).toContain("cursor: c1");
    // A slice of the card is not a read card.
    expect(calls.filter((c) => c.url.includes("/read"))).toHaveLength(0);
  });

  it("filters by author, resolving @me through the token", async () => {
    const { fetchImpl } = fakeFetch([["GET", "/api/me", me], timelineRoute()]);
    const result = await runCli(["comment", "list", "3", "--author", "@me"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("comment 1 ·");
    expect(result.stdout).toContain("comment 3 ·");
    expect(result.stdout).not.toContain("comment 2 ·");
  });

  it("filters by a named login", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/todou/members",
        [
          { user: me, role: "admin", created_at: "2026-08-01T00:00:00Z" },
          { user: botOne, role: "writer", created_at: "2026-08-02T00:00:00Z" },
        ],
      ],
      timelineRoute(),
    ]);
    const result = await runCli(
      ["comment", "list", "3", "--author", "bot-one"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("comment 2 ·");
    expect(result.stdout).not.toContain("comment 1 ·");
  });

  it("filters by body text, case-insensitively", async () => {
    const { fetchImpl } = fakeFetch([timelineRoute()]);
    const result = await runCli(["comment", "list", "3", "-q", "MIGRATIONS"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("comment 2 ·");
    expect(result.stdout).not.toContain("comment 1 ·");
  });

  it("distinguishes a card with no comments from filters that miss", async () => {
    const missed = fakeFetch([timelineRoute()]);
    const nothing = await runCli(["comment", "list", "3", "-q", "potato"], {
      fetchImpl: missed.fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(nothing.stdout).toContain("no comments match");

    const bare = fakeFetch([
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        { items: [statusEvent], prev_cursor: null, next_cursor: null },
      ],
    ]);
    const quiet = await runCli(["comment", "list", "3"], {
      fetchImpl: bare.fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(quiet.stdout).toContain("no comments");
    expect(quiet.stdout).not.toContain("match");
  });

  it("--last keeps the newest N and says how many it dropped", async () => {
    const two = fakeFetch([timelineRoute()]);
    const newest = await runCli(["comment", "list", "3", "--last", "1"], {
      fetchImpl: two.fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(newest.stdout).toContain("… 2 earlier comments");
    expect(newest.stdout).toContain("comment 3 ·");
    expect(newest.stdout).not.toContain("comment 1 ·");

    const one = fakeFetch([timelineRoute()]);
    const singular = await runCli(["comment", "list", "3", "--last", "2"], {
      fetchImpl: one.fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(singular.stdout).toContain("… 1 earlier comment");
  });

  it("--json emits one bounded document, not NDJSON", async () => {
    const { fetchImpl } = fakeFetch([timelineRoute()]);
    const result = await runCli(["comment", "list", "3", "--json"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    const parsed = JSON.parse(result.stdout) as {
      comments: Array<{ id: number; body: string }>;
      next_cursor: string | null;
    };
    expect(Object.keys(parsed).sort()).toEqual([
      "comments",
      "next_cursor",
      "ref_format",
    ]);
    expect(parsed.comments.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(parsed.next_cursor).toBe("c1");
  });
});

describe("comment view", () => {
  const comment = {
    type: "comment",
    id: 123,
    author: me,
    body: "the decision was to migrate",
    created_at: "2026-08-11T10:30:00Z",
    edited_at: null,
  };
  const routes = (): Route[] => [
    ["GET", "/api/projects/todou/issues/3/comments/123", comment],
  ];

  it("takes a bare id, the #comment- spelling, and a whole permalink", async () => {
    const spellings = [
      ["comment", "view", "3", "123"],
      ["comment", "view", "3", "#comment-123"],
      // What copying a timestamp off the web page puts on the clipboard.
      [
        "comment",
        "view",
        "http://stub.test/projects/todou/issues/3#comment-123",
      ],
    ];
    for (const argv of spellings) {
      const { fetchImpl } = fakeFetch(routes());
      const result = await runCli(argv, {
        fetchImpl,
        env: loggedInEnv("todou"),
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("comment 123 · Claude commented");
      expect(result.stdout).toContain("the decision was to migrate");
    }
  });

  it("hands a body straight to a script under --json", async () => {
    const { fetchImpl } = fakeFetch(routes());
    const result = await runCli(["comment", "view", "3", "123", "--json"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    const parsed = JSON.parse(result.stdout) as {
      body: string;
      issue_number: number;
      issue_ref: string;
    };
    expect(parsed.body).toBe("the decision was to migrate");
    expect(parsed.issue_number).toBe(3);
    expect(parsed.issue_ref).toBe("#3");
  });

  it("asks for the id when only an issue was named", async () => {
    const { fetchImpl } = fakeFetch(routes());
    const result = await runCli(["comment", "view", "3"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("names an issue but no comment");
    expect(result.stderr).toContain("#comment-<id>");
  });

  it("reports a comment that is not there", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/todou/issues/3/comments/999",
        {
          __status: 404,
          body: { error: { code: "not_found", message: "comment not found" } },
        },
      ],
    ]);
    const result = await runCli(["comment", "view", "3", "999"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not_found");
  });
});

describe("comment delete", () => {
  const comment = {
    type: "comment",
    id: 123,
    author: me,
    body: "posted on the wrong card",
    created_at: "2026-08-11T10:30:00Z",
    edited_at: null,
  };
  const routes = (): Route[] => [
    ["GET", "/api/projects/todou/issues/3/comments/123", comment],
    ["DELETE", "/api/projects/todou/issues/3/comments/123", { __status: 204 }],
  ];

  it("refuses to delete unprompted off a TTY", async () => {
    const { fetchImpl, calls } = fakeFetch(routes());
    const result = await runCli(["comment", "delete", "3", "123"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "refusing to delete without a confirmation",
    );
    // The hint is the command that would have worked, verbatim.
    expect(result.stderr).toContain("todou comment delete 3 123 -y");
    expect(calls.some((c) => c.init.method === "DELETE")).toBe(false);
  });

  it("-y deletes and names what went", async () => {
    const { fetchImpl, calls } = fakeFetch(routes());
    const result = await runCli(["comment", "delete", "3", "123", "-y"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("deleted comment 123 on #3\n");
    expect(
      calls.some(
        (c) =>
          c.init.method === "DELETE" &&
          c.url.includes("/issues/3/comments/123"),
      ),
    ).toBe(true);
  });

  it("--json says the comment is gone", async () => {
    const { fetchImpl } = fakeFetch(routes());
    const result = await runCli(
      ["comment", "delete", "3", "123", "-y", "--json"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    const parsed = JSON.parse(result.stdout) as {
      id: number;
      deleted: boolean;
      issue_ref: string;
    };
    expect(parsed).toMatchObject({ id: 123, deleted: true, issue_ref: "#3" });
  });

  it("quotes the body in the prompt, and a refusal deletes nothing", async () => {
    const { fetchImpl, calls } = fakeFetch(routes());
    const result = await runCli(["comment", "delete", "3", "123"], {
      fetchImpl,
      env: loggedInEnv("todou"),
      stdinIsTTY: true,
      stdinText: "\n",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cancelled");
    // The prompt names author, card and body, so the wrong id is caught here.
    expect(result.stderr).toContain(
      'Delete comment 123 by Claude on #3? "posted on the wrong card"',
    );
    expect(calls.some((c) => c.init.method === "DELETE")).toBe(false);
  });
});

describe("issue events", () => {
  const event = (id: number, event_type: string, payload: unknown) => ({
    type: "event",
    id,
    event_type,
    actor: me,
    payload,
    created_at: "2026-08-11T10:45:00Z",
  });
  const chatter = {
    type: "comment",
    id: 1,
    author: me,
    body: "chatter",
    created_at: "2026-08-11T10:30:00Z",
    edited_at: null,
  };
  const referenced = event(3, "referenced", { by_issue: 9 });
  const page = {
    items: [
      chatter,
      event(2, "status_changed", {
        from: { id: 1, name: "Todo" },
        to: { id: 2, name: "Done" },
      }),
      referenced,
      // A type this CLI predates: the scalar fallback has to carry it
      // rather than crash, which is why the default drain is unfiltered.
      event(4, "moon_phase_changed", { phase: "waxing" }),
    ],
    prev_cursor: null,
    next_cursor: "c9",
    has_more: false,
  };

  it("drops the comments and keeps every event, unknown types included", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3/timeline", page],
    ]);
    const result = await runCli(["issue", "events", "3"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("chatter");
    expect(result.stdout).toContain(
      "event 2 · Claude status_changed (Todo → Done)",
    );
    expect(result.stdout).toContain("event 3 · Claude referenced (by #9)");
    expect(result.stdout).toContain(
      "event 4 · Claude moon_phase_changed (phase=waxing)",
    );
    expect(result.stdout).toContain("cursor: c9");
    // Same rule as `--brief`: half a card is not a read card.
    expect(calls.filter((c) => c.url.includes("/read"))).toHaveLength(0);
  });

  it("--type filters server-side", async () => {
    const { fetchImpl, calls } = fakeFetch([
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        { ...page, items: [referenced] },
      ],
    ]);
    const result = await runCli(
      ["issue", "events", "3", "--type", "referenced"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    expect(calls.find((c) => c.url.includes("/timeline"))?.url).toContain(
      "types=referenced",
    );
    expect(result.stdout).toContain("event 3 · Claude referenced (by #9)");
  });

  it("keeps the comment spelling when --type asks for comments", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        { ...page, items: [chatter] },
      ],
    ]);
    const result = await runCli(["issue", "events", "3", "--type", "comment"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    // Comment ids and event ids overlap, so the kind is always named.
    expect(result.stdout).toContain("comment 1 · Claude commented");
    expect(result.stdout).not.toContain("event 1 ·");
  });

  it("--last keeps the newest and says what it dropped", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3/timeline", page],
    ]);
    const result = await runCli(["issue", "events", "3", "--last", "1"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.stdout).toContain("… 2 earlier events");
    expect(result.stdout).toContain("event 4 · Claude moon_phase_changed");
    expect(result.stdout).not.toContain("event 2 · Claude status_changed");
  });

  it("--json emits one bounded document", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3/timeline", page],
    ]);
    const result = await runCli(["issue", "events", "3", "--json"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    const parsed = JSON.parse(result.stdout) as {
      events: Array<{ id: number }>;
      next_cursor: string | null;
    };
    expect(Object.keys(parsed).sort()).toEqual([
      "events",
      "next_cursor",
      "ref_format",
    ]);
    expect(parsed.events.map((e) => e.id)).toEqual([2, 3, 4]);
    expect(parsed.next_cursor).toBe("c9");
  });

  it("rejects an unknown --type before calling the server", async () => {
    const { fetchImpl, calls } = fakeFetch([]);
    const result = await runCli(["issue", "events", "3", "--type", "bogus"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown --type "bogus"');
    expect(calls).toHaveLength(0);
  });
});

describe("project members", () => {
  const members = [
    { user: me, role: "admin", created_at: "2026-08-01T00:00:00Z" },
    { user: botOne, role: "writer", created_at: "2026-08-02T00:00:00Z" },
  ];

  it("prints login, display name and role, then a count", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/members", members],
    ]);
    const result = await runCli(["project", "members"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    // login first: it is the column `-a` and `--exclude-actor` accept.
    expect(lines[0]).toMatch(/^claude\s+Claude\s+admin$/);
    expect(lines[1]).toMatch(/^bot-one\s+Bot One\s+writer$/);
    expect(lines.at(-1)).toBe("2 members");
  });

  it("says one member in the singular", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/members", [members[0]]],
    ]);
    const result = await runCli(["project", "members"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.stdout.trimEnd().split("\n").at(-1)).toBe("1 member");
  });

  it("--json passes the array through", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/members", members],
    ]);
    const result = await runCli(["project", "members", "--json"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(JSON.parse(result.stdout)).toEqual(members);
  });
});

describe("issue watch", () => {
  const newComment = {
    type: "comment",
    id: 9,
    author: me,
    body: "fresh news",
    created_at: "2026-08-11T12:00:00Z",
    edited_at: null,
  };
  const pageWith = (items: unknown[], next: string | null) => ({
    items,
    prev_cursor: null,
    next_cursor: next,
  });
  // Every watch resolves "me" first: the default self-filter needs the
  // account axis for entries no agent session claims (T-121).
  const watchFetch = (routes: Route[]) =>
    fakeFetch([["GET", "/api/me", me], ...routes]);

  it("--poll returns new entries and the advanced cursor (exit 0)", async () => {
    const { fetchImpl } = watchFetch([
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        (_init: RequestInit, url: URL) =>
          url.searchParams.get("after") === "c0"
            ? pageWith([newComment], "c1")
            : pageWith([], null),
      ],
    ]);
    const result = await runCli(
      ["issue", "watch", "3", "--poll", "--since", "c0", "--json"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    const { items, cursor, lines } = parseNdjson<{ body: string }>(
      result.stdout,
    );
    expect(items.map((i) => i.body)).toEqual(["fresh news"]);
    // The item line is the timeline entry itself, unchanged from the
    // envelope days; the cursor rides its own record after it.
    expect(items[0]).toEqual(newComment);
    expect(cursor.next_cursor).toBe("c1");
    expect(lines).toBe(2);
  });

  it("--poll with nothing new echoes the cursor and exits 0", async () => {
    const { fetchImpl } = watchFetch([
      ["GET", "/api/projects/todou/issues/3/timeline", pageWith([], null)],
    ]);
    const result = await runCli(
      ["issue", "watch", "3", "--poll", "--since", "c0", "--json"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    // A finished check is a success, however quiet: the caller reads the
    // output to learn whether there was news (T-173).
    expect(result.exitCode).toBe(0);
    // One cursor record, nothing else: `--poll --json | jq -r .next_cursor`
    // still bootstraps a cursor without knowing about NDJSON at all.
    const { items, cursor, lines } = parseNdjson(result.stdout);
    expect(items).toEqual([]);
    expect(lines).toBe(1);
    expect(cursor.next_cursor).toBe("c0");
  });

  it("without --since it baselines at now, then blocks until news", async () => {
    const clock = virtualClock();
    let forwardPolls = 0;
    const { fetchImpl, calls } = watchFetch([
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        (_init: RequestInit, url: URL) => {
          if (url.searchParams.get("last") === "1") {
            return pageWith([{ ...newComment, id: 1, body: "old" }], "tail");
          }
          if (url.searchParams.get("after") === "tail") {
            forwardPolls += 1;
            return forwardPolls >= 3
              ? pageWith([newComment], "c2")
              : pageWith([], null);
          }
          return pageWith([], null);
        },
      ],
    ]);
    const result = await runCli(
      ["issue", "watch", "3", "--interval", "2", "--timeout", "300", "--json"],
      { fetchImpl, env: loggedInEnv("todou"), clock },
    );
    expect(result.exitCode).toBe(0);
    const { items, cursor } = parseNdjson<{ body: string }>(result.stdout);
    // History before the baseline is never replayed.
    expect(items.map((i) => i.body)).toEqual(["fresh news"]);
    expect(cursor.next_cursor).toBe("c2");
    expect(calls.some((c) => c.url.includes("last=1"))).toBe(true);
    // Two empty polls at the requested interval, then the news — the
    // cadence is the flag's, not the machine's.
    expect(clock.elapsed()).toBe(4_000);
  });

  it("times out with exit 3 when nothing happens", async () => {
    const clock = virtualClock();
    const { fetchImpl } = watchFetch([
      ["GET", "/api/projects/todou/issues/3/timeline", pageWith([], null)],
    ]);
    const result = await runCli(
      [
        "issue",
        "watch",
        "3",
        "--since",
        "c0",
        "--timeout",
        "60",
        "--interval",
        "2",
      ],
      { fetchImpl, env: loggedInEnv("todou"), clock },
    );
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain("no new activity");
    expect(result.stdout).toContain("cursor: c0");
    // The last sleep is clamped to the remaining time, so the quiet phase
    // ends on the deadline rather than one interval past it.
    expect(clock.elapsed()).toBe(60_000);
  });

  it("--debounce batches entries arriving inside the window", async () => {
    const clock = virtualClock();
    // Live entry: created_at is the clock's own now, so the full window
    // applies — the anchor is `created_at`, not first sight.
    const liveComment = { ...newComment, created_at: clock.iso() };
    let c1Calls = 0;
    const { fetchImpl } = watchFetch([
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        (_init: RequestInit, url: URL) => {
          const after = url.searchParams.get("after");
          if (after === "c0") return pageWith([liveComment], "c1");
          if (after === "c1") {
            c1Calls += 1;
            // Quiet at first; a second entry lands during the window.
            return c1Calls === 1
              ? pageWith([], null)
              : pageWith([{ ...liveComment, id: 10, body: "late news" }], "c2");
          }
          return pageWith([], null);
        },
      ],
    ]);
    const result = await runCli(
      [
        "issue",
        "watch",
        "3",
        "--since",
        "c0",
        "--debounce",
        "60",
        "--interval",
        "2",
        "--timeout",
        "300",
        "--json",
      ],
      { fetchImpl, env: loggedInEnv("todou"), clock },
    );
    expect(result.exitCode).toBe(0);
    const { items, cursor } = parseNdjson<{ body: string }>(result.stdout);
    expect(items.map((i) => i.body)).toEqual(["fresh news", "late news"]);
    expect(cursor.next_cursor).toBe("c2");
    // The window is honored: no early return on the first entry.
    expect(clock.elapsed()).toBe(60_000);
  });

  it("--debounce window is fixed, so sustained activity still returns", async () => {
    const clock = virtualClock();
    let n = 0;
    let pending = true;
    const { fetchImpl } = watchFetch([
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        () => {
          // Every drain finds one fresh entry: item page, then empty page.
          if (pending) {
            pending = false;
            n += 1;
            return pageWith(
              [
                {
                  ...newComment,
                  id: n,
                  body: `burst ${n}`,
                  created_at: clock.iso(),
                },
              ],
              `b${n}`,
            );
          }
          pending = true;
          return pageWith([], null);
        },
      ],
    ]);
    const result = await runCli(
      [
        "issue",
        "watch",
        "3",
        "--since",
        "b0",
        "--debounce",
        "60",
        "--interval",
        "2",
        "--timeout",
        "300",
        "--json",
      ],
      { fetchImpl, env: loggedInEnv("todou"), clock },
    );
    expect(result.exitCode).toBe(0);
    const { items, cursor } = parseNdjson(result.stdout);
    // Ever-fresh entries never push the anchor forward: the window still
    // closes 60s after the *first* batch, so the count is exactly the
    // opening drain plus one per 2s poll inside it.
    expect(items).toHaveLength(1 + 60 / 2);
    expect(cursor.next_cursor).toBe(`b${n}`);
    expect(clock.elapsed()).toBe(60_000);
  });

  it("--debounce returns at once when a resume back-fills an aged batch", async () => {
    const clock = virtualClock();
    const staleComment = { ...newComment, created_at: clock.iso(-60_000) };
    let c1Calls = 0;
    const { fetchImpl } = watchFetch([
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        (_init: RequestInit, url: URL) => {
          const after = url.searchParams.get("after");
          if (after === "c0") return pageWith([staleComment], "c1");
          if (after === "c1") c1Calls += 1;
          return pageWith([], null);
        },
      ],
    ]);
    const result = await runCli(
      [
        "issue",
        "watch",
        "3",
        "--since",
        "c0",
        "--debounce",
        "5",
        "--interval",
        "2",
        "--timeout",
        "300",
        "--json",
      ],
      { fetchImpl, env: loggedInEnv("todou"), clock },
    );
    expect(result.exitCode).toBe(0);
    // The window (created_at + 5s) ended long before the watch saw the
    // entry, so it is delivered without idle waiting or re-polling.
    expect(clock.elapsed()).toBe(0);
    expect(c1Calls).toBe(1);
    const { items, cursor } = parseNdjson<{ body: string }>(result.stdout);
    expect(items.map((i) => i.body)).toEqual(["fresh news"]);
    expect(cursor.next_cursor).toBe("c1");
  });

  it("--debounce waits only the remainder of a partially aged window", async () => {
    const clock = virtualClock();
    const agedComment = { ...newComment, created_at: clock.iso(-1_000) };
    let c1Calls = 0;
    const { fetchImpl } = watchFetch([
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        (_init: RequestInit, url: URL) => {
          const after = url.searchParams.get("after");
          if (after === "c0") return pageWith([agedComment], "c1");
          if (after === "c1") {
            c1Calls += 1;
            return c1Calls === 1
              ? pageWith([], null)
              : pageWith(
                  [
                    {
                      ...newComment,
                      id: 10,
                      body: "late news",
                      created_at: clock.iso(),
                    },
                  ],
                  "c2",
                );
          }
          return pageWith([], null);
        },
      ],
    ]);
    const result = await runCli(
      [
        "issue",
        "watch",
        "3",
        "--since",
        "c0",
        "--debounce",
        "2",
        "--interval",
        "0.5",
        "--timeout",
        "300",
        "--json",
      ],
      { fetchImpl, env: loggedInEnv("todou"), clock },
    );
    expect(result.exitCode).toBe(0);
    const { items, cursor } = parseNdjson<{ body: string }>(result.stdout);
    // Still inside the window, so collection continues...
    expect(items.map((i) => i.body)).toEqual(["fresh news", "late news"]);
    expect(cursor.next_cursor).toBe("c2");
    // ...but 1s of the 2s window was spent before the watch saw the entry:
    // exactly the remainder is waited, not a fresh window.
    expect(clock.elapsed()).toBe(1_000);
  });

  it("--poll ignores --debounce and returns immediately", async () => {
    const clock = virtualClock();
    const { fetchImpl } = watchFetch([
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        (_init: RequestInit, url: URL) =>
          url.searchParams.get("after") === "c0"
            ? pageWith([newComment], "c1")
            : pageWith([], null),
      ],
    ]);
    const result = await runCli(
      [
        "issue",
        "watch",
        "3",
        "--poll",
        "--since",
        "c0",
        "--debounce",
        "5",
        "--json",
      ],
      { fetchImpl, env: loggedInEnv("todou"), clock },
    );
    expect(result.exitCode).toBe(0);
    expect(parseNdjson(result.stdout).items).toHaveLength(1);
    expect(clock.elapsed()).toBe(0);
  });

  it("passes --type through and resolves --exclude-actor me", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/me", me],
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        (_init: RequestInit, url: URL) =>
          url.searchParams.get("after") === "c0"
            ? pageWith([newComment], "c1")
            : pageWith([], null),
      ],
    ]);
    const result = await runCli(
      [
        "issue",
        "watch",
        "3",
        "--poll",
        "--since",
        "c0",
        "--type",
        "comment,status_changed",
        "--exclude-actor",
        "me",
      ],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    const timelineCall = calls.find((c) => c.url.includes("/timeline"));
    expect(timelineCall?.url).toContain("types=comment%2Cstatus_changed");
    expect(timelineCall?.url).toContain("exclude_actor=2");
  });

  it("applies the same self-filter as todou watch (T-121)", async () => {
    const { fetchImpl, calls } = watchFetch([
      ["GET", "/api/projects/todou/issues/3/timeline", pageWith([], null)],
    ]);
    const result = await runCli(
      ["issue", "watch", "3", "--poll", "--since", "c0"],
      {
        fetchImpl,
        env: {
          ...loggedInEnv("todou"),
          CLAUDECODE: "1",
          CLAUDE_CODE_SESSION_ID: "session-sentinel",
        },
      },
    );
    expect(result.exitCode).toBe(0);
    const timelineCall = calls.find((c) => c.url.includes("/timeline"));
    expect(timelineCall?.url).toContain("exclude_actor=2");
    expect(timelineCall?.url).toContain(
      "exclude_agent_session=session-sentinel",
    );
  });

  it("--any-actor keeps everything and skips /me", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3/timeline", pageWith([], null)],
    ]);
    const result = await runCli(
      ["issue", "watch", "3", "--poll", "--since", "c0", "--any-actor"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    expect(calls.some((c) => c.url.includes("/api/me"))).toBe(false);
    expect(calls.some((c) => c.url.includes("exclude_"))).toBe(false);
  });

  it("refuses --any-actor together with --exclude-actor", async () => {
    const { fetchImpl } = fakeFetch([]);
    const result = await runCli(
      ["issue", "watch", "3", "--poll", "--any-actor", "--exclude-actor", "me"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--any-actor conflicts with");
  });

  it("rejects unknown --type values before calling the server", async () => {
    const { fetchImpl } = fakeFetch([]);
    const result = await runCli(
      ["issue", "watch", "3", "--poll", "--type", "bogus"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown --type "bogus"');
  });

  describe("--poll --print-cursor (T-254)", () => {
    const cardRoutes = (items: unknown[], cursor: string | null) =>
      watchFetch([
        [
          "GET",
          "/api/projects/todou/issues/3/timeline",
          (_init: RequestInit, url: URL) =>
            url.searchParams.get("after") === "c0"
              ? pageWith(items, cursor)
              : pageWith([], null),
        ],
      ]);

    it("prints the cursor alone and exits 0 on an empty poll", async () => {
      const { fetchImpl } = cardRoutes([], null);
      const result = await runCli(
        ["issue", "watch", "3", "--poll", "--since", "c0", "--print-cursor"],
        { fetchImpl, env: loggedInEnv("todou") },
      );
      // The default poll answers with prose here; the cursor was still
      // produced, and it is the whole product of this flag.
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("c0\n");
    });

    it("prints the advanced cursor when there were entries too", async () => {
      const { fetchImpl } = cardRoutes([newComment], "c1");
      const result = await runCli(
        ["issue", "watch", "3", "--poll", "--since", "c0", "--print-cursor"],
        { fetchImpl, env: loggedInEnv("todou") },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("c1\n");
    });

    it("refuses --json, a blocking watch and --follow", async () => {
      const { fetchImpl } = cardRoutes([], null);
      const run = (argv: string[]) =>
        runCli(["issue", "watch", "3", ...argv], {
          fetchImpl,
          env: loggedInEnv("todou"),
        });

      const withJson = await run(["--poll", "--print-cursor", "--json"]);
      expect(withJson.exitCode).toBe(1);
      expect(withJson.stderr).toContain("both want stdout");

      const blocking = await run(["--print-cursor"]);
      expect(blocking.exitCode).toBe(1);
      expect(blocking.stderr).toContain("only makes sense with --poll");

      const standing = await run(["--follow", "--print-cursor"]);
      expect(standing.exitCode).toBe(1);
      expect(standing.stderr).toContain(
        "--follow conflicts with --print-cursor",
      );
    });

    it("says so rather than printing an empty cursor", async () => {
      const { fetchImpl } = watchFetch([
        ["GET", "/api/projects/todou/issues/3/timeline", pageWith([], null)],
      ]);
      const result = await runCli(
        ["issue", "watch", "3", "--poll", "--print-cursor"],
        { fetchImpl, env: loggedInEnv("todou") },
      );
      // An empty capture would silently mean "start at now" at the next
      // call, which is the confusion this flag exists to end.
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("no cursor to print");
      expect(result.stderr).toContain("on this issue");
    });

    it("refuses to hand back another project's cursor for a moved card", async () => {
      const { fetchImpl } = watchFetch([
        [
          "GET",
          "/api/projects/todou/issues/3/timeline",
          { __status: 301, body: { moved_to: { slug: "other", number: 45 } } },
        ],
        [
          "GET",
          "/api/projects/other/issues/45/timeline",
          pageWith([], "cur-45"),
        ],
      ]);
      const result = await runCli(
        ["issue", "watch", "3", "--poll", "--print-cursor"],
        { fetchImpl, env: loggedInEnv("todou") },
      );
      // Without --print-cursor this prints two lines of prose and exits 0;
      // a command substitution would capture those as "the cursor".
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("moved to other/45");
      expect(result.stderr).toContain(
        "todou issue watch other/45 --since cur-45",
      );
    });
  });
});

describe("status/label list", () => {
  it("prints statuses ordered by position", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/statuses", [statuses[1], statuses[0]]],
    ]);
    const result = await runCli(["status", "list"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.stdout.indexOf("Todo")).toBeLessThan(
      result.stdout.indexOf("Done"),
    );
  });

  it("marks the project's default status", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/todou/statuses",
        [{ ...statuses[0], is_default: true }, statuses[1]],
      ],
    ]);
    const result = await runCli(["status", "list"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    const todoLine = result.stdout
      .split("\n")
      .find((line) => line.startsWith("Todo"));
    expect(todoLine).toContain("default");
    expect(result.stdout).not.toContain("Done  closed  #22c55e  default");
  });

  it("prints labels", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/labels", labels],
    ]);
    const result = await runCli(["label", "list"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.stdout).toBe("bug  #ef4444\n");
  });
});

describe("project link/unlink", () => {
  const dir = mkdtempSync(join(tmpdir(), "todou-link-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("writes a directory config outside a repository (T-133)", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou", { id: 1, slug: "todou" }],
    ]);
    const result = await runCli(["project", "link", "todou"], {
      fetchImpl,
      env: { ...loggedInEnv(), XDG_CONFIG_HOME: dir },
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("linked ./.todou.toml");
    // cwd here IS $XDG_CONFIG_HOME — a wall the walk never enters, so the
    // command must say the file will not take effect.
    expect(result.stderr).toContain("has no effect here");
  });

  it("link verifies the slug and writes the binding; unlink removes it", async () => {
    const repo = join(dir, "repo");
    const { execFileSync } = await import("node:child_process");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(repo);
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", [
      "-C",
      repo,
      "remote",
      "add",
      "origin",
      "git@example.com:me/potato.git",
    ]);

    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou", { id: 1, slug: "todou" }],
    ]);
    const env = { ...loggedInEnv(), XDG_CONFIG_HOME: dir };
    const linked = await runCli(["project", "link", "todou"], {
      fetchImpl,
      env,
      cwd: repo,
    });
    expect(linked.exitCode).toBe(0);
    expect(loadCliConfig(env).bindings).toEqual([
      {
        remote: "git@example.com:me/potato.git",
        server: "http://stub.test",
        project: "todou",
      },
    ]);

    const unlinked = await runCli(["project", "unlink"], { env, cwd: repo });
    expect(unlinked.exitCode).toBe(0);
    expect(loadCliConfig(env).bindings).toEqual([]);
  });

  it("unlink reports when there is nothing to remove", async () => {
    saveCliConfig({ servers: {}, bindings: [] }, { XDG_CONFIG_HOME: dir });
    const empty = join(dir, "empty");
    mkdirSync(empty);
    const result = await runCli(["project", "unlink"], {
      env: { XDG_CONFIG_HOME: dir },
      cwd: empty,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("nothing to unlink here");
    expect(loadCliConfig({ XDG_CONFIG_HOME: dir }).bindings).toEqual([]);
  });
});

describe("reference format display (T-80)", () => {
  const config = {
    format: {
      prefix: "T",
      history: [{ prefix: "T", effective_from: "2026-08-13T00:00:00Z" }],
    },
    autolinks: [],
  };

  it("spells the view header with the project prefix", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issue],
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        { items: [], prev_cursor: null, next_cursor: null },
      ],
      ["PUT", "/api/projects/todou/issues/3/read", {}],
      ["GET", "/api/projects/todou/references/config", config],
    ]);
    const result = await runCli(["issue", "view", "T-3", "-p", "todou"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("T-3 Fix the potato");
    expect(result.stdout).not.toContain("#3");
  });

  it("spells list rows with the prefix and degrades without the endpoint", async () => {
    const page = { items: [issue], next_cursor: null };
    const withConfig = fakeFetch([
      ["GET", "/api/projects/todou/issues", page],
      ["GET", "/api/projects/todou/references/config", config],
    ]);
    const spelled = await runCli(["issue", "list", "-p", "todou"], {
      fetchImpl: withConfig.fetchImpl,
      env: loggedInEnv(),
    });
    expect(spelled.stdout).toContain("T-3");

    // Old server: no config route — fakeFetch throws, the CLI degrades.
    const without = fakeFetch([["GET", "/api/projects/todou/issues", page]]);
    const fallback = await runCli(["issue", "list", "-p", "todou"], {
      fetchImpl: without.fetchImpl,
      env: loggedInEnv(),
    });
    expect(fallback.exitCode).toBe(0);
    expect(fallback.stdout).toContain("#3");
  });

  it("fetches the config under --json too, to spell refs (T-134)", async () => {
    const { fetchImpl, calls } = fakeFetch([
      [
        "GET",
        "/api/projects/todou/issues",
        { items: [issue], next_cursor: null },
      ],
      ["GET", "/api/projects/todou/references/config", config],
    ]);
    const result = await runCli(["issue", "list", "-p", "todou", "--json"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(result.exitCode).toBe(0);
    expect(
      calls.some((c) => String(c.url).includes("/references/config")),
    ).toBe(true);
  });
});

describe("positional prefix resolution (T-214)", () => {
  const SINCE = "2026-01-01T00:00:00Z";
  const prefixed = (prefix: string | null) => ({
    format: {
      prefix,
      history: prefix === null ? [] : [{ prefix, effective_from: SINCE }],
    },
    autolinks: [],
  });
  const claim = (prefix: string, slug: string) => ({
    prefix,
    slug,
    from: SINCE,
    to: null,
  });
  const directory = (entries: ReturnType<typeof claim>[]) => ({
    since: SINCE,
    entries,
    contested: [],
  });
  const DIRECTORY = directory([claim("T", "todou"), claim("CH", "homelab")]);

  /** Everything `issue view <n>` reads, for one project. */
  function viewRoutes(project: string, number: number): Route[] {
    return [
      [
        "GET",
        `/api/projects/${project}/issues/${number}`,
        { ...issue, number },
      ],
      [
        "GET",
        `/api/projects/${project}/issues/${number}/timeline`,
        { items: [], prev_cursor: null, next_cursor: null },
      ],
      ["PUT", `/api/projects/${project}/issues/${number}/read`, {}],
    ];
  }

  const hit = (calls: { url: string }[], fragment: string) =>
    calls.filter((call) => String(call.url).includes(fragment)).length;

  it("takes this project's own prefix without reading the directory", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ...viewRoutes("todou", 3),
      ["GET", "/api/projects/todou/references/config", prefixed("T")],
      ["GET", "/api/me/reference-directory", DIRECTORY],
    ]);
    const result = await runCli(["issue", "view", "T-3", "-p", "todou"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("T-3 Fix the potato");
    // The budget this rung has to keep: the config was going to be read
    // anyway to spell the header, and the directory is not read at all.
    expect(hit(calls, "/references/config")).toBe(1);
    expect(hit(calls, "/reference-directory")).toBe(0);
  });

  it("resolves a prefix another project holds", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ...viewRoutes("homelab", 5),
      ["GET", "/api/projects/dogfood/references/config", prefixed(null)],
      ["GET", "/api/projects/homelab/references/config", prefixed("CH")],
      ["GET", "/api/me/reference-directory", DIRECTORY],
    ]);
    // No -p: with the flag in play this would (correctly) hit the guard
    // below instead, so the crossing path only exists via an ambient
    // project — TODOU_PROJECT here.
    const result = await runCli(["issue", "view", "CH-5"], {
      fetchImpl,
      env: loggedInEnv("dogfood"),
    });
    expect(result.exitCode).toBe(0);
    expect(hit(calls, "/projects/homelab/issues/5")).toBeGreaterThan(0);
    expect(result.stdout).toContain("CH-5 Fix the potato");
  });

  it("refuses a prefix nobody holds, without reading an issue", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ...viewRoutes("dogfood", 1),
      ["GET", "/api/projects/dogfood/references/config", prefixed(null)],
      ["GET", "/api/me/reference-directory", DIRECTORY],
    ]);
    const result = await runCli(["issue", "view", "FOO-1", "-p", "dogfood"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      'error: no project uses the prefix "FOO" (from "FOO-1")\n' +
        'write this project\'s own card as "#1" or "dogfood/1"; ' +
        "prefixes in reach: CH- (homelab), T- (todou)\n",
    );
    // The refusal has to land before the read: a command that already
    // fetched the wrong card has done the damage this card is about.
    expect(hit(calls, "/projects/dogfood/issues/1")).toBe(0);
  });

  it("refuses when the prefix and -p disagree", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ...viewRoutes("homelab", 5),
      ...viewRoutes("todou", 5),
      ["GET", "/api/projects/todou/references/config", prefixed("T")],
      ["GET", "/api/me/reference-directory", DIRECTORY],
    ]);
    const result = await runCli(["issue", "view", "CH-5", "-p", "todou"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      'error: "CH-5" resolves to project "homelab" (prefix CH), ' +
        'but -p/--project says "todou"\n' +
        'write "todou/5" for this project, or drop -p/--project\n',
    );
    expect(hit(calls, "/issues/5")).toBe(0);
  });

  it("refuses a prefix two projects hold", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/dogfood/references/config", prefixed(null)],
      [
        "GET",
        "/api/me/reference-directory",
        directory([claim("M", "mirror"), claim("M", "muon")]),
      ],
    ]);
    const result = await runCli(["issue", "view", "M-3", "-p", "dogfood"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      'error: prefix "M" is used by more than one project (from "M-3")\n' +
        "write it qualified: mirror/3 or muon/3\n",
    );
  });

  it("refuses a qualified form whose prefix the project never wrote", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ...viewRoutes("todou", 76),
      ["GET", "/api/projects/todou/references/config", prefixed("T")],
    ]);
    const result = await runCli(
      ["issue", "view", "todou/FOO-76", "-p", "todou"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      'error: "todou/FOO-76" says prefix "FOO", but project "todou" ' +
        'writes its issues as "T-76"\n' +
        'write "todou/T-76" or "todou/76"\n',
    );
    expect(hit(calls, "/issues/76")).toBe(0);
  });

  it("keeps the batch's own error when two prefixes disagree", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/dogfood/references/config", prefixed(null)],
      ["GET", "/api/me/reference-directory", DIRECTORY],
    ]);
    const result = await runCli(["issue", "view", "T-1", "CH-2"], {
      fetchImpl,
      env: loggedInEnv("dogfood"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      '"T-1" says project "todou" but "CH-2" says "homelab"',
    );
    expect(result.stderr).toContain("one call reads one project");
  });

  it("does not let --json skip the ladder", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ...viewRoutes("dogfood", 1),
      ["GET", "/api/projects/dogfood/references/config", prefixed(null)],
      ["GET", "/api/me/reference-directory", DIRECTORY],
    ]);
    const result = await runCli(
      ["issue", "view", "FOO-1", "-p", "dogfood", "--json"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('no project uses the prefix "FOO"');
    expect(hit(calls, "/projects/dogfood/issues/1")).toBe(0);
  });

  it("keeps the loose reading when the config cannot be read", async () => {
    // An old server has no config route at all; the T-80 behaviour — take
    // the number, ignore the prefix — has to survive there.
    const { fetchImpl, calls } = fakeFetch(viewRoutes("dogfood", 1));
    const result = await runCli(["issue", "view", "FOO-1", "-p", "dogfood"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("#1 Fix the potato");
    expect(hit(calls, "/reference-directory")).toBe(0);
  });
});
