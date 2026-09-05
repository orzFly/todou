import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractIssueRefs } from "../src/services/references.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

describe("extractIssueRefs formats", () => {
  it("keeps the historical # behaviour when prefix is null", () => {
    expect(extractIssueRefs("see #12 and #13, not #12 again")).toEqual([
      12, 13,
    ]);
    expect(extractIssueRefs("`#12` and\n```\n#13\n```\nstay code")).toEqual([]);
  });

  it("matches PREFIX-N with hyphen-aware boundaries", () => {
    expect(extractIssueRefs("fixes T-76, see T-9", "T")).toEqual([76, 9]);
    // A hyphenated word in front is not a reference.
    expect(extractIssueRefs("SOME-T-76", "T")).toEqual([]);
    expect(extractIssueRefs("xT-76", "T")).toEqual([]);
    // Under a prefixed format, bare #N no longer parses internally...
    expect(extractIssueRefs("see #12", "T")).toEqual([]);
    // ...and prefixed refs don't parse under "#".
    expect(extractIssueRefs("fixes T-76", null)).toEqual([]);
    // Case-sensitive; digits bounded at 9.
    expect(extractIssueRefs("t-76", "T")).toEqual([]);
    expect(extractIssueRefs("T-1234567890", "T")).toEqual([]);
    expect(extractIssueRefs("FOOBAR-8?", "FOOBAR")).toEqual([8]);
  });
});

describe("time-cutoff reference recording", () => {
  let t: TestApp;
  let cookie: string;

  beforeAll(async () => {
    t = await makeTestApp("shared");
    cookie = await t.login();
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ slug: "cutoff", name: "Cutoff" }),
    });
    expect(res.status).toBe(201);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  const api = (path: string, init?: RequestInit) =>
    t.app.request(`/api/projects/cutoff${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        cookie,
        ...(init?.headers ?? {}),
      },
    });

  async function createIssue(title: string, body = "") {
    const res = await api("/issues", {
      method: "POST",
      body: JSON.stringify({ title, body }),
    });
    expect(res.status).toBe(201);
    return json(res);
  }

  async function referencedEvents(
    number: number,
  ): Promise<Array<{ payload: Record<string, unknown> }>> {
    const page = await json(
      await api(`/issues/${number}/timeline?types=referenced&limit=100`),
    );
    return page.items;
  }

  it("anchors parsing to content created_at across a format switch", async () => {
    const target = await createIssue("target");
    const other = await createIssue("other");

    // Pre-switch comment: "#N" records, "T-N" is plain text.
    const preRes = await api(`/issues/${other.number}/comments`, {
      method: "POST",
      body: JSON.stringify({
        body: `pre-switch #${target.number} and T-${target.number}`,
      }),
    });
    expect(preRes.status).toBe(201);
    const pre = await json(preRes);
    let events = await referencedEvents(target.number);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      by_issue: other.number,
      by_comment: pre.id,
    });

    // Switch the project to T-N.
    const put = await api("/references/format", {
      method: "PUT",
      body: JSON.stringify({ prefix: "T" }),
    });
    expect(put.status).toBe(200);

    // Post-switch issue body: "T-N" records, "#N" does not.
    const third = await createIssue("third", `post-switch T-${target.number}`);
    events = await referencedEvents(target.number);
    expect(events).toHaveLength(2);
    expect(events[1].payload).toMatchObject({ by_issue: third.number });

    const fourth = await createIssue("fourth", `post-switch #${target.number}`);
    events = await referencedEvents(target.number);
    expect(events).toHaveLength(2);

    // Editing the PRE-switch comment reads it under the format in force NOW
    // (T-266): what the author is typing at this moment is what gets
    // resolved, so "T-N" records and "#N" is plain text. The links the
    // comment already carried were resolved before the switch and stay put —
    // a stored link is an answer, not a spelling to re-read.
    const second = await createIssue("second-target");
    const edit = await api(`/issues/${other.number}/comments/${pre.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        body: `edited #${second.number} plus T-${fourth.number}`,
      }),
    });
    expect(edit.status).toBe(200);
    expect(await referencedEvents(second.number)).toHaveLength(0);
    expect(await referencedEvents(fourth.number)).toHaveLength(1);
  });

  it("switching back to # restores hash parsing for new content", async () => {
    const back = await api("/references/format", {
      method: "PUT",
      body: JSON.stringify({ prefix: null }),
    });
    expect(back.status).toBe(200);

    const target = await createIssue("hash-again");
    await createIssue("refers", `now #${target.number} works again`);
    expect(await referencedEvents(target.number)).toHaveLength(1);
  });
});
