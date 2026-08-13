import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors.ts";
import { drainPaged, MAX_DRAIN_PAGES } from "../src/paginate.ts";
import { fakeFetch, loggedInEnv, runCli } from "./harness.ts";

type Page = { items: number[]; next_cursor: string | null; has_more?: boolean };

/** fetchPage stub that serves `pages` in order and counts calls. */
function scripted(pages: Page[]) {
  let calls = 0;
  const fetchPage = (_after: string | undefined): Promise<Page> => {
    const page = pages[Math.min(calls, pages.length - 1)] as Page;
    calls += 1;
    return Promise.resolve(page);
  };
  return { fetchPage, calls: () => calls };
}

describe("drainPaged", () => {
  it("stitches pages and lands the cursor on the newest entry", async () => {
    const { fetchPage, calls } = scripted([
      { items: [1, 2], next_cursor: "c1" },
      { items: [3], next_cursor: "c2" },
      { items: [], next_cursor: null },
    ]);
    const result = await drainPaged("timeline", undefined, fetchPage);
    expect(result.items).toEqual([1, 2, 3]);
    expect(result.cursor).toBe("c2");
    expect(calls()).toBe(3);
  });

  it("keeps the baseline cursor when nothing was new", async () => {
    const { fetchPage, calls } = scripted([{ items: [], next_cursor: null }]);
    const result = await drainPaged("timeline", "c9", fetchPage);
    expect(result.items).toEqual([]);
    expect(result.cursor).toBe("c9");
    expect(calls()).toBe(1);
  });

  it("tolerates a non-empty page with no cursor (keeps its items)", async () => {
    const { fetchPage, calls } = scripted([{ items: [1], next_cursor: null }]);
    const result = await drainPaged("timeline", "c0", fetchPage);
    expect(result.items).toEqual([1]);
    expect(result.cursor).toBe("c0");
    expect(calls()).toBe(1);
  });

  it("stops when the cursor stalls, dropping the not-after page", async () => {
    const { fetchPage, calls } = scripted([
      { items: [1], next_cursor: "c1" },
      { items: [2], next_cursor: "c1" },
    ]);
    const result = await drainPaged("timeline", undefined, fetchPage);
    expect(result.items).toEqual([1]);
    expect(result.cursor).toBe("c1");
    expect(calls()).toBe(2);
  });

  it("stops immediately when a resume's first page stalls", async () => {
    const { fetchPage, calls } = scripted([{ items: [9], next_cursor: "c1" }]);
    const result = await drainPaged("timeline", "c1", fetchPage);
    expect(result.items).toEqual([]);
    expect(result.cursor).toBe("c1");
    expect(calls()).toBe(1);
  });

  it("stops on an empty page without adopting its bogus cursor", async () => {
    const { fetchPage, calls } = scripted([{ items: [], next_cursor: "c5" }]);
    const result = await drainPaged("timeline", "c0", fetchPage);
    expect(result.items).toEqual([]);
    expect(result.cursor).toBe("c0");
    expect(calls()).toBe(1);
  });

  it("gives up loudly on ever-fresh cursors instead of looping", async () => {
    let calls = 0;
    const fetchPage = (): Promise<Page> => {
      calls += 1;
      return Promise.resolve({ items: [calls], next_cursor: `c${calls}` });
    };
    const drained = drainPaged("timeline", undefined, fetchPage);
    await expect(drained).rejects.toThrowError(CliError);
    await expect(drained).rejects.toThrowError(
      `giving up after ${MAX_DRAIN_PAGES} timeline pages — the server keeps returning another next_cursor`,
    );
    expect(calls).toBe(MAX_DRAIN_PAGES);
  });

  it("ends on has_more=false without the trailing empty-page request", async () => {
    const { fetchPage, calls } = scripted([
      { items: [1, 2], next_cursor: "c1", has_more: true },
      { items: [3], next_cursor: "c2", has_more: false },
    ]);
    const result = await drainPaged("timeline", undefined, fetchPage);
    expect(result.items).toEqual([1, 2, 3]);
    expect(result.cursor).toBe("c2");
    expect(calls()).toBe(2);
  });

  it("still stops on a stalled cursor when has_more promises more", async () => {
    const { fetchPage, calls } = scripted([
      { items: [1], next_cursor: "c1", has_more: true },
      { items: [2], next_cursor: "c1", has_more: true },
    ]);
    const result = await drainPaged("timeline", undefined, fetchPage);
    expect(result.items).toEqual([1]);
    expect(result.cursor).toBe("c1");
    expect(calls()).toBe(2);
  });

  it("caps ever-fresh cursors even when has_more stays true", async () => {
    let calls = 0;
    const fetchPage = (): Promise<Page> => {
      calls += 1;
      return Promise.resolve({
        items: [calls],
        next_cursor: `c${calls}`,
        has_more: true,
      });
    };
    await expect(drainPaged("timeline", undefined, fetchPage)).rejects.toThrow(
      CliError,
    );
    expect(calls).toBe(MAX_DRAIN_PAGES);
  });
});

describe("issue view against a misbehaving server", () => {
  const me = {
    id: 2,
    login: "claude",
    display_name: "Claude",
    kind: "machine",
    owner: null,
  };
  const issue = {
    id: 11,
    number: 3,
    title: "Fix the potato",
    body: "",
    status: { id: 1, name: "Todo", category: "open", color: "#6b7280" },
    author: me,
    assignees: [],
    labels: [],
    created_at: "2026-08-11T10:00:00Z",
    updated_at: "2026-08-11T11:00:00Z",
  };
  const entry = (id: number) => ({
    type: "comment",
    id,
    author: me,
    body: `comment ${id}`,
    created_at: "2026-08-11T10:30:00Z",
    edited_at: null,
  });

  it("issue view stops at one request when has_more is false", async () => {
    let timelineCalls = 0;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issue],
      ["PUT", "/api/projects/todou/issues/3/read", {}],
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        () => {
          timelineCalls += 1;
          return {
            items: [entry(timelineCalls)],
            next_cursor: "c1",
            has_more: false,
          };
        },
      ],
    ]);
    const result = await runCli(["issue", "view", "3", "--json"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      timeline: unknown[];
      next_cursor: string | null;
    };
    expect(parsed.timeline).toHaveLength(1);
    expect(parsed.next_cursor).toBe("c1");
    expect(timelineCalls).toBe(1);
  });

  it("finishes once when the cursor stalls instead of spinning", async () => {
    let timelineCalls = 0;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issue],
      ["PUT", "/api/projects/todou/issues/3/read", {}],
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        () => {
          timelineCalls += 1;
          return { items: [entry(timelineCalls)], next_cursor: "c1" };
        },
      ],
    ]);
    const result = await runCli(["issue", "view", "3", "--json"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      timeline: unknown[];
      next_cursor: string | null;
    };
    expect(parsed.timeline).toHaveLength(1);
    expect(parsed.next_cursor).toBe("c1");
    expect(timelineCalls).toBe(2);
  });

  it("reports a server-side pagination anomaly when the cap is hit", async () => {
    let timelineCalls = 0;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issue],
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        () => {
          timelineCalls += 1;
          return {
            items: [entry(timelineCalls)],
            next_cursor: `c${timelineCalls}`,
          };
        },
      ],
    ]);
    const result = await runCli(["issue", "view", "3"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `giving up after ${MAX_DRAIN_PAGES} timeline pages`,
    );
    expect(result.stderr).toContain("server-side pagination anomaly");
    expect(timelineCalls).toBe(MAX_DRAIN_PAGES);
  });
});
