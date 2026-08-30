import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fakeFetch, loggedInEnv, type Route, runCli } from "./harness.ts";

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
  { id: 3, name: "Wontfix", category: "closed", color: "#ef4444", position: 2 },
];
const labels = [
  { id: 7, name: "bug", color: "#ef4444" },
  { id: 8, name: "chore", color: "#3b82f6" },
];

function issueWith(overrides: Record<string, unknown>) {
  return {
    id: 11,
    number: 3,
    title: "Fix the potato",
    body: "",
    status: statuses[0],
    author: me,
    assignees: [],
    labels: [],
    created_at: "2026-08-11T10:00:00Z",
    updated_at: "2026-08-11T11:00:00Z",
    ...overrides,
  };
}

function jsonBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("issue create", () => {
  it("resolves names and posts the full input", async () => {
    let posted: Record<string, unknown> | undefined;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/statuses", statuses],
      ["GET", "/api/projects/todou/labels", labels],
      ["GET", "/api/me", me],
      [
        "POST",
        "/api/projects/todou/issues",
        (init: RequestInit) => {
          posted = jsonBody(init);
          return issueWith({ title: "New one", number: 9 });
        },
      ],
    ]);
    const result = await runCli(
      [
        "issue",
        "create",
        "--title",
        "New one",
        "--body",
        "hello",
        "--label",
        "bug",
        "--assignee",
        "me",
        "--status",
        "todo",
      ],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    expect(posted).toEqual({
      title: "New one",
      body: "hello",
      status_id: 1,
      label_ids: [7],
      assignee_ids: [2],
    });
    expect(result.stdout).toBe("#9 created: New one\n");
  });

  it("reads the body from stdin via --body-file -", async () => {
    let posted: Record<string, unknown> | undefined;
    const { fetchImpl } = fakeFetch([
      [
        "POST",
        "/api/projects/todou/issues",
        (init: RequestInit) => {
          posted = jsonBody(init);
          return issueWith({});
        },
      ],
    ]);
    const result = await runCli(
      ["issue", "create", "--title", "T", "--body-file", "-"],
      { fetchImpl, env: loggedInEnv("todou"), stdinText: "piped body" },
    );
    expect(result.exitCode).toBe(0);
    expect(posted?.body).toBe("piped body");
  });

  it("fails without a body when stdin is not a TTY", async () => {
    const { fetchImpl } = fakeFetch([]);
    const result = await runCli(["issue", "create", "--title", "T"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no body given");
  });
});

describe("issue edit", () => {
  it("read-modify-writes labels and assignees", async () => {
    let patched: Record<string, unknown> | undefined;
    const current = issueWith({
      labels: [labels[0]],
      assignees: [me],
    });
    const members = [
      { user: me, role: "writer", created_at: "2026-08-11T00:00:00Z" },
      {
        user: { ...me, id: 1, login: "user", kind: "human" },
        role: "admin",
        created_at: "2026-08-11T00:00:00Z",
      },
    ];
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", current],
      ["GET", "/api/projects/todou/labels", labels],
      ["GET", "/api/projects/todou/members", members],
      [
        "PATCH",
        "/api/projects/todou/issues/3",
        (init: RequestInit) => {
          patched = jsonBody(init);
          return issueWith({ labels });
        },
      ],
    ]);
    const result = await runCli(
      [
        "issue",
        "edit",
        "3",
        "--add-label",
        "chore",
        "--remove-label",
        "bug",
        "--add-assignee",
        "user",
        "--remove-assignee",
        "claude",
      ],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    expect(patched).toEqual({ label_ids: [8], assignee_ids: [1] });
  });

  it("rejects an empty edit", async () => {
    const { fetchImpl } = fakeFetch([]);
    const result = await runCli(["issue", "edit", "3"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("nothing to change");
  });

  it("lets a project/number ref override TODOU_PROJECT", async () => {
    let patched: Record<string, unknown> | undefined;
    const { fetchImpl } = fakeFetch([
      [
        "PATCH",
        "/api/projects/todou/issues/3",
        (init: RequestInit) => {
          patched = jsonBody(init);
          return issueWith({ title: "Renamed" });
        },
      ],
    ]);
    const result = await runCli(
      ["issue", "edit", "todou/3", "--title", "Renamed"],
      { fetchImpl, env: loggedInEnv("dogfood") },
    );
    expect(result.exitCode).toBe(0);
    expect(patched).toEqual({ title: "Renamed" });
  });
});

describe("issue update/status/move", () => {
  it("routes `issue update` to the same edit", async () => {
    const patched: Array<Record<string, unknown>> = [];
    const { fetchImpl } = fakeFetch([
      [
        "PATCH",
        "/api/projects/todou/issues/3",
        (init: RequestInit) => {
          patched.push(jsonBody(init));
          return issueWith({ title: "Renamed" });
        },
      ],
    ]);
    for (const verb of ["edit", "update"]) {
      const result = await runCli(["issue", verb, "3", "-t", "Renamed"], {
        fetchImpl,
        env: loggedInEnv("todou"),
      });
      expect(result.exitCode).toBe(0);
    }
    expect(patched).toEqual([{ title: "Renamed" }, { title: "Renamed" }]);
  });

  it("takes the status as a second positional", async () => {
    let patched: Record<string, unknown> | undefined;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/statuses", statuses],
      [
        "PATCH",
        "/api/projects/todou/issues/3",
        (init: RequestInit) => {
          patched = jsonBody(init);
          return issueWith({ status: statuses[1] });
        },
      ],
    ]);
    const result = await runCli(["issue", "status", "3", "Done"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(patched).toEqual({ status_id: 2 });
    expect(result.stdout.trim()).toBe("#3 updated");
  });

  it("answers to `issue move` as well", async () => {
    let patched: Record<string, unknown> | undefined;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/statuses", statuses],
      [
        "PATCH",
        "/api/projects/todou/issues/3",
        (init: RequestInit) => {
          patched = jsonBody(init);
          return issueWith({});
        },
      ],
    ]);
    const result = await runCli(["issue", "move", "3", "Todo"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(patched).toEqual({ status_id: 1 });
  });

  it("refuses an unknown status the way `edit --status` does", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/statuses", statuses],
    ]);
    const result = await runCli(["issue", "status", "3", "Nope"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown status "Nope"');
    expect(result.stderr).toContain("available: Todo, Done, Wontfix");
  });
});

describe("issue close", () => {
  it("comments first, then moves to the first closed status", async () => {
    const order: string[] = [];
    let patched: Record<string, unknown> | undefined;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/statuses", statuses],
      [
        "POST",
        "/api/projects/todou/issues/3/comments",
        (init: RequestInit) => {
          order.push("comment");
          return {
            type: "comment",
            id: 1,
            author: me,
            body: jsonBody(init).body,
            created_at: "2026-08-11T12:00:00Z",
            edited_at: null,
          };
        },
      ],
      [
        "PATCH",
        "/api/projects/todou/issues/3",
        (init: RequestInit) => {
          order.push("close");
          patched = jsonBody(init);
          return issueWith({ status: statuses[1] });
        },
      ],
    ]);
    const result = await runCli(
      ["issue", "close", "3", "--comment", "done here"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    expect(order).toEqual(["comment", "close"]);
    expect(patched).toEqual({ status_id: 2 });
    expect(result.stdout).toBe("#3 closed (Done)\n");
  });

  it("honors --status for a different closed status", async () => {
    let patched: Record<string, unknown> | undefined;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/statuses", statuses],
      [
        "PATCH",
        "/api/projects/todou/issues/3",
        (init: RequestInit) => {
          patched = jsonBody(init);
          return issueWith({ status: statuses[2] });
        },
      ],
    ]);
    const result = await runCli(
      ["issue", "close", "3", "--status", "wontfix"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    expect(patched).toEqual({ status_id: 3 });
  });

  it("accepts a #-prefixed number", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/statuses", statuses],
      [
        "PATCH",
        "/api/projects/todou/issues/3",
        () => issueWith({ status: statuses[1] }),
      ],
    ]);
    const result = await runCli(["issue", "close", "#3"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("#3 closed (Done)\n");
  });
});

