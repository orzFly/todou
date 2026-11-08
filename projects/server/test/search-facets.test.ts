import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const SLUG = "facet-proj";

type Ctx = { agent: string; session_id?: string } | null;

describe("search facets", () => {
  let t: TestApp;
  let cookie: string;
  let writer: Record<string, string>;

  const headers = (agent: Ctx = null) => ({
    "content-type": "application/json",
    cookie,
    ...(agent === null
      ? {}
      : { "x-todou-agent-context": JSON.stringify(agent) }),
  });

  const createIssue = async (title: string, agent: Ctx = null) => {
    const res = await t.app.request(`/api/projects/${SLUG}/issues`, {
      method: "POST",
      headers: headers(agent),
      body: JSON.stringify({ title, body: "正文" }),
    });
    expect(res.status).toBe(201);
    return (await json(res)).number as number;
  };

  const comment = async (n: number, body: string, agent: Ctx = null) => {
    const res = await t.app.request(
      `/api/projects/${SLUG}/issues/${n}/comments`,
      {
        method: "POST",
        headers: headers(agent),
        body: JSON.stringify({ body }),
      },
    );
    expect(res.status).toBe(201);
  };

  const facets = async (): Promise<{
    harnesses: Array<{ agent: string | null; count: number }>;
    sessions: Array<{
      session_id: string;
      agent: string | null;
      count: number;
      last_seen: string;
    }>;
  }> => {
    const res = await t.app.request(`/api/projects/${SLUG}/search/facets`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    return json(res);
  };

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug: SLUG, name: "Facets" }),
    });
    expect(created.status).toBe(201);

    const w = await addUserWithToken(t.ctx, "facet-writer");
    writer = w.headers;
    const member = await t.app.request(
      `/api/projects/${SLUG}/members/${w.user.id}`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ role: "writer" }),
      },
    );
    expect(member.status).toBe(204);

    const one = await createIssue("卡一", { agent: "codex", session_id: "s1" });
    await comment(one, "评论一", { agent: "codex", session_id: "s1" });
    await comment(one, "评论二", { agent: "claude-code", session_id: "s2" });
    // A session that reported no agent on its last write — the facet has to
    // answer with what it last called itself, not with the first thing seen.
    await comment(one, "评论三", { agent: "codex", session_id: "s3" });
    await t.app.request(`/api/projects/${SLUG}/issues/${one}/spec/push`, {
      method: "POST",
      headers: headers({ agent: "hermes-agent", session_id: "s3" }),
      body: JSON.stringify({
        files: [{ path: "design.md", body: "定稿" }],
        message: "push",
      }),
    });
    // No agent context at all, and one that reports an empty session.
    await createIssue("卡二");
    await createIssue("卡三", { agent: "pi", session_id: "" });
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  it("counts every write that reported an agent, by frequency", async () => {
    const { harnesses } = await facets();
    expect(harnesses).toEqual([
      // 卡一's `opened` event and its two codex comments.
      { agent: "codex", count: 3 },
      // A spec push leaves two rows carrying the context: the version and
      // the `spec_pushed` event.
      { agent: "hermes-agent", count: 2 },
      // Ties break by name, and "no agent context" sorts as the empty one.
      { agent: null, count: 1 },
      { agent: "claude-code", count: 1 },
      { agent: "pi", count: 1 },
    ]);
  });

  it("lists sessions newest first, with the agent each last reported", async () => {
    const { sessions } = await facets();
    expect(sessions.map((s) => s.session_id)).toEqual(["s3", "s2", "s1"]);
    expect(sessions.map((s) => s.agent)).toEqual([
      // s3 commented as codex and then pushed a spec as hermes-agent.
      "hermes-agent",
      "claude-code",
      "codex",
    ]);
    // s3: one comment plus the two rows its spec push wrote.
    expect(sessions.map((s) => s.count)).toEqual([3, 1, 2]);
    for (const s of sessions) {
      expect(s.last_seen).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    }
  });

  it("leaves an empty reported session out entirely", async () => {
    const { sessions, harnesses } = await facets();
    expect(sessions.map((s) => s.session_id)).not.toContain("");
    // The write itself still counts towards its harness — it is only the
    // session that was never reported.
    expect(harnesses).toContainEqual({ agent: "pi", count: 1 });
  });

  it("stops counting a card once it is in the trash", async () => {
    const doomed = await createIssue("待删除", {
      agent: "codex",
      session_id: "s9",
    });
    await comment(doomed, "评论", { agent: "codex", session_id: "s9" });
    expect((await facets()).sessions.map((s) => s.session_id)).toContain("s9");

    const deleted = await t.app.request(
      `/api/projects/${SLUG}/issues/${doomed}`,
      { method: "DELETE", headers: headers() },
    );
    expect(deleted.status).toBe(204);

    const after = await facets();
    expect(after.sessions.map((s) => s.session_id)).not.toContain("s9");
    expect(after.harnesses).toContainEqual({ agent: "codex", count: 3 });
  });

  it("refuses a non-member", async () => {
    const stranger = await addUserWithToken(t.ctx, "facet-stranger");
    const res = await t.app.request(`/api/projects/${SLUG}/search/facets`, {
      headers: stranger.headers,
    });
    expect(res.status).toBe(404);
  });

  it("answers a writer as well as an admin", async () => {
    const res = await t.app.request(`/api/projects/${SLUG}/search/facets`, {
      headers: { ...writer },
    });
    expect(res.status).toBe(200);
  });

  it("caps the session list", async () => {
    // Fifty-one sessions on one card: the pool is for a dropdown, and the
    // cap has to hold whatever the project accumulates.
    const many = await createIssue("上限");
    for (let i = 0; i < 51; i += 1) {
      await comment(many, `批量 ${i}`, {
        agent: "codex",
        session_id: `bulk-${String(i).padStart(3, "0")}`,
      });
    }
    const { sessions } = await facets();
    expect(sessions).toHaveLength(50);
    expect(sessions[0]?.session_id).toBe("bulk-050");
  });
});

