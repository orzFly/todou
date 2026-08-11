import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fakeFetch, loggedInEnv, runCli } from "./harness.ts";

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
    expect(result.stdout).toBe("commented on #7\n");
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
    const seen: Array<{ filename: string; issueNumber: string }> = [];
    const { fetchImpl } = fakeFetch([
      [
        "POST",
        "/api/projects/todou/attachments",
        (init: RequestInit) => {
          const form = init.body as FormData;
          const upload = form.get("file") as File;
          seen.push({
            filename: upload.name,
            issueNumber: String(form.get("issue_number")),
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
    expect(seen).toEqual([{ filename: "note.txt", issueNumber: "3" }]);
    expect(result.stdout).toBe("note.txt → /attachments/note.txt\n");
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
});