describe("comment add", () => {
  it("posts the body and reports the issue number", async () => {
    let posted: Record<string, unknown> | undefined;
    const { fetchImpl } = fakeFetch([
      [
        "POST",
        "/api/projects/todou/issues/7/comments",
        (init: RequestInit) => {
          posted = jsonBody(init);
          return {
            type: "comment",
            id: 1,
            author: me,
            body: posted.body,
            created_at: "2026-08-11T12:00:00Z",
            edited_at: null,
          };
        },
      ],
    ]);
    const result = await runCli(["comment", "add", "7", "--body", "a note"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(posted).toEqual({ body: "a note" });
    expect(result.stdout).toBe("comment 1 on #7 (#comment-1)\n");
  });

  it("keeps the --json envelope free of the echoed id line", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "POST",
        "/api/projects/todou/issues/7/comments",
        (init: RequestInit) => ({
          type: "comment",
          id: 757,
          author: me,
          body: jsonBody(init).body,
          created_at: "2026-08-11T12:00:00Z",
          edited_at: null,
        }),
      ],
    ]);
    const result = await runCli(
      ["comment", "add", "7", "--body", "a note", "--json"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: 757,
      issue_number: 7,
      issue_ref: "#7",
    });
  });

  it("supports the issue comment alias with a project/number ref", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "POST",
        "/api/projects/todou/issues/7/comments",
        (init: RequestInit) => ({
          type: "comment",
          id: 1,
          author: me,
          body: jsonBody(init).body,
          created_at: "2026-08-11T12:00:00Z",
          edited_at: null,
        }),
      ],
    ]);
    const result = await runCli(
      ["issue", "comment", "todou/7", "--body", "a note"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("comment 1 on #7 (#comment-1)\n");
  });
});

