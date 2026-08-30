import { describe, expect, it } from "vitest";
import { joinSearchTerms, paintSnippet } from "../src/commands/search.ts";
import type { Painter } from "../src/format.ts";
import { fakeFetch, loggedInEnv, type Route, runCli } from "./harness.ts";

const statuses = [
  { id: 1, name: "Todo", category: "open", color: "#6b7280", position: 0 },
  { id: 2, name: "Next", category: "open", color: "#3b82f6", position: 1 },
];
const labels = [{ id: 7, name: "area:cli", color: "#ef4444" }];
const members = [
  {
    id: 2,
    login: "claude",
    display_name: "Claude",
    kind: "machine",
    owner: null,
    role: "writer",
  },
];

const hit = (over: Record<string, unknown> = {}) => ({
  kind: "issue",
  issue: { number: 141, title: "全文搜索", status: statuses[0] },
  comment_id: null,
  spec_path: null,
  field: "title",
  snippet: { text: "增加项目内全文搜索功能", ranges: [[5, 9]] },
  updated_at: "2026-08-30T08:00:00Z",
  ...over,
});

const refConfig = { format: { prefix: "T", history: [] }, autolinks: [] };

function routes(page: unknown, extra: Route[] = []): Route[] {
  return [
    ["GET", "/api/projects/todou/references/config", refConfig],
    ["GET", "/api/projects/todou/search", page],
    ...extra,
  ];
}

describe("todou search", () => {
  it("prints one line per hit, with the locator and a count", async () => {
    const { fetchImpl, calls } = fakeFetch(
      routes({
        items: [
          hit(),
          hit({
            kind: "comment",
            comment_id: 88,
            field: "body",
            snippet: { text: "实测：全文搜索走 GIN", ranges: [[3, 7]] },
          }),
          hit({
            kind: "spec",
            spec_path: "design.md",
            field: "body",
            snippet: { text: "全文搜索的定稿", ranges: [[0, 4]] },
          }),
        ],
        has_more: false,
      }),
    );
    const res = await runCli(["search", "全文搜索"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(res.exitCode).toBe(0);
    const lines = res.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^T-141\s+issue\s+增加项目内全文搜索功能$/);
    expect(lines[1]).toMatch(/^T-141\s+comment 88\s+实测：全文搜索走 GIN$/);
    expect(lines[2]).toMatch(/^T-141\s+spec design\.md\s+全文搜索的定稿$/);
    expect(lines[3]).toBe("3 hits");

    const url = new URL(
      calls.find((c) => c.url.includes("/search"))?.url as string,
      "http://stub.test",
    );
    expect(url.searchParams.get("q")).toBe("全文搜索");
    expect(url.searchParams.get("in")).toBeNull();
  });

  it("exits 0 on no matches", async () => {
    const { fetchImpl } = fakeFetch(routes({ items: [], has_more: false }));
    const res = await runCli(["search", "nothing"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("no matches\n");
  });

  it("says when the page was cut short", async () => {
    const { fetchImpl } = fakeFetch(routes({ items: [hit()], has_more: true }));
    const res = await runCli(["search", "x", "-L", "1"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(res.stdout.trimEnd().split("\n").at(-1)).toBe(
      "1 hit shown · more available (raise --limit)",
    );
  });

  it("is reachable as `issue search` too", async () => {
    const { fetchImpl } = fakeFetch(
      routes({ items: [hit()], has_more: false }),
    );
    const res = await runCli(["issue", "search", "全文搜索"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("T-141");
  });

  it("sends every term, quoting the ones the shell kept together", async () => {
    const { fetchImpl, calls } = fakeFetch(
      routes({ items: [], has_more: false }),
    );
    await runCli(["search", "cursor", "中文 分词"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    const url = new URL(
      calls.find((c) => c.url.includes("/search"))?.url as string,
      "http://stub.test",
    );
    expect(url.searchParams.get("q")).toBe('cursor "中文 分词"');
  });

  it("resolves --in, --status, --label and --assignee to ids", async () => {
    const { fetchImpl, calls } = fakeFetch(
      routes({ items: [], has_more: false }, [
        ["GET", "/api/projects/todou/statuses", statuses],
        ["GET", "/api/projects/todou/labels", labels],
        ["GET", "/api/projects/todou/members", members],
        // `@me` resolves through the account, not the member list.
        ["GET", "/api/me", members[0]],
      ]),
    );
    const res = await runCli(
      [
        "search",
        "x",
        "--in",
        "comments,specs",
        "--status",
        "Next",
        "--label",
        "area:cli",
        "--assignee",
        "@me",
      ],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(res.exitCode).toBe(0);
    const url = new URL(
      calls.find((c) => c.url.includes("/search"))?.url as string,
      "http://stub.test",
    );
    expect(url.searchParams.get("in")).toBe("comments,specs");
    expect(url.searchParams.get("status")).toBe("2");
    expect(url.searchParams.get("label")).toBe("7");
    expect(url.searchParams.get("assignee")).toBe("2");
  });

  it("rejects an unknown domain before making a request", async () => {
    const { fetchImpl, calls } = fakeFetch(
      routes({ items: [], has_more: false }),
    );
    const res = await runCli(["search", "x", "--in", "events"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("--in must be one of");
    expect(calls.some((c) => c.url.includes("/search"))).toBe(false);
  });

  it("spells the ref on every item under --json", async () => {
    const { fetchImpl } = fakeFetch(
      routes({ items: [hit()], has_more: false }),
    );
    const res = await runCli(["search", "x", "--json"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    const doc = JSON.parse(res.stdout);
    expect(doc.items[0].issue.ref).toBe("T-141");
    expect(doc.items[0].issue.number).toBe(141);
    expect(doc.ref_format).toEqual({ prefix: "T", token: "T-" });
    expect(doc.has_more).toBe(false);
  });
});

describe("joinSearchTerms", () => {
  it("leaves single words alone", () => {
    expect(joinSearchTerms(["a", "b"])).toBe("a b");
  });

  it("re-quotes a term the shell already unquoted", () => {
    expect(joinSearchTerms(["a b", "c"])).toBe('"a b" c');
  });
});

describe("paintSnippet", () => {
  const paint: Painter = (_style, text) => `[${text}]`;

  it("marks every range", () => {
    expect(
      paintSnippet(
        {
          text: "alpha beta alpha",
          ranges: [[0, 5] as [number, number], [11, 16]],
        },
        paint,
      ),
    ).toBe("[alpha] beta [alpha]");
  });

  it("skips a range already covered by the one before it", () => {
    // Two terms hitting the same run — "search" and "searching" both start
    // at 0, and painting the second from behind the cursor would duplicate
    // the text it already emitted.
    expect(
      paintSnippet(
        { text: "searching", ranges: [[0, 9] as [number, number], [0, 6]] },
        paint,
      ),
    ).toBe("[searching]");
  });

  it("returns the text untouched when nothing matched", () => {
    expect(paintSnippet({ text: "plain", ranges: [] }, paint)).toBe("plain");
  });
});
