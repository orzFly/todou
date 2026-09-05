import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSnippet } from "../src/services/search.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const SLUG = "search-proj";

type Hit = {
  kind: "issue" | "comment" | "spec";
  issue: { number: number; title: string };
  comment_id: number | null;
  spec_path: string | null;
  field: "title" | "body" | "path";
  snippet: { text: string; ranges: Array<[number, number]> };
};

describe("project search", () => {
  let t: TestApp;
  let cookie: string;
  /** A writer who is not the instance admin, to author the trashed card. */
  let writer: Record<string, string>;
  let writerId = 0;

  const headers = () => ({ "content-type": "application/json", cookie });

  const createIssue = async (title: string, body = ""): Promise<number> => {
    const res = await t.app.request(`/api/projects/${SLUG}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title, body }),
    });
    expect(res.status).toBe(201);
    return (await json(res)).number as number;
  };

  const comment = async (n: number, body: string): Promise<number> => {
    const res = await t.app.request(
      `/api/projects/${SLUG}/issues/${n}/comments`,
      { method: "POST", headers: headers(), body: JSON.stringify({ body }) },
    );
    expect(res.status).toBe(201);
    return (await json(res)).id as number;
  };

  const pushSpec = async (
    n: number,
    files: Array<{ path: string; body: string }>,
  ) => {
    const res = await t.app.request(
      `/api/projects/${SLUG}/issues/${n}/spec/push`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ files, message: "push" }),
      },
    );
    expect(res.status).toBe(200);
  };

  const search = async (
    qs: string,
  ): Promise<{ items: Hit[]; has_more: boolean }> => {
    const res = await t.app.request(`/api/projects/${SLUG}/search?${qs}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    return json(res);
  };

  const kinds = (items: Hit[]) =>
    items.map((i) => `${i.issue.number}:${i.kind}`);

  /** Issue numbers, deduplicated in rank order. */
  const numbers = (items: Hit[]) => [
    ...new Set(items.map((i) => i.issue.number)),
  ];

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug: SLUG, name: "Search" }),
    });
    expect(created.status).toBe(201);

    const w = await addUserWithToken(t.ctx, "search-writer");
    writer = w.headers;
    writerId = w.user.id;
    const member = await t.app.request(
      `/api/projects/${SLUG}/members/${writerId}`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ role: "writer" }),
      },
    );
    expect(member.status).toBe(204);

    // 1: the CJK card the whole design turns on — a query for a word inside
    // a run of Chinese has to find it.
    await createIssue(
      "增加项目内全文搜索功能",
      "支持中文分词与英文标识符混排，例如 coalescedWordDiff。",
    );
    // 2: terms split across title and body.
    await createIssue("watch 命令的 cursor 语义", "修复等待起点的空窗问题。");
    // 3: hits only in a comment.
    await createIssue("无关的卡", "正文里没有关键词。");
    await comment(3, "实测结论：pg_trgm 对三字以上中文 pattern 走 GIN 索引。");
    // 4: hits only in a spec file.
    await createIssue("带 spec 的卡", "正文无关。");
    await pushSpec(4, [
      { path: "design.md", body: "方案定稿：应用侧排序与摘要高亮。" },
    ]);
    // 5: escaping — literal % and _ in the text.
    await createIssue("100% 覆盖率", "字段名是 spec_version，不是通配符。");
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  describe("substring semantics", () => {
    it("finds a word inside a run of Chinese", async () => {
      const { items } = await search("q=全文搜索");
      expect(numbers(items)).toEqual([1]);
      expect(items[0]?.kind).toBe("issue");
      expect(items[0]?.field).toBe("title");
    });

    it("finds a one-character CJK substring", async () => {
      // Below the trigram index's reach — a sequential scan, still correct.
      const { items } = await search("q=词");
      expect(numbers(items)).toContain(1);
    });

    it("finds an identifier by its tail, case-insensitively", async () => {
      const { items } = await search("q=worddiff");
      expect(numbers(items)).toEqual([1]);
    });

    it("ANDs terms across an issue's title and body", async () => {
      const { items } = await search("q=cursor+空窗");
      expect(numbers(items)).toEqual([2]);
    });

    it("returns nothing when one term of an AND is absent", async () => {
      const { items } = await search("q=cursor+不存在的词");
      expect(items).toEqual([]);
    });

    it("keeps a quoted phrase together", async () => {
      const withSpace = await search(
        `q=${encodeURIComponent('"中文分词与英文"')}`,
      );
      expect(numbers(withSpace.items)).toEqual([1]);
      // The same characters unquoted are two terms, both of which happen to
      // be present — so the quoting is what makes the phrase order matter.
      const reordered = await search(
        `q=${encodeURIComponent('"英文与中文分词"')}`,
      );
      expect(reordered.items).toEqual([]);
    });

    it("treats LIKE wildcards in the query as literal text", async () => {
      expect(numbers((await search("q=100%25")).items)).toEqual([5]);
      expect(numbers((await search("q=spec_version")).items)).toEqual([5]);
      // The underscore is a literal, so it does not match "specXversion".
      expect((await search("q=spec_ersion")).items).toEqual([]);
    });
  });

  describe("domains", () => {
    it("searches comments", async () => {
      const { items } = await search("q=pg_trgm");
      expect(kinds(items)).toEqual(["3:comment"]);
      expect(items[0]?.comment_id).toBeGreaterThan(0);
    });

    it("searches the newest spec version's files", async () => {
      const { items } = await search("q=摘要高亮");
      expect(kinds(items)).toEqual(["4:spec"]);
      expect(items[0]?.spec_path).toBe("design.md");
    });

    it("matches a spec file by path", async () => {
      const { items } = await search("q=design.md");
      expect(kinds(items)).toEqual(["4:spec"]);
      expect(items[0]?.field).toBe("path");
    });

    it("drops superseded spec versions", async () => {
      await pushSpec(4, [
        { path: "design.md", body: "改版后的定稿：只留新的说法。" },
      ]);
      expect((await search("q=摘要高亮")).items).toEqual([]);
      expect(kinds((await search("q=改版后的定稿")).items)).toEqual(["4:spec"]);
    });

    it("honours --in", async () => {
      // "语义" is in issue 2's title and, after this comment, in a comment too.
      await comment(2, "补充：语义已经对齐。");
      expect(kinds((await search("q=语义")).items)).toEqual([
        "2:issue",
        "2:comment",
      ]);
      expect(kinds((await search("q=语义&in=comments")).items)).toEqual([
        "2:comment",
      ]);
      expect(kinds((await search("q=语义&in=issues")).items)).toEqual([
        "2:issue",
      ]);
    });

    it("rejects an unknown domain", async () => {
      const res = await t.app.request(
        `/api/projects/${SLUG}/search?q=x&in=events`,
        { headers: { cookie } },
      );
      expect(res.status).toBe(422);
    });
  });

  describe("ranking and snippets", () => {
    it("puts a title hit above a body hit above a comment hit", async () => {
      const n = await createIssue("排序锚点", "排序锚点在正文里也出现一次。");
      const m = await createIssue("另一张卡", "正文无关。");
      await comment(m, "排序锚点出现在评论里。");
      const other = await createIssue("第三张卡", "这里也提到排序锚点。");

      const { items } = await search("q=排序锚点");
      expect(items[0]?.issue.number).toBe(n);
      expect(items[0]?.field).toBe("title");
      // Body hit next, then the comment.
      expect(items[1]?.issue.number).toBe(other);
      expect(items[1]?.kind).toBe("issue");
      expect(items[2]?.kind).toBe("comment");
      expect(items[2]?.issue.number).toBe(m);
    });

    it("returns slice-ready highlight ranges", async () => {
      const { items } = await search("q=全文搜索");
      const hit = items[0];
      if (!hit) throw new Error("expected a hit");
      const [range] = hit.snippet.ranges;
      if (!range) throw new Error("expected a highlight range");
      expect(hit.snippet.text.slice(range[0], range[1])).toBe("全文搜索");
    });

    it("paginates with limit and offset", async () => {
      const all = await search("q=排序锚点&limit=100");
      expect(all.has_more).toBe(false);
      const first = await search("q=排序锚点&limit=1");
      expect(first.items).toHaveLength(1);
      expect(first.has_more).toBe(true);
      const second = await search("q=排序锚点&limit=1&offset=1");
      expect(second.items[0]?.issue.number).toBe(all.items[1]?.issue.number);
    });
  });

  describe("filters and visibility", () => {
    it("narrows by status like the issue list does", async () => {
      const statuses = await json(
        await t.app.request(`/api/projects/${SLUG}/statuses`, {
          headers: { cookie },
        }),
      );
      const next = statuses.find((s: { name: string }) => s.name === "Next");
      expect(next).toBeDefined();
      const n = await createIssue("状态过滤锚点", "");
      const moved = await t.app.request(`/api/projects/${SLUG}/issues/${n}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ status_id: next.id }),
      });
      expect(moved.status).toBe(200);

      const m = await createIssue("状态过滤锚点二", "");
      expect(numbers((await search("q=状态过滤锚点")).items)).toEqual([m, n]);
      expect(
        numbers((await search(`q=状态过滤锚点&status=${next.id}`)).items),
      ).toEqual([n]);
    });

    it("takes a trashed card's comments and spec out with it", async () => {
      const created = await t.app.request(`/api/projects/${SLUG}/issues`, {
        method: "POST",
        headers: { "content-type": "application/json", ...writer },
        body: JSON.stringify({ title: "回收站锚点", body: "正文" }),
      });
      expect(created.status).toBe(201);
      const n = (await json(created)).number as number;
      await comment(n, "评论里也有回收站锚点。");
      await pushSpec(n, [{ path: "p.md", body: "spec 里也有回收站锚点。" }]);
      expect((await search("q=回收站锚点")).items).toHaveLength(3);

      const deleted = await t.app.request(`/api/projects/${SLUG}/issues/${n}`, {
        method: "DELETE",
        headers: { ...writer },
      });
      expect(deleted.status).toBe(204);
      // Even for the author, who can still see the card in the trash.
      const asAuthor = await t.app.request(
        `/api/projects/${SLUG}/search?q=${encodeURIComponent("回收站锚点")}`,
        { headers: { ...writer } },
      );
      expect(asAuthor.status).toBe(200);
      expect((await json(asAuthor)).items).toEqual([]);
      expect((await search("q=回收站锚点")).items).toEqual([]);
    });

    it("refuses a non-member", async () => {
      const stranger = await addUserWithToken(t.ctx, "search-stranger");
      const res = await t.app.request(`/api/projects/${SLUG}/search?q=x`, {
        headers: stranger.headers,
      });
      expect(res.status).toBe(404);
    });
  });

  describe("query limits", () => {
    it("rejects an empty q", async () => {
      const res = await t.app.request(`/api/projects/${SLUG}/search?q=`, {
        headers: { cookie },
      });
      expect(res.status).toBe(422);
    });

    it("rejects a q made only of whitespace", async () => {
      const res = await t.app.request(`/api/projects/${SLUG}/search?q=+++`, {
        headers: { cookie },
      });
      expect(res.status).toBe(422);
    });

    it("rejects more than eight terms", async () => {
      const res = await t.app.request(
        `/api/projects/${SLUG}/search?q=${encodeURIComponent("a b c d e f g h i")}`,
        { headers: { cookie } },
      );
      expect(res.status).toBe(422);
    });

    it("rejects a q over 256 characters", async () => {
      const res = await t.app.request(
        `/api/projects/${SLUG}/search?q=${"x".repeat(257)}`,
        { headers: { cookie } },
      );
      expect(res.status).toBe(422);
    });

    it("rejects a q that yields neither a term nor a qualifier", async () => {
      const res = await t.app.request(
        `/api/projects/${SLUG}/search?q=${encodeURIComponent('  ""  ')}`,
        { headers: { cookie } },
      );
      expect(res.status).toBe(422);
    });

    it("rejects more than sixteen qualifiers", async () => {
      const q = Array.from({ length: 17 }, (_, i) => `label:l${i}`).join(" ");
      const res = await t.app.request(
        `/api/projects/${SLUG}/search?q=${encodeURIComponent(q)}`,
        { headers: { cookie } },
      );
      expect(res.status).toBe(422);
    });

    it("does not spend the term budget on qualifiers", async () => {
      // Nine expressions and one word: over the term cap only if qualifiers
      // counted, which they must not.
      const q = `${Array.from({ length: 9 }, (_, i) => `label:l${i}`).join(" ")} 词`;
      const res = await t.app.request(
        `/api/projects/${SLUG}/search?q=${encodeURIComponent(q)}`,
        { headers: { cookie } },
      );
      expect(res.status).toBe(200);
    });
  });
});

const QUAL = "qual-proj";

/** The provenance a write reports; `null` = a human at a browser. */
type Ctx = { agent: string; session_id?: string } | null;

describe("search qualifiers", () => {
  let t: TestApp;
  let cookie: string;
  let meId = 0;
  let outsider = 0;
  const statusId = new Map<string, number>();
  const labelId = new Map<string, number>();

  const headers = (agent: Ctx = null) => ({
    "content-type": "application/json",
    cookie,
    ...(agent === null
      ? {}
      : { "x-todou-agent-context": JSON.stringify(agent) }),
  });

  const createIssue = async (
    title: string,
    body: string,
    agent: Ctx = null,
  ): Promise<number> => {
    const res = await t.app.request(`/api/projects/${QUAL}/issues`, {
      method: "POST",
      headers: headers(agent),
      body: JSON.stringify({ title, body }),
    });
    expect(res.status).toBe(201);
    return (await json(res)).number as number;
  };

  const comment = async (n: number, body: string, agent: Ctx = null) => {
    const res = await t.app.request(
      `/api/projects/${QUAL}/issues/${n}/comments`,
      {
        method: "POST",
        headers: headers(agent),
        body: JSON.stringify({ body }),
      },
    );
    expect(res.status).toBe(201);
  };

  const pushSpec = async (n: number, body: string, agent: Ctx = null) => {
    const res = await t.app.request(
      `/api/projects/${QUAL}/issues/${n}/spec/push`,
      {
        method: "POST",
        headers: headers(agent),
        body: JSON.stringify({
          files: [{ path: "design.md", body }],
          message: "push",
        }),
      },
    );
    expect(res.status).toBe(200);
  };

  const patch = async (n: number, body: Record<string, unknown>) => {
    const res = await t.app.request(`/api/projects/${QUAL}/issues/${n}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
  };

  const raw = async (q: string, extra = ""): Promise<Response> =>
    await t.app.request(
      `/api/projects/${QUAL}/search?q=${encodeURIComponent(q)}${extra}`,
      { headers: { cookie } },
    );

  const search = async (
    q: string,
    extra = "",
  ): Promise<{
    items: Hit[];
    has_more: boolean;
    diagnostics: Array<Record<string, unknown>>;
  }> => {
    const res = await raw(q, extra);
    expect(res.status).toBe(200);
    return json(res);
  };

  /** `number:kind` per hit, which is what every assertion below compares. */
  const kinds = async (q: string, extra = "") =>
    (await search(q, extra)).items.map((i) => `${i.issue.number}:${i.kind}`);

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug: QUAL, name: "Qualifiers" }),
    });
    expect(created.status).toBe(201);
    meId = (await json(await t.app.request("/api/me", { headers: { cookie } })))
      .id as number;

    for (const row of await json(
      await t.app.request(`/api/projects/${QUAL}/statuses`, {
        headers: { cookie },
      }),
    )) {
      statusId.set(row.name, row.id);
    }
    // A label name carrying a colon, because todou's own do — the parser has
    // to keep the whole `area:web` as one value.
    for (const name of ["area:web", "kind:bug"]) {
      const res = await t.app.request(`/api/projects/${QUAL}/labels`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ name, color: "#112233" }),
      });
      expect(res.status).toBe(201);
      labelId.set(name, (await json(res)).id as number);
    }

    const other = await addUserWithToken(t.ctx, "qual-writer");
    outsider = other.user.id;
    const member = await t.app.request(
      `/api/projects/${QUAL}/members/${outsider}`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ role: "writer" }),
      },
    );
    expect(member.status).toBe(204);

    // 1 — opened by codex, labelled area:web, assigned to me, left in Todo.
    await createIssue("限定符锚点一", "正文一 限定符锚点", {
      agent: "codex",
      session_id: "sess-a",
    });
    await patch(1, {
      label_ids: [labelId.get("area:web")],
      assignee_ids: [meId],
    });
    await comment(1, "评论 限定符锚点 甲", {
      agent: "claude-code",
      session_id: "sess-b",
    });

    // 2 — opened from a browser, labelled kind:bug, moved to Next, and its
    // spec pushed by codex under a third session.
    await createIssue("限定符锚点二", "正文二 限定符锚点");
    await patch(2, {
      label_ids: [labelId.get("kind:bug")],
      status_id: statusId.get("Next"),
    });
    await comment(2, "评论 限定符锚点 乙");
    await pushSpec(2, "spec 限定符锚点 定稿", {
      agent: "codex",
      session_id: "sess-c",
    });

    // 3 — closed, both labels, and opened by a harness reporting an empty
    // session, which must read as "no session at all".
    await createIssue("限定符锚点三", "正文三 限定符锚点", {
      agent: "pi",
      session_id: "",
    });
    await patch(3, {
      label_ids: [labelId.get("area:web"), labelId.get("kind:bug")],
      status_id: statusId.get("Done"),
    });
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  describe("each qualifier narrows what the same words find", () => {
    it("baseline: the anchor is in every card, comment and spec", async () => {
      // Ranking is unchanged: title hits first, then recency — the fixtures
      // were touched in ascending order, so cards come back 3, 2, 1.
      expect(await kinds("限定符锚点")).toEqual([
        "3:issue",
        "2:issue",
        "1:issue",
        "2:comment",
        "1:comment",
        "2:spec",
      ]);
    });

    it("is: picks the unit, in the plural spellings too", async () => {
      expect(await kinds("is:comment 限定符锚点")).toEqual([
        "2:comment",
        "1:comment",
      ]);
      expect(await kinds("is:body 限定符锚点")).toEqual([
        "3:issue",
        "2:issue",
        "1:issue",
      ]);
      expect(await kinds("is:specs 限定符锚点")).toEqual(["2:spec"]);
      expect(await kinds("is:spec,comment 限定符锚点")).toEqual([
        "2:comment",
        "1:comment",
        "2:spec",
      ]);
    });

    it("state: reads the status category", async () => {
      expect(await kinds("state:closed is:body 限定符锚点")).toEqual([
        "3:issue",
      ]);
      expect(await kinds("state:open is:body 限定符锚点")).toEqual([
        "2:issue",
        "1:issue",
      ]);
    });

    it("status: reads the status name, case and spaces included", async () => {
      expect(await kinds("status:next is:body 限定符锚点")).toEqual([
        "2:issue",
      ]);
      expect(await kinds('status:"To Do" is:body 限定符锚点')).toEqual([]);
      expect(await kinds("status:Todo is:body 限定符锚点")).toEqual([
        "1:issue",
      ]);
    });

    it("label: takes a name that carries a colon", async () => {
      expect(await kinds("label:area:web is:body 限定符锚点")).toEqual([
        "3:issue",
        "1:issue",
      ]);
      expect(await kinds('label:"kind:bug" is:body 限定符锚点')).toEqual([
        "3:issue",
        "2:issue",
      ]);
    });

    it("assignee: takes a login and @me", async () => {
      expect(await kinds("assignee:user is:body 限定符锚点")).toEqual([
        "1:issue",
      ]);
      expect(await kinds("assignee:@me is:body 限定符锚点")).toEqual([
        "1:issue",
      ]);
      expect(await kinds("assignee:qual-writer is:body 限定符锚点")).toEqual(
        [],
      );
    });
  });

  describe("combining values", () => {
    it("commas are any-of, repeating the key is all-of", async () => {
      expect(await kinds("label:area:web,kind:bug is:body 限定符锚点")).toEqual(
        ["3:issue", "2:issue", "1:issue"],
      );
      expect(
        await kinds("label:area:web label:kind:bug is:body 限定符锚点"),
      ).toEqual(["3:issue"]);
    });

    it("a leading minus inverts the whole expression", async () => {
      expect(await kinds("-label:area:web is:body 限定符锚点")).toEqual([
        "2:issue",
      ]);
      expect(
        await kinds("-label:area:web,kind:bug is:body 限定符锚点"),
      ).toEqual([]);
      expect(await kinds("-state:closed is:body 限定符锚点")).toEqual([
        "2:issue",
        "1:issue",
      ]);
    });

    it("intersects is: with a ?in= that came from an old link", async () => {
      expect(await kinds("is:comment,spec 限定符锚点", "&in=specs")).toEqual([
        "2:spec",
      ]);
    });

    it("an empty value narrows nothing and is not an error", async () => {
      expect(await kinds("label: is:body 限定符锚点")).toEqual([
        "3:issue",
        "2:issue",
        "1:issue",
      ]);
      expect((await search("label: is:body 限定符锚点")).diagnostics).toEqual(
        [],
      );
    });
  });

  describe("harness: and session: follow the text, not the card", () => {
    it("matches each domain against its own provenance", async () => {
      // Card 1 was opened by codex but commented by claude-code, and card 2's
      // spec is codex's while its body is nobody's — so a per-card reading
      // would answer all three of these wrongly.
      expect(await kinds("harness:codex 限定符锚点")).toEqual([
        "1:issue",
        "2:spec",
      ]);
      expect(await kinds("harness:claude-code 限定符锚点")).toEqual([
        "1:comment",
      ]);
      expect(await kinds("harness:pi 限定符锚点")).toEqual(["3:issue"]);
    });

    it("harness:none is the writes that report no agent at all", async () => {
      expect(await kinds("harness:none 限定符锚点")).toEqual([
        "2:issue",
        "2:comment",
      ]);
    });

    it("takes several harnesses as any-of, and negates", async () => {
      expect(await kinds("harness:codex,pi is:body 限定符锚点")).toEqual([
        "3:issue",
        "1:issue",
      ]);
      expect(await kinds("-harness:codex is:body 限定符锚点")).toEqual([
        "3:issue",
        "2:issue",
      ]);
    });

    it("counts a write with no agent context as not that harness", async () => {
      // The comment on card 2 was typed by a person. `agent_context ->> …`
      // is NULL there, and a bare `not (… = 'codex')` would be NULL too —
      // silently hiding exactly the rows a negation is usually reaching for.
      expect(await kinds("-harness:codex is:comment 限定符锚点")).toEqual([
        "2:comment",
        "1:comment",
      ]);
      expect(await kinds("-session:sess-c is:spec 限定符锚点")).toEqual([]);
      expect(await kinds("-session:sess-a is:comment 限定符锚点")).toEqual([
        "2:comment",
        "1:comment",
      ]);
    });

    it("session: picks one run of one agent", async () => {
      expect(await kinds("session:sess-a 限定符锚点")).toEqual(["1:issue"]);
      expect(await kinds("session:sess-b 限定符锚点")).toEqual(["1:comment"]);
      expect(await kinds("session:sess-c 限定符锚点")).toEqual(["2:spec"]);
    });

    it("reads an empty reported session as no session", async () => {
      // Card 3 reported `session_id: ""`. It must not answer to the empty
      // string, and negating any session must still count it as sessionless —
      // the same `nullif` the timeline's self-filter applies.
      expect(await kinds('session:"" is:body 限定符锚点')).toEqual([
        "3:issue",
        "2:issue",
        "1:issue",
      ]);
      expect(await kinds("-session:sess-a is:body 限定符锚点")).toEqual([
        "3:issue",
        "2:issue",
      ]);
    });
  });

  describe("a query of qualifiers alone", () => {
    it("is answered rather than refused", async () => {
      const { items } = await search("harness:codex");
      expect(items.map((i) => `${i.issue.number}:${i.kind}`)).toEqual([
        "1:issue",
        "2:spec",
      ]);
    });

    it("still carries a snippet for each hit", async () => {
      const { items } = await search("is:body label:area:web");
      expect(items.map((i) => i.snippet.text)).toEqual([
        "正文三 限定符锚点",
        "正文一 限定符锚点",
      ]);
      expect(items.every((i) => i.snippet.ranges.length === 0)).toBe(true);
    });
  });

  describe("diagnostics", () => {
    it("reports a value that names nothing, and returns no rows", async () => {
      const { items, diagnostics } = await search("label:不存在 限定符锚点");
      expect(items).toEqual([]);
      expect(diagnostics).toEqual([
        {
          severity: "error",
          key: "label",
          value: "不存在",
          message: 'no label named "不存在" in this project',
          suggestion: null,
        },
      ]);
    });

    it("suggests the closed-set value sharing the longest prefix", async () => {
      const { diagnostics } = await search("status:Nex 限定符锚点");
      expect(diagnostics[0]).toMatchObject({
        severity: "error",
        key: "status",
        suggestion: "Next",
      });
      expect(
        (await search("state:opne 限定符锚点")).diagnostics[0],
      ).toMatchObject({
        severity: "error",
        key: "state",
        message: '"opne" is not a state (open, closed)',
        suggestion: "open",
      });
      expect(
        (await search("is:body,pr 限定符锚点")).diagnostics[0],
      ).toMatchObject({
        severity: "error",
        key: "is",
        message: '"pr" is not searchable (body, comment, spec)',
      });
    });

    it("notes an unfamiliar harness but still matches it literally", async () => {
      const { diagnostics } = await search("harness:claud 限定符锚点");
      expect(diagnostics).toEqual([
        {
          severity: "note",
          key: "harness",
          value: "claud",
          message:
            '"claud" is not a harness todou knows (claude-code, codex, hermes-agent, pi); matching it literally',
          suggestion: "claude-code",
        },
      ]);
    });

    it("notes an is:/in= pair with nothing in common", async () => {
      const { items, diagnostics } = await search(
        "is:comment 限定符锚点",
        "&in=specs",
      );
      expect(items).toEqual([]);
      expect(diagnostics).toEqual([
        {
          severity: "note",
          key: "is",
          value: null,
          message: "is: and in= select no domain in common",
          suggestion: null,
        },
      ]);
    });

    it("says nothing about a session, which has no set to check", async () => {
      expect((await search("session:nobody 限定符锚点")).diagnostics).toEqual(
        [],
      );
    });

    it("is an empty array on a clean query", async () => {
      expect((await search("限定符锚点")).diagnostics).toEqual([]);
    });
  });

  describe("what stays plain text", () => {
    it("leaves an unknown key alone", async () => {
      // `kind:bug` is a label here, but `kind:` is not a qualifier — so this
      // is a literal search, and it finds nothing rather than the two cards
      // carrying the label.
      expect(await kinds("kind:bug")).toEqual([]);
      expect(await kinds("https://example.com/x")).toEqual([]);
    });

    it("searches a known key literally once it is quoted", async () => {
      await comment(1, "字面量 harness: 出现在这句里");
      expect(await kinds('"harness:" 字面量')).toEqual(["1:comment"]);
    });
  });
});

