import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * Input a schema lets through must never reach the database in a shape the
 * driver throws on (T-730): an UPDATE with nothing to set, a number past a
 * PostgreSQL `integer` column, a body hono cannot parse at all. Each of those
 * answered 500.
 */
describe("bodies the handlers cannot use", () => {
  let t: TestApp;
  let cookie: string;
  const headers = () => ({ "content-type": "application/json", cookie });
  const send = (path: string, method: string, body?: string) =>
    t.app.request(path, { method, headers: headers(), body });
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    const post = async (path: string, body: unknown) =>
      json(await send(path, "POST", JSON.stringify(body)));
    await post("/api/projects", { slug: "p", name: "P" });
    const issue = await post("/api/projects/p/issues", { title: "one" });
    await post(`/api/projects/p/issues/${issue.number}/spec/push`, {
      files: [{ path: "a.md", body: "x" }],
    });
    const label = await post("/api/projects/p/labels", { name: "l" });
    const comment = await post(
      `/api/projects/p/issues/${issue.number}/comments`,
      { body: "c" },
    );
    const agent = await post("/api/agents", {
      login: "bot-one",
      display_name: "Bot",
    });
    const cli = await post("/api/auth/cli/requests", { name: "x" });
    const statuses = await json(
      await t.app.request("/api/projects/p/statuses", { headers: headers() }),
    );
    Object.assign(ids, {
      slug: "p",
      number: String(issue.number),
      labelId: String(label.id),
      statusId: String(statuses[0].id),
      commentId: String(comment.id),
      id: String(agent.id),
      cliId: String(cli.id),
    });
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("no JSON route answers 5xx to an empty, unknown-only or unparseable body", async () => {
    const doc = await json(await t.app.request("/api/openapi.json"));
    const routes: [string, string][] = [];
    for (const [path, ops] of Object.entries<Record<string, unknown>>(
      doc.paths,
    )) {
      for (const [method, op] of Object.entries(ops)) {
        // biome-ignore lint/suspicious/noExplicitAny: OpenAPI document
        if ((op as any).requestBody?.content?.["application/json"]) {
          const filled = path.replace(/\{(\w+)\}/g, (_, k: string) =>
            path.startsWith("/api/auth/cli/") && k === "id"
              ? (ids.cliId as string)
              : (ids[k] ?? "1"),
          );
          routes.push([method.toUpperCase(), filled]);
        }
      }
    }
    // A route added without a JSON body would shrink this unnoticed.
    expect(routes.length).toBeGreaterThan(40);

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed: string[] = [];
    try {
      for (const [method, path] of routes) {
        for (const body of ["{}", '{"zz_unknown":1}', "{", undefined]) {
          const res = await send(path, method, body);
          if (res.status >= 500) failed.push(`${method} ${path} ${body}`);
        }
      }
    } finally {
      errors.mockRestore();
    }
    expect(failed).toEqual([]);
  });

  it("answers an unparseable body with 400 bad_request", async () => {
    const res = await send("/api/me", "PATCH", "{");
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("bad_request");
  });

  it("treats a patch naming nothing as a read", async () => {
    const me = await json(
      await t.app.request("/api/me", { headers: headers() }),
    );
    for (const [path, id, name] of [
      ["/api/me", me.id, me.display_name],
      [`/api/agents/${ids.id}`, Number(ids.id), "Bot"],
      [`/api/projects/p/labels/${ids.labelId}`, Number(ids.labelId), "l"],
    ] as const) {
      const res = await send(path, "PATCH", '{"name_typo":"x"}');
      expect(res.status, path).toBe(200);
      const after = await json(res);
      expect(after.id, path).toBe(id);
      expect(after.display_name ?? after.name, path).toBe(name);
    }
    const status = await send(
      `/api/projects/p/statuses/${ids.statusId}`,
      "PATCH",
      "{}",
    );
    expect(status.status).toBe(200);
    expect((await json(status)).id).toBe(Number(ids.statusId));
    const missing = await send("/api/projects/p/labels/999", "PATCH", "{}");
    expect(missing.status).toBe(404);
    const gone = await send("/api/projects/p/statuses/999", "PATCH", "{}");
    expect(gone.status).toBe(404);
  });

  it("refuses a status position past PostgreSQL's integer", async () => {
    const created = await send(
      "/api/projects/p/statuses",
      "POST",
      JSON.stringify({ name: "big", category: "open", position: 2 ** 31 }),
    );
    expect(created.status).toBe(422);
    const moved = await send(
      `/api/projects/p/statuses/${ids.statusId}`,
      "PATCH",
      JSON.stringify({ position: -(2 ** 31) - 1 }),
    );
    expect(moved.status).toBe(422);
  });

  it("refuses to append a status after one at the highest position", async () => {
    const top = await send(
      "/api/projects/p/statuses",
      "POST",
      JSON.stringify({ name: "top", category: "open", position: 2 ** 31 - 1 }),
    );
    expect(top.status).toBe(201);
    const next = await send(
      "/api/projects/p/statuses",
      "POST",
      JSON.stringify({ name: "after-top", category: "open" }),
    );
    expect(next.status).toBe(409);
    const removed = await send(
      `/api/projects/p/statuses/${(await json(top)).id}`,
      "DELETE",
    );
    expect(removed.status).toBe(204);
  });

  it("refuses a spec version past PostgreSQL's integer", async () => {
    const spec = `/api/projects/p/issues/${ids.number}/spec`;
    const files = await t.app.request(`${spec}/files?version=${2 ** 31}`, {
      headers: headers(),
    });
    expect(files.status).toBe(422);
    const review = await send(
      `${spec}/reviews`,
      "POST",
      JSON.stringify({
        version: 1,
        verdict: "comment",
        comments: [{ anchor: { path: "a.md", version: 2 ** 31 }, body: "x" }],
      }),
    );
    expect(review.status).toBe(422);
  });

  it("asks for the file when a project icon upload carries none", async () => {
    const res = await t.app.request("/api/projects/p/icon", {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(422);
  });
});
