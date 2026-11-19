import type { TimelineEvent } from "@todou/shared";
import { describe, expect, it } from "vitest";
import type { Painter } from "../src/format.ts";
import {
  type ActivityLineContext,
  renderActivityLine,
  renderTimelineItem,
} from "../src/timeline.ts";
import { fakeFetch, loggedInEnv, type Route, runCli } from "./harness.ts";

// T-785: every human-readable place a title goes says "(no title given)" for
// an untitled card, and never wraps it in quotes as if it were the title.

const NO_TITLE = "(no title given)";
const env = loggedInEnv("todou");
const me = {
  id: 2,
  login: "claude",
  display_name: "Claude",
  kind: "machine",
  avatar_url: null,
  owner: null,
};
const status = {
  id: 1,
  name: "Todo",
  category: "open",
  color: "#6b7280",
  position: 0,
};
const untitled = (over: Record<string, unknown> = {}) => ({
  id: 11,
  number: 3,
  title: "",
  body_preview: "Crash on save",
  body: "# Crash on save",
  status,
  author: me,
  assignees: [],
  labels: [],
  created_at: "2026-08-11T10:00:00Z",
  updated_at: "2026-08-11T11:00:00Z",
  body_edited_at: null,
  spec_version: null,
  spec_review_status: null,
  spec_unresolved_comments: 0,
  deleted_at: null,
  deleted_by: null,
  ...over,
});
const body = (init: RequestInit) =>
  JSON.parse(String(init.body)) as Record<string, unknown>;

describe("untitled cards in command output (T-785)", () => {
  it("issue list prints the placeholder in the title column", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/todou/issues",
        { items: [untitled()], next_cursor: null },
      ],
    ]);
    const res = await runCli(["issue", "list"], { fetchImpl, env });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/#3\s+\(no title given\)\s+Todo/);
  });

  it("issue list --json passes the empty title through", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/todou/issues",
        { items: [untitled()], next_cursor: null },
      ],
    ]);
    const res = await runCli(["issue", "list", "--json"], { fetchImpl, env });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain(NO_TITLE);
    expect(JSON.parse(res.stdout).items[0].title).toBe("");
  });

  it("issue view heads the card with the placeholder", async () => {
    const card = "/api/projects/todou/issues/3";
    const { fetchImpl } = fakeFetch([
      ["GET", card, untitled()],
      ["PUT", `${card}/read`, {}],
    ]);
    const res = await runCli(["issue", "view", "3", "--brief"], {
      fetchImpl,
      env,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.split("\n")[0]).toBe(`#3 ${NO_TITLE}`);
  });

  it("issue create takes a body alone and prints the placeholder", async () => {
    let posted: Record<string, unknown> | undefined;
    const { fetchImpl } = fakeFetch([
      [
        "POST",
        "/api/projects/todou/issues",
        (init: RequestInit) => {
          posted = body(init);
          return untitled({ number: 9 });
        },
      ],
    ]);
    const res = await runCli(["issue", "create", "--body", "# Crash on save"], {
      fetchImpl,
      env,
    });
    expect(res.exitCode).toBe(0);
    expect(posted?.title).toBe("");
    expect(posted?.body).toBe("# Crash on save");
    expect(res.stdout).toBe(`#9 created: ${NO_TITLE}\n`);
  });

  it('issue edit --title "" sends an empty title', async () => {
    let patched: Record<string, unknown> | undefined;
    const { fetchImpl } = fakeFetch([
      [
        "PATCH",
        "/api/projects/todou/issues/3",
        (init: RequestInit) => {
          patched = body(init);
          return untitled();
        },
      ],
    ]);
    const res = await runCli(["issue", "edit", "3", "--title", ""], {
      fetchImpl,
      env,
    });
    expect(res.exitCode).toBe(0);
    expect(patched).toEqual({ title: "" });
  });

  it("the trash prompt names the card without quoting the placeholder", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", untitled()],
      ["GET", "/api/projects/todou/references/config", { __status: 404 }],
    ]);
    const res = await runCli(["issue", "delete", "3"], {
      fetchImpl,
      env,
      stdinIsTTY: true,
      stdinText: "n\n",
    });
    expect(res.stderr).toContain(`Move #3 ${NO_TITLE} to the trash?`);
    expect(res.stderr).not.toContain('""');
  });

  it("issue refs prints the placeholder for an untitled target", async () => {
    const routes: Route[] = [
      [
        "GET",
        "/api/projects/todou/issues/16/references",
        {
          linked_from: [
            {
              project_id: 2,
              number: 5,
              comment_id: null,
              more: 0,
              created_at: "2026-09-01T00:00:00.000Z",
            },
          ],
          links_to: [],
        },
      ],
      ["GET", "/api/projects", [{ id: 2, slug: "todou" }]],
      [
        "GET",
        "/api/projects/todou/references/config",
        { format: { prefix: "T", history: [] }, autolinks: [] },
      ],
      [
        "GET",
        "/api/projects/todou/issues",
        { items: [{ number: 5, title: "" }], next_cursor: null },
      ],
    ];
    const { fetchImpl } = fakeFetch(routes);
    const res = await runCli(["issue", "refs", "16"], { fetchImpl, env });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(`  T-5  ${NO_TITLE}  (body)`);
  });

  it("spec list prints the placeholder in the title column", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/todou/issues",
        {
          items: [
            untitled({ spec_version: 2, spec_review_status: "approved" }),
          ],
          next_cursor: null,
        },
      ],
    ]);
    const res = await runCli(["spec", "list"], { fetchImpl, env });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/#3\s+\(no title given\)\s+Todo\s+v2/);
  });

  it("a moved-away untitled card is named 'this issue'", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/todou/issues/3",
        { __status: 410, body: { moved: true, title: "" } },
      ],
    ]);
    const res = await runCli(["issue", "view", "3"], { fetchImpl, env });
    expect(res.stderr).toContain(
      "error: this issue moved to a project you cannot read",
    );
  });

  it("project edit --require-title / --no-require-title are tri-state", async () => {
    const patches: Array<Record<string, unknown>> = [];
    const routes = (): Route[] => [
      [
        "PATCH",
        "/api/projects/acme",
        (init: RequestInit) => {
          patches.push(body(init));
          return { id: 1, slug: "acme", name: "Acme", description: "" };
        },
      ],
    ];
    for (const flag of ["--require-title", "--no-require-title"]) {
      const { fetchImpl } = fakeFetch(routes());
      const res = await runCli(["project", "edit", "acme", flag], {
        fetchImpl,
        env: loggedInEnv(),
      });
      expect(res.exitCode).toBe(0);
    }
    const { fetchImpl } = fakeFetch(routes());
    await runCli(["project", "edit", "acme", "--name", "Acme"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(patches).toEqual([
      { require_title: true },
      { require_title: false },
      { name: "Acme" },
    ]);
  });
});