describe("search facets across a cross-project reference T-658", () => {
  const SRC = "facet-src";
  const DST = "facet-dst";
  let t: TestApp;
  let cookie: string;
  /** Reader of the referenced project only. */
  let outsider: Record<string, string>;
  /** Reader of both, so the referring write is theirs to see. */
  let insider: Record<string, string>;

  const write = async (path: string, body: object, agent: Ctx) => {
    const res = await t.app.request(`/api/projects/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        ...(agent === null
          ? {}
          : { "x-todou-agent-context": JSON.stringify(agent) }),
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    return json(res);
  };

  const facetsFor = async (who: Record<string, string>) => {
    const res = await t.app.request(`/api/projects/${DST}/search/facets`, {
      headers: who,
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    return {
      sessions: new Map(
        (body.sessions as Array<{ session_id: string; count: number }>).map(
          (s) => [s.session_id, s.count],
        ),
      ),
      agents: new Map(
        (body.harnesses as Array<{ agent: string | null; count: number }>).map(
          (h) => [h.agent, h.count],
        ),
      ),
    };
  };

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    for (const slug of [SRC, DST]) {
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(res.status).toBe(201);
    }
    const bob = await addUserWithToken(t.ctx, "facet-outsider");
    const carol = await addUserWithToken(t.ctx, "facet-insider");
    outsider = bob.headers;
    insider = carol.headers;
    for (const [user, slugs] of [
      [bob, [DST]],
      [carol, [SRC, DST]],
    ] as const) {
      for (const slug of slugs) {
        const res = await t.app.request(
          `/api/projects/${slug}/members/${user.user.id}`,
          {
            method: "PUT",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ role: "reader" }),
          },
        );
        expect(res.status).toBe(204);
      }
    }

    const target = (
      await write(`${DST}/issues`, { title: "被引用", body: "" }, null)
    ).number as number;
    // A reference written inside DST itself: every reader of DST reads the
    // project it came from.
    await write(
      `${DST}/issues`,
      { title: "本地引用", body: `see #${target}` },
      { agent: "local-harness", session_id: "LOCAL" },
    );
    await write(
      `${SRC}/issues`,
      { title: "跨项目引用", body: `see ${DST}#${target}` },
      { agent: "secret-harness", session_id: "SECRET-A" },
    );
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  it("keeps the referring write from a reader who cannot read its project", async () => {
    const { sessions, agents } = await facetsFor(outsider);
    expect(sessions.has("SECRET-A")).toBe(false);
    expect(agents.has("secret-harness")).toBe(false);
  });

  it("still counts a reference written inside the project", async () => {
    const { sessions, agents } = await facetsFor(outsider);
    // The card's `opened` event and the `referenced` event it left on the
    // target: the second is the one the cross-project filter judges.
    expect(sessions.get("LOCAL")).toBe(2);
    expect(agents.get("local-harness")).toBe(2);
  });

  it("shows the referring write to a reader of both projects", async () => {
    const { sessions, agents } = await facetsFor(insider);
    expect(sessions.get("SECRET-A")).toBe(1);
    expect(agents.get("secret-harness")).toBe(1);
  });
});
