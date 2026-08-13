import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addUserWithToken,
  makeTestApp,
  PLACEMENTS,
  type TestApp,
} from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

describe.each(PLACEMENTS)("reference config (%s placement)", (placement) => {
  let t: TestApp;
  let cookie: string;
  let n = 0;
  const slug = () => `refs-${placement.replaceAll(/[^a-z]/g, "")}-${n++}`;

  beforeAll(async () => {
    t = await makeTestApp(placement);
    cookie = await t.login();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  async function createProject(s: string) {
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ slug: s, name: `Project ${s}` }),
    });
    expect(res.status).toBe(201);
    return json(res);
  }

  const getConfig = (s: string) =>
    t.app.request(`/api/projects/${s}/references/config`, {
      headers: { cookie },
    });
  const putFormat = (s: string, prefix: string | null) =>
    t.app.request(`/api/projects/${s}/references/format`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ prefix }),
    });
  const postAutolink = (s: string, prefix: string, url_template: string) =>
    t.app.request(`/api/projects/${s}/references/autolinks`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ prefix, url_template }),
    });

  it("returns the default shape for an unconfigured project", async () => {
    const s = slug();
    await createProject(s);
    const config = await json(await getConfig(s));
    expect(config).toEqual({
      format: { prefix: null, history: [] },
      autolinks: [],
    });
  });

  it("sets a format, appends history, and no-ops on the same value", async () => {
    const s = slug();
    await createProject(s);

    let config = await json(await putFormat(s, "T"));
    expect(config.format.prefix).toBe("T");
    expect(config.format.history).toHaveLength(1);
    expect(config.format.history[0].prefix).toBe("T");

    // Same value again: no new history row.
    config = await json(await putFormat(s, "T"));
    expect(config.format.history).toHaveLength(1);

    // Back to "#": appended, not rewritten.
    config = await json(await putFormat(s, null));
    expect(config.format.prefix).toBeNull();
    expect(config.format.history).toHaveLength(2);
    expect(
      config.format.history.map((h: { prefix: string | null }) => h.prefix),
    ).toEqual(["T", null]);
  });

  it("rejects malformed prefixes and templates", async () => {
    const s = slug();
    await createProject(s);
    // Internal prefix must start with a capital.
    expect((await putFormat(s, "t")).status).toBe(422);
    expect((await putFormat(s, "1T")).status).toBe(422);
    // Autolink prefix must not end with a digit.
    expect(
      (await postAutolink(s, "GH2", "https://x.example/<num>")).status,
    ).toBe(422);
    // Template needs exactly one <num>, http(s) only.
    expect((await postAutolink(s, "GH-", "https://x.example/")).status).toBe(
      422,
    );
    expect(
      (await postAutolink(s, "GH-", "https://x.example/<num>/<num>")).status,
    ).toBe(422);
    expect((await postAutolink(s, "GH-", "ftp://x.example/<num>")).status).toBe(
      422,
    );
  });

  it("enforces the overlap matrix", async () => {
    const s = slug();
    await createProject(s);

    const created = await json(
      await postAutolink(s, "TICKET", "https://x.example/<num>"),
    );
    expect(created.prefix).toBe("TICKET");

    // autolink × autolink: neither may be a string-prefix of the other.
    expect(
      (await postAutolink(s, "TICK", "https://y.example/<num>")).status,
    ).toBe(422);
    expect(
      (await postAutolink(s, "TICKET-X-", "https://y.example/<num>")).status,
    ).toBe(422);

    // autolink × current internal token "#".
    expect((await postAutolink(s, "#", "https://z.example/<num>")).status).toBe(
      422,
    );

    // Switching the internal format checks autolinks too: token "T-"
    // overlaps a "T" autolink. Fresh project — "T" would also overlap
    // the "TICKET" rule above, which is not what this asserts.
    const s2 = slug();
    await createProject(s2);
    const tRule = await postAutolink(s2, "T", "https://t.example/<num>");
    expect(tRule.status).toBe(201);
    expect((await putFormat(s2, "T")).status).toBe(422);
  });

  it("allows overlap with a historical token — the # handover", async () => {
    const s = slug();
    await createProject(s);
    await json(await putFormat(s, "T"));
    // "#" was the internal token before the switch; only the current
    // token is protected.
    const res = await postAutolink(
      s,
      "#",
      "https://github.com/o/r/issues/<num>",
    );
    expect(res.status).toBe(201);
    const config = await json(await getConfig(s));
    expect(config.autolinks).toHaveLength(1);
  });

  it("deletes autolinks and 404s on unknown ids", async () => {
    const s = slug();
    await createProject(s);
    const created = await json(
      await postAutolink(s, "JIRA-", "https://jira.example/<num>"),
    );
    const del = await t.app.request(
      `/api/projects/${s}/references/autolinks/${created.id}`,
      { method: "DELETE", headers: { cookie } },
    );
    expect(del.status).toBe(204);
    expect(
      (
        await t.app.request(
          `/api/projects/${s}/references/autolinks/${created.id}`,
          { method: "DELETE", headers: { cookie } },
        )
      ).status,
    ).toBe(404);
  });

  it("requires admin for writes, reader for the config", async () => {
    const s = slug();
    await createProject(s);
    const reader = await addUserWithToken(t.ctx, `refs-reader-${placement}`);
    await t.app.request(`/api/projects/${s}/members/${reader.user.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ role: "reader" }),
    });

    expect(
      (
        await t.app.request(`/api/projects/${s}/references/config`, {
          headers: reader.headers,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await t.app.request(`/api/projects/${s}/references/format`, {
          method: "PUT",
          headers: { "content-type": "application/json", ...reader.headers },
          body: JSON.stringify({ prefix: "T" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await t.app.request(`/api/projects/${s}/references/autolinks`, {
          method: "POST",
          headers: { "content-type": "application/json", ...reader.headers },
          body: JSON.stringify({
            prefix: "GH-",
            url_template: "https://x.example/<num>",
          }),
        })
      ).status,
    ).toBe(403);
  });
});