describe("untitled cards in timeline lines (T-785)", () => {
  const paint: Painter = (_style, text) => text;
  const author = {
    id: 5,
    login: "user",
    display_name: "User",
    kind: "human" as const,
    avatar_url: null,
    owner: null,
  };
  const event = (over: Partial<TimelineEvent>): TimelineEvent => ({
    type: "event",
    id: 901,
    event_type: "opened",
    actor: author,
    payload: {},
    created_at: "2026-08-11T12:00:00.000Z",
    agent_context: null,
    ...over,
  });
  const ctx: ActivityLineContext = {
    refLabel: "T-146",
    issueNumber: 146,
    refPrefix: "T",
    summaryChars: 0,
    project: "todou",
    projectId: 2,
    slugOfProject: (id) => (id === 2 ? "todou" : null),
    cardOf: () => ({ title: "", body: "first line" }),
  };

  it("opened", () => {
    const line = renderActivityLine(event({}), paint, ctx);
    expect(line).toMatch(
      /^T-146 @user \(User\) opened \(no title given\) .+: first line$/,
    );
    expect(line).not.toContain('""');
  });

  it("by T-N", () => {
    const line = renderActivityLine(
      event({
        event_type: "referenced",
        payload: { by_project_id: 2, by_issue: 281 },
      }),
      paint,
      ctx,
    );
    expect(line).toContain(`(by T-281 ${NO_TITLE})`);
    expect(line).not.toContain('""');
  });

  it.each([
    [{ from: "", to: "Named" }, `${NO_TITLE} → "Named"`],
    [{ from: "Named", to: "" }, `"Named" → ${NO_TITLE}`],
  ])("title_changed %j", (payload, words) => {
    const item = event({ event_type: "title_changed", payload });
    expect(renderTimelineItem(item, paint, ctx)).toContain(`renamed ${words}`);
    expect(renderActivityLine(item, paint, ctx)).toContain(
      `title_changed (${words})`,
    );
    expect(renderTimelineItem(item, paint, ctx)).not.toContain('""');
  });
});
