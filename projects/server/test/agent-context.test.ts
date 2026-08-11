import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const CONTEXT = {
  agent: "claude-code",
  session_id: "11111111-2222-3333-4444-555555555555",
  model: "claude-fable-5",
};

describe("agent context persistence", () => {
  let t: TestApp;
  let cookie: string;
  const slug = "agent-ctx";
  const headers = (withContext: boolean) => ({
    "content-type": "application/json",
    cookie,
    ...(withContext
      ? { "x-todou-agent-context": JSON.stringify(CONTEXT) }
      : {}),
  });

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(false),
      body: JSON.stringify({ slug, name: "Agent ctx" }),
    });
    expect(res.status).toBe(201);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  async function timelineOf(number: number) {
    const res = await t.app.request(
      `/api/projects/${slug}/issues/${number}/timeline?limit=50`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    return (await json(res)).items as Array<{
      type: string;
      event_type?: string;
      agent_context: unknown;
    }>;
  }

  it("stamps opened events, comments, and status changes made with the header", async () => {
    const created = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ title: "From an agent", body: "hi" }),
    });
    expect(created.status).toBe(201);
    const issue = await json(created);

    const commented = await t.app.request(
      `/api/projects/${slug}/issues/${issue.number}/comments`,
      {
        method: "POST",
        headers: headers(true),
        body: JSON.stringify({ body: "agent says hi" }),
      },
    );
    expect(commented.status).toBe(201);
    expect((await json(commented)).agent_context).toEqual(CONTEXT);

    const statuses = await json(
      await t.app.request(`/api/projects/${slug}/statuses`, {
        headers: { cookie },
      }),
    );
    const closed = statuses.find(
      (s: { category: string }) => s.category === "closed",
    );
    const patched = await t.app.request(
      `/api/projects/${slug}/issues/${issue.number}`,
      {
        method: "PATCH",
        headers: headers(true),
        body: JSON.stringify({ status_id: closed.id }),
      },
    );
    expect(patched.status).toBe(200);

    const items = await timelineOf(issue.number);
    const opened = items.find((i) => i.event_type === "opened");
    const comment = items.find((i) => i.type === "comment");
    const close = items.find((i) => i.event_type === "closed");
    expect(opened?.agent_context).toEqual(CONTEXT);
    expect(comment?.agent_context).toEqual(CONTEXT);
    expect(close?.agent_context).toEqual(CONTEXT);
  });

  it("leaves agent_context null without the header", async () => {
    const created = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(false),
      body: JSON.stringify({ title: "From a human", body: "" }),
    });
    const issue = await json(created);
    const items = await timelineOf(issue.number);
    expect(items.every((i) => i.agent_context === null)).toBe(true);
  });

  it("rejects malformed and oversized headers", async () => {
    for (const value of [
      "{not json",
      JSON.stringify({ agent: "" }),
      JSON.stringify({ agent: "x", model: "y".repeat(1000) }),
      JSON.stringify({ agent: "x", session_id: "s".repeat(4096) }),
    ]) {
      const res = await t.app.request(`/api/projects/${slug}/issues`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          "x-todou-agent-context": value,
        },
        body: JSON.stringify({ title: "nope", body: "" }),
      });
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe("invalid_agent_context");
    }
  });

  it("does not stamp reads or unrelated writes retroactively", async () => {
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      headers: { cookie, "x-todou-agent-context": JSON.stringify(CONTEXT) },
    });
    expect(res.status).toBe(200);
  });
});
