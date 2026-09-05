import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * The label catalog moved from admin to writer (T-264). One placement is
 * enough: the gate reads `project_members` out of the system tier, which no
 * placement mode moves.
 */
describe("who may edit the label catalog", () => {
  let t: TestApp;
  let cookie: string;
  const slug = "label-roles";
  const admin = () => ({ "content-type": "application/json", cookie });

  const tokens: Record<"reader" | "reporter" | "writer", string> = {
    reader: "",
    reporter: "",
    writer: "",
  };
  const as = (who: keyof typeof tokens) => ({
    "content-type": "application/json",
    authorization: tokens[who],
  });

  const createLabel = (headers: Record<string, string>, name: string) =>
    t.app.request(`/api/projects/${slug}/labels`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name }),
    });

  beforeAll(async () => {
    t = await makeTestApp("shared");
    cookie = await t.login();
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: admin(),
      body: JSON.stringify({ slug, name: "Label roles" }),
    });
    expect(created.status).toBe(201);

    for (const role of ["reader", "reporter", "writer"] as const) {
      const added = await addUserWithToken(t.ctx, `${role}-of-${slug}`);
      const res = await t.app.request(
        `/api/projects/${slug}/members/${added.user.id}`,
        {
          method: "PUT",
          headers: admin(),
          body: JSON.stringify({ role }),
        },
      );
      expect(res.status).toBe(204);
      tokens[role] = added.headers.authorization;
    }
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("lets a writer create, rename, recolor and delete", async () => {
    const created = await createLabel(as("writer"), "flaky");
    expect(created.status).toBe(201);
    const label = await json(created);

    const renamed = await t.app.request(
      `/api/projects/${slug}/labels/${label.id}`,
      {
        method: "PATCH",
        headers: as("writer"),
        body: JSON.stringify({ name: "flaky-test", color: "#ff0000" }),
      },
    );
    expect(renamed.status).toBe(200);
    expect(await json(renamed)).toMatchObject({
      name: "flaky-test",
      color: "#ff0000",
    });

    const removed = await t.app.request(
      `/api/projects/${slug}/labels/${label.id}`,
      { method: "DELETE", headers: as("writer") },
    );
    expect(removed.status).toBe(204);
  });

  it("still lets an admin do the same", async () => {
    const created = await createLabel(admin(), "wontfix");
    expect(created.status).toBe(201);
    const label = await json(created);
    const removed = await t.app.request(
      `/api/projects/${slug}/labels/${label.id}`,
      { method: "DELETE", headers: admin() },
    );
    expect(removed.status).toBe(204);
  });

  it("refuses a reporter and a reader", async () => {
    expect((await createLabel(as("reporter"), "from-reporter")).status).toBe(
      403,
    );
    expect((await createLabel(as("reader"), "from-reader")).status).toBe(403);
  });

  it("names the capability in the refusal", async () => {
    const res = await createLabel(as("reader"), "denied");
    expect((await json(res)).error.message).toBe(
      "requires writer role (label.create)",
    );
  });

  it("keeps reading the catalog open to every member", async () => {
    for (const who of ["reader", "reporter", "writer"] as const) {
      const res = await t.app.request(`/api/projects/${slug}/labels`, {
        headers: as(who),
      });
      expect(res.status).toBe(200);
    }
  });
});