describe("buildSnippet", () => {
  it("returns short text whole, with every hit marked", () => {
    const snippet = buildSnippet("alpha beta alpha", ["alpha"]);
    expect(snippet.text).toBe("alpha beta alpha");
    expect(snippet.ranges).toEqual([
      [0, 5],
      [11, 16],
    ]);
  });

  it("folds whitespace so a snippet is one line", () => {
    const snippet = buildSnippet("first\n\nsecond   third", ["second"]);
    expect(snippet.text).toBe("first second third");
    expect(snippet.text.slice(...(snippet.ranges[0] as [number, number]))).toBe(
      "second",
    );
  });

  it("windows around the first hit and marks the ellipsis", () => {
    const text = `${"a".repeat(200)}needle${"b".repeat(200)}`;
    const snippet = buildSnippet(text, ["needle"], 10);
    expect(snippet.text).toBe(`…${"a".repeat(10)}needle${"b".repeat(10)}…`);
    const range = snippet.ranges[0] as [number, number];
    expect(snippet.text.slice(range[0], range[1])).toBe("needle");
  });

  it("never splits a surrogate pair at a window edge", () => {
    // Each 👍 is two UTF-16 units; a window measured in units would cut one
    // in half and emit a lone surrogate.
    const text = `${"👍".repeat(200)}needle${"👍".repeat(200)}`;
    const snippet = buildSnippet(text, ["needle"], 10);
    expect(snippet.text).toBe(`…${"👍".repeat(10)}needle${"👍".repeat(10)}…`);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(snippet.text)).toBe(false);
    const range = snippet.ranges[0] as [number, number];
    expect(snippet.text.slice(range[0], range[1])).toBe("needle");
  });

  it("clamps a hit straddling the window edge", () => {
    const text = `${"a".repeat(50)}needle-tail${"b".repeat(50)}`;
    const snippet = buildSnippet(text, ["needle", "tail"], 8);
    for (const [s, e] of snippet.ranges) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(e).toBeLessThanOrEqual(snippet.text.length);
    }
  });

  it("falls back to the head when nothing matches the folded text", () => {
    const snippet = buildSnippet("alpha  beta", ["alpha  beta"]);
    expect(snippet.ranges).toEqual([]);
    expect(snippet.text).toBe("alpha beta");
  });
});
