import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
type Json = any;

const BODY =
  "# Crash on save\n\nSteps: open [the editor](https://example.com).";
const PREVIEW = "Crash on save Steps: open the editor.";

describe("untitled issues (T-785)", () => {
  let t: TestApp;
  let cookie: string;
  const P = "untitled";
  const Q = "untitled-strict";

  async function req(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) {
    return t.app.request(`/api${path}`, {
      method: init.method ?? "GET",
      headers: {
        cookie,
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  }
  async function ok(
    path: string,
    init: Parameters<typeof req>[1] = {},
    status = 200,
  ): Promise<Json> {
    const res = await req(path, init);
    expect(res.status, `${path}: ${await res.clone().text()}`).toBe(status);
    return status === 204 ? undefined : res.json();
  }
  async function refused(
    path: string,
    init: Parameters<typeof req>[1],
    message: string,
  ) {
    const res = await req(path, init);
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain(message);
  }
  const create = (slug: string, body: unknown) =>
    ok(`/projects/${slug}/issues`, { method: "POST", body }, 201);
  const get = (slug: string, n: number) => ok(`/projects/${slug}/issues/${n}`);
  const timelineOf = async (slug: string, n: number) =>
    (await ok(`/projects/${slug}/issues/${n}/timeline`)).items as Json[];

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    for (const slug of [P, Q]) {
      await ok(
        "/projects",
        { method: "POST", body: { slug, name: slug } },
        201,
      );
    }
    await ok(`/projects/${Q}`, {
      method: "PATCH",
      body: { require_title: true },
    });
  });
  afterAll(async () => {
    await t.cleanup();
  });

  describe("create and edit", () => {
    it("creates a card with no title field and reads it back as untitled", async () => {
      const made = await create(P, { body: BODY });
      expect(made.title).toBe("");
      expect(made.body_preview).toBe(PREVIEW);
      const read = await get(P, made.number);
      expect(read.title).toBe("");
      expect(read.body_preview).toBe(PREVIEW);
    });

    it("refuses a card with neither title nor body and burns no number", async () => {
      const before = await create(P, { title: "number probe" });
      await refused(
        `/projects/${P}/issues`,
        { method: "POST", body: { title: "  ", body: " \n\t" } },
        "an issue needs a title or a body",
      );
      await refused(
        `/projects/${P}/issues`,
        { method: "POST", body: {} },
        "an issue needs a title or a body",
      );
      const after = await create(P, { title: "number probe 2" });
      expect(after.number).toBe(before.number + 1);
    });

    it("trims the title on create and on edit", async () => {
      const spaced = await create(P, { title: " a ", body: "x" });
      expect(spaced.title).toBe("a");
      const blank = await create(P, { title: "   ", body: "only body" });
      expect(blank.title).toBe("");
      expect(blank.body_preview).toBe("only body");
    });

    it("writes no title_changed for a whitespace-only rename", async () => {
      const card = await create(P, { title: "Same" });
      const events = (await timelineOf(P, card.number)).length;
      const edited = await ok(`/projects/${P}/issues/${card.number}`, {
        method: "PATCH",
        body: { title: "  Same  " },
      });
      expect(edited.title).toBe("Same");
      expect(await timelineOf(P, card.number)).toHaveLength(events);
    });

    it("clears a title with an empty string and records both sides", async () => {
      const card = await create(P, { title: "Named", body: "has a body" });
      const edited = await ok(`/projects/${P}/issues/${card.number}`, {
        method: "PATCH",
        body: { title: "" },
      });
      expect(edited.title).toBe("");
      expect(edited.body_preview).toBe("has a body");
      const renamed = (await timelineOf(P, card.number)).find(
        (i) => i.event_type === "title_changed",
      );
      expect(renamed.payload).toEqual({ from: "Named", to: "" });
    });

    it("refuses an edit that would leave title and body both blank", async () => {
      const titled = await create(P, { title: "Keep me" });
      await refused(
        `/projects/${P}/issues/${titled.number}`,
        { method: "PATCH", body: { title: " " } },
        "an issue needs a title or a body",
      );
      expect((await get(P, titled.number)).title).toBe("Keep me");

      const untitled = await create(P, { body: "keep this body" });
      await refused(
        `/projects/${P}/issues/${untitled.number}`,
        { method: "PATCH", body: { body: "  " } },
        "an issue needs a title or a body",
      );
      const read = await get(P, untitled.number);
      expect(read.body).toBe("keep this body");
      expect(read.body_edited_at).toBeNull();
    });
  });

  describe("require_title", () => {
    it("reads back on the project GET and PATCH", async () => {
      expect((await ok(`/projects/${Q}`)).require_title).toBe(true);
      expect((await ok(`/projects/${P}`)).require_title).toBe(false);
    });

    it("refuses an untitled create, and the title-or-body rule wins", async () => {
      await refused(
        `/projects/${Q}/issues`,
        { method: "POST", body: { body: "a body" } },
        "this project requires a title",
      );
      await refused(
        `/projects/${Q}/issues`,
        { method: "POST", body: { title: "" } },
        "an issue needs a title or a body",
      );
    });

    it("refuses clearing a title but lets an untitled card's body be edited", async () => {
      const titled = await create(Q, { title: "Titled", body: "b" });
      await refused(
        `/projects/${Q}/issues/${titled.number}`,
        { method: "PATCH", body: { title: "" } },
        "this project requires a title",
      );
      expect((await get(Q, titled.number)).title).toBe("Titled");

      await ok(`/projects/${Q}`, {
        method: "PATCH",
        body: { require_title: false },
      });
      const untitled = await create(Q, { body: "made while it was off" });
      await ok(`/projects/${Q}`, {
        method: "PATCH",
        body: { require_title: true },
      });
      const edited = await ok(`/projects/${Q}/issues/${untitled.number}`, {
        method: "PATCH",
        body: { body: "edited after it went on" },
      });
      expect(edited.title).toBe("");
      expect(edited.body).toBe("edited after it went on");
    });

    it("lets an untitled card move into a project that requires a title", async () => {
      const untitled = await create(P, { body: "moving across" });
      await ok(`/projects/${P}/issues/${untitled.number}/move`, {
        method: "POST",
        body: { to_project: Q },
      });
    });

    it("refuses the setting to a non-admin member", async () => {
      const bob = await addUserWithToken(t.ctx, "bot-one");
      await ok(
        `/projects/${Q}/members`,
        { method: "POST", body: { login: "bot-one", role: "writer" } },
        201,
      );
      const res = await t.app.request(`/api/projects/${Q}`, {
        method: "PATCH",
        headers: { ...bob.headers, "content-type": "application/json" },
        body: JSON.stringify({ require_title: false }),
      });
      expect(res.status).toBe(403);
      expect((await ok(`/projects/${Q}`)).require_title).toBe(true);
    });
  });

  describe("body_preview on every display shape", () => {
    const slug = "untitled-reads";
    let titled: Json;
    let untitled: Json;

    beforeAll(async () => {
      await ok(
        "/projects",
        { method: "POST", body: { slug, name: slug } },
        201,
      );
      titled = await create(slug, {
        title: "Parakeet titled",
        body: "parakeet body",
      });
      untitled = await create(slug, { body: `${BODY}\n\nparakeet` });
      for (const card of [titled, untitled]) {
        await ok(
          `/projects/${slug}/issues/${card.number}/comments`,
          { method: "POST", body: { body: "parakeet comment" } },
          201,
        );
        await ok(`/projects/${slug}/issues/${card.number}/spec/push`, {
          method: "POST",
          body: { files: [{ path: "design.md", body: "parakeet spec" }] },
        });
      }
    });

    const expectPreviews = (rows: Json[], numberOf: (row: Json) => number) => {
      const byNumber = new Map(rows.map((r) => [numberOf(r), r]));
      expect(byNumber.get(titled.number)?.body_preview).toBeNull();
      expect(byNumber.get(untitled.number)?.body_preview).toBe(
        `${PREVIEW} parakeet`,
      );
    };

    it("get", async () => {
      expect((await get(slug, titled.number)).body_preview).toBeNull();
      expect((await get(slug, untitled.number)).body_preview).toBe(
        `${PREVIEW} parakeet`,
      );
    });

    it("list and list with numbers=", async () => {
      expectPreviews(
        (await ok(`/projects/${slug}/issues`)).items,
        (r) => r.number,
      );
      expectPreviews(
        (
          await ok(
            `/projects/${slug}/issues?numbers=${titled.number},${untitled.number}`,
          )
        ).items,
        (r) => r.number,
      );
    });

    it.each(["issue", "comment", "spec"])("search, %s hits", async (kind) => {
      const page = await ok(`/projects/${slug}/search?q=parakeet`);
      const hits = page.items.filter((i: Json) => i.kind === kind);
      expect(hits.length).toBeGreaterThanOrEqual(2);
      expectPreviews(
        hits.map((h: Json) => h.issue),
        (r) => r.number,
      );
    });

    it("mute list", async () => {
      for (const card of [titled, untitled]) {
        await ok(
          `/projects/${slug}/issues/${card.number}/mute`,
          {
            method: "PUT",
            body: { mode: "forever" },
          },
          204,
        );
      }
      const list = await ok("/me/mutes");
      expectPreviews(
        list.issues.filter((i: Json) => i.project.slug === slug),
        (r) => r.number,
      );
    });

    it("activity calendar", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const tomorrow = new Date(Date.now() + 86_400_000)
        .toISOString()
        .slice(0, 10);
      const page = await ok(
        `/projects/${slug}/insights/activity?from=${today}&to=${tomorrow}&tz=UTC&day=${today}`,
      );
      expectPreviews(page.selection.items, (r) => r.number);
    });
  });
});