/** T-182: the reply to a comment is what follows the comment's own position. */
describe("comment add cursor", () => {
  const CURSOR = "3:hlsw2ffv8g.0.5k";
  const created: Route = [
    "POST",
    "/api/projects/todou/issues/7/comments",
    (init: RequestInit) => ({
      type: "comment",
      id: 51,
      author: me,
      body: jsonBody(init).body,
      created_at: "2026-08-11T12:00:00Z",
      edited_at: null,
      cursor: CURSOR,
    }),
  ];
  const reply = {
    type: "comment",
    id: 52,
    author: { id: 3, login: "user", display_name: "User", kind: "human" },
    body: "answered elsewhere already",
    component: null,
    created_at: "2026-08-11T11:00:00Z",
    edited_at: null,
    resolved_at: null,
    agent_context: null,
  };

  const add = async (argv: string[], routes: Route[] = []) => {
    const { fetchImpl, calls } = fakeFetch([created, ...routes]);
    const run = await runCli(
      ["comment", "add", "7", "--body", "a note", ...argv],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    return { run, calls };
  };

  it("closes the human output with the cursor to wait from", async () => {
    const { run } = await add([]);
    expect(run.stdout).toBe(
      `comment 51 on #7 (#comment-51)\ncursor: ${CURSOR} (issue watch --since <cursor>)\n`,
    );
  });

  it("--print-cursor leaves stdout to the cursor and nothing else", async () => {
    const { run } = await add(["--print-cursor"]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe(`${CURSOR}\n`);
    expect(run.stderr).toContain("comment 51 on #7");
  });

  it("--print-cursor and --json both want stdout, so nothing is posted", async () => {
    const { run, calls } = await add(["--print-cursor", "--json"]);
    expect(run.exitCode).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("--since echoes the cursor and reports what it had not seen", async () => {
    const { run } = await add(
      ["--json", "--since", "3:old.0.1"],
      [
        ["GET", "/api/me", me],
        [
          "GET",
          "/api/projects/todou/issues/7/timeline",
          { items: [reply], next_cursor: "3:z.0.34" },
        ],
      ],
    );
    const parsed = JSON.parse(run.stdout);
    expect(parsed.cursor).toBe("3:old.0.1");
    expect(parsed.missed.map((i: { id: number }) => i.id)).toEqual([52]);
  });
});

describe("comment edit", () => {
  it("patches the body and reports the comment", async () => {
    let patched: Record<string, unknown> | undefined;
    const { fetchImpl } = fakeFetch([
      [
        "PATCH",
        "/api/projects/todou/issues/7/comments/12",
        (init: RequestInit) => {
          patched = jsonBody(init);
          return {
            type: "comment",
            id: 12,
            author: me,
            body: patched.body,
            created_at: "2026-08-11T12:00:00Z",
            edited_at: "2026-08-11T13:00:00Z",
          };
        },
      ],
    ]);
    const result = await runCli(
      ["comment", "edit", "7", "12", "--body", "fixed note"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    expect(patched).toEqual({ body: "fixed note" });
    expect(result.stdout).toBe("edited comment 12 on #7\n");
  });

  it("rejects a non-numeric comment id", async () => {
    const { fetchImpl } = fakeFetch([]);
    const result = await runCli(
      ["comment", "edit", "7", "abc", "--body", "x"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("comment id");
  });
});

describe("label create/edit/delete", () => {
  it("creates with an optional color", async () => {
    let posted: Record<string, unknown> | undefined;
    const { fetchImpl } = fakeFetch([
      [
        "POST",
        "/api/projects/todou/labels",
        (init: RequestInit) => {
          posted = jsonBody(init);
          return { id: 9, name: "urgent", color: "#ff0000" };
        },
      ],
    ]);
    const result = await runCli(
      ["label", "create", "--name", "urgent", "--color", "#ff0000"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    expect(posted).toEqual({ name: "urgent", color: "#ff0000" });
  });

  it("edits by resolved id", async () => {
    let patched: Record<string, unknown> | undefined;
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/projects/todou/labels", labels],
      [
        "PATCH",
        "/api/projects/todou/labels/7",
        (init: RequestInit) => {
          patched = jsonBody(init);
          return { id: 7, name: "defect", color: "#ef4444" };
        },
      ],
    ]);
    const result = await runCli(["label", "edit", "bug", "--name", "defect"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(patched).toEqual({ name: "defect" });
    expect(calls.some((c) => c.url.includes("/labels/7"))).toBe(true);
  });

  it("deletes by resolved id and keeps stdout clean", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/projects/todou/labels", labels],
      ["DELETE", "/api/projects/todou/labels/8", { __status: 204 }],
    ]);
    const result = await runCli(["label", "delete", "chore"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("deleted label chore");
    expect(calls.at(-1)?.init.method).toBe("DELETE");
  });
});

describe("attach", () => {
  const dir = mkdtempSync(join(tmpdir(), "todou-attach-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("uploads each file as multipart form data", async () => {
    const file = join(dir, "note.txt");
    writeFileSync(file, "attachment payload");
    const seen: Array<{
      filename: string;
      issueNumber: string;
      type: string;
    }> = [];
    const { fetchImpl } = fakeFetch([
      [
        "POST",
        "/api/projects/todou/attachments/direct-uploads",
        // The stub plays an fs-backend server: the client probes once,
        // hears the dedicated code, and falls back to multipart.
        {
          __status: 409,
          body: { error: { code: "direct_upload_unavailable" } },
        },
      ],
      [
        "POST",
        "/api/projects/todou/attachments",
        (init: RequestInit) => {
          const form = init.body as FormData;
          const upload = form.get("file") as File;
          seen.push({
            filename: upload.name,
            issueNumber: String(form.get("issue_number")),
            type: upload.type,
          });
          return {
            id: seen.length,
            filename: upload.name,
            content_type: "text/plain",
            size: 18,
            url: `/attachments/${upload.name}`,
            uploader: me,
            created_at: "2026-08-11T12:00:00Z",
          };
        },
      ],
    ]);
    const result = await runCli(["attach", "3", file], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual([
      { filename: "note.txt", issueNumber: "3", type: "text/plain" },
    ]);
    expect(result.stdout).toBe("#1 note.txt → /attachments/note.txt\n");
  });

  it("fails on an unreadable file", async () => {
    const { fetchImpl } = fakeFetch([]);
    const result = await runCli(["attach", "3", join(dir, "missing.bin")], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cannot read");
  });

  it("stops at the size probe's 422 without a multipart fallback", async () => {
    const file = join(dir, "big.bin");
    writeFileSync(file, "stand-in for an oversize file");
    const { fetchImpl, calls } = fakeFetch([
      [
        "POST",
        "/api/projects/todou/attachments/direct-uploads",
        // Servers answer the size gate before the backend gate (T-70), so
        // this 422 arrives on fs backends too — before any body is sent.
        {
          __status: 422,
          body: {
            error: {
              code: "validation_failed",
              message: "file exceeds the 20 MB upload limit",
            },
          },
        },
      ],
    ]);
    const result = await runCli(["attach", "3", file], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("file exceeds the 20 MB upload limit");
    expect(calls).toHaveLength(1);
  });

  it("accepts a project/number ref", async () => {
    const file = join(dir, "ref.txt");
    writeFileSync(file, "x");
    const { fetchImpl } = fakeFetch([
      [
        "POST",
        "/api/projects/todou/attachments/direct-uploads",
        // The stub plays an fs-backend server: the client probes once,
        // hears the dedicated code, and falls back to multipart.
        {
          __status: 409,
          body: { error: { code: "direct_upload_unavailable" } },
        },
      ],
      [
        "POST",
        "/api/projects/todou/attachments",
        (init: RequestInit) => {
          const upload = (init.body as FormData).get("file") as File;
          return {
            id: 1,
            filename: upload.name,
            content_type: "text/plain",
            size: 1,
            url: `/attachments/${upload.name}`,
            uploader: me,
            created_at: "2026-08-11T12:00:00Z",
          };
        },
      ],
    ]);
    const result = await runCli(["attach", "todou/3", file], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("#1 ref.txt → /attachments/ref.txt\n");
  });

  it("keeps the --json envelope free of the id prefix", async () => {
    const file = join(dir, "envelope.txt");
    writeFileSync(file, "x");
    const { fetchImpl } = fakeFetch([
      [
        "POST",
        "/api/projects/todou/attachments/direct-uploads",
        {
          __status: 409,
          body: { error: { code: "direct_upload_unavailable" } },
        },
      ],
      [
        "POST",
        "/api/projects/todou/attachments",
        (init: RequestInit) => {
          const upload = (init.body as FormData).get("file") as File;
          return {
            id: 12,
            filename: upload.name,
            content_type: "text/plain",
            size: 1,
            url: `/attachments/${upload.name}`,
            uploader: me,
            created_at: "2026-08-11T12:00:00Z",
          };
        },
      ],
    ]);
    const result = await runCli(["attach", "3", file, "--json"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject([
      { id: 12, filename: "envelope.txt", url: "/attachments/envelope.txt" },
    ]);
  });
});
