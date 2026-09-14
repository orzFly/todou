import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectMembers } from "../src/db/system-schema.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

type Headers = Record<string, string>;
type Human = { id: number; headers: Headers };

describe("agent memberships (T-227)", () => {
  let t: TestApp;
  // The first human is instance admin (auth/provision.ts), for whom every
  // project is manageable — so anything asserting "I cannot manage this"
  // needs both identities built with addUserWithToken instead.
  let adminCookie: string;

  beforeAll(async () => {
    t = await makeTestApp();
    adminCookie = await t.login();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  const sending = (headers: Headers): Headers => ({
    "content-type": "application/json",
    ...headers,
  });

  async function human(login: string): Promise<Human> {
    const added = await addUserWithToken(t.ctx, login);
    return { id: added.user.id, headers: added.headers };
  }

  async function createAgent(who: Human, login: string) {
    const res = await t.app.request("/api/agents", {
      method: "POST",
      headers: sending(who.headers),
      body: JSON.stringify({ login, display_name: `Agent ${login}` }),
    });
    expect(res.status).toBe(201);
    return json(res);
  }

  async function createProject(who: Human, slug: string) {
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: sending(who.headers),
      body: JSON.stringify({ slug, name: slug.toUpperCase() }),
    });
    expect(res.status).toBe(201);
    return json(res);
  }

  async function addMember(
    who: Human,
    slug: string,
    userId: number,
    role: string,
  ) {
    const res = await t.app.request(`/api/projects/${slug}/members/${userId}`, {
      method: "PUT",
      headers: sending(who.headers),
      body: JSON.stringify({ role }),
    });
    expect(res.status).toBe(204);
  }

  async function memberships(headers: Headers) {
    const res = await t.app.request("/api/me/agent-memberships", { headers });
    expect(res.status).toBe(200);
    return json(res);
  }

  const slugsOf = (rows: { project: { slug: string } }[]) =>
    rows.map((r) => r.project.slug);
  const projectSlugs = (rows: { slug: string }[]) => rows.map((p) => p.slug);
  const roleBySlug = (rows: { slug: string; my_role?: string }[]) =>
    Object.fromEntries(rows.map((p) => [p.slug, p.my_role]));

  it("lists every membership of every agent I own", async () => {
    const alice = await human("alice-shape");
    const agent = await createAgent(alice, "shape-bot");
    await createProject(alice, "shape-alpha");
    await createProject(alice, "shape-beta");
    await addMember(alice, "shape-alpha", agent.id, "admin");
    await addMember(alice, "shape-beta", agent.id, "reader");

    const body = await memberships(alice.headers);

    expect(body.memberships).toHaveLength(2);
    const alpha = body.memberships.find(
      (m: { project: { slug: string } }) => m.project.slug === "shape-alpha",
    );
    expect(alpha.agent_id).toBe(agent.id);
    expect(alpha.role).toBe("admin");
    expect(typeof alpha.created_at).toBe("string");
    // A brief, not a whole Project: no description, no created_at.
    expect(Object.keys(alpha.project).sort()).toEqual(["id", "name", "slug"]);
    expect(
      body.memberships.find(
        (m: { project: { slug: string } }) => m.project.slug === "shape-beta",
      ).role,
    ).toBe("reader");
    expect(projectSlugs(body.manageable_projects)).toEqual([
      "shape-alpha",
      "shape-beta",
    ]);
  });

  it("lists a project the owner cannot read, and marks it unmanageable", async () => {
    const alice = await human("alice-blind");
    const bob = await human("bob-blind");
    const agent = await createAgent(alice, "blind-bot");
    const project = await createProject(bob, "bobland");
    // Written straight into the table: the API refuses to put a machine
    // where its owner holds nothing (T-340), so the only way this row comes
    // about now is an owner who left or lost their instance-admin flag. That
    // state still has to list, which is what this covers.
    await t.ctx.router.system().insert(projectMembers).values({
      projectId: project.id,
      userId: agent.id,
      role: "writer",
    });

    // Alice really cannot read it — the endpoint lists it anyway, because
    // she could enumerate it with a PAT issued to her own agent.
    const direct = await t.app.request("/api/projects/bobland", {
      headers: alice.headers,
    });
    expect(direct.status).toBe(404);

    const body = await memberships(alice.headers);

    expect(slugsOf(body.memberships)).toContain("bobland");
    expect(projectSlugs(body.manageable_projects)).not.toContain("bobland");
  });

  it("refuses to put a machine where its owner holds nothing", async () => {
    const alice = await human("alice-ceiling");
    const bob = await human("bob-ceiling");
    const agent = await createAgent(alice, "ceiling-bot");
    await createProject(bob, "ceilingland");

    const res = await t.app.request(
      `/api/projects/ceilingland/members/${agent.id}`,
      {
        method: "PUT",
        headers: sending(bob.headers),
        body: JSON.stringify({ role: "writer" }),
      },
    );

    expect(res.status).toBe(409);
    expect((await json(res)).error.message).toContain("@alice-ceiling");
  });

  it("never leaks another owner's agents", async () => {
    const alice = await human("alice-scope");
    const bob = await human("bob-scope");
    const bobAgent = await createAgent(bob, "scope-bob-bot");
    await createProject(bob, "scope-bobs");
    await addMember(bob, "scope-bobs", bobAgent.id, "writer");
    await createAgent(alice, "scope-alice-bot");

    const body = await memberships(alice.headers);

    expect(
      body.memberships.some(
        (m: { agent_id: number }) => m.agent_id === bobAgent.id,
      ),
    ).toBe(false);
  });

  it("counts any membership as manageable, carrying the role it caps at", async () => {
    const alice = await human("alice-manage");
    const bob = await human("bob-manage");
    await createProject(alice, "manage-mine");
    await createProject(bob, "manage-theirs");
    await addMember(bob, "manage-theirs", alice.id, "writer");
    await createProject(bob, "manage-hidden");

    const mine = (await memberships(alice.headers)).manageable_projects;

    // A writer's project counts now (T-340) — arranging your own machines is
    // yours at any role — and `my_role` is what caps them there.
    expect(roleBySlug(mine)).toEqual({
      "manage-mine": "admin",
      "manage-theirs": "writer",
    });
  });

  it("keeps every project manageable for an instance admin, who holds no row", async () => {
    const bob = await human("bob-instance");
    await createProject(bob, "instance-theirs");

    const all = (await memberships({ cookie: adminCookie }))
      .manageable_projects;

    // The literal reading of "projects I hold a membership row in" would take
    // this set from every project to none: an instance admin holds none.
    expect(projectSlugs(all)).toContain("instance-theirs");
    expect(all.every((p: { my_role?: string }) => p.my_role === "admin")).toBe(
      true,
    );
  });

  it("answers a user with no agents with two empty lists", async () => {
    const carol = await human("carol-empty");

    expect(await memberships(carol.headers)).toEqual({
      memberships: [],
      manageable_projects: [],
    });
  });

  it("sorts by role first, then by slug", async () => {
    const alice = await human("alice-order");
    const agent = await createAgent(alice, "order-bot");
    for (const slug of ["order-z", "order-a", "order-m"]) {
      await createProject(alice, slug);
    }
    await addMember(alice, "order-z", agent.id, "admin");
    await addMember(alice, "order-a", agent.id, "writer");
    await addMember(alice, "order-m", agent.id, "writer");

    const body = await memberships(alice.headers);

    // admin wins despite sorting last by slug; the writers then go a, m.
    expect(slugsOf(body.memberships)).toEqual([
      "order-z",
      "order-a",
      "order-m",
    ]);
  });
});
