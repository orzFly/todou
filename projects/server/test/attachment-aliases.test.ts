import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addUserWithToken,
  makeTestApp,
  PLACEMENTS,
  type TestApp,
} from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

type Who = Record<string, string>;
type Alias = { project: string; id: number };
type Listed = {
  id: number;
  filename: string;
  url: string;
  aliases: Alias[];
};

/**
 * The addresses an attachment still answers on besides its current one
 * (T-242): what a move left behind, what a rename left behind, and which of
 * them a given reader is allowed to see.
 *
 * Moves here are real `POST /issues/{n}/move` calls rather than hand-written
 * rows — the ids this field maps are the executor's to mint, and a fixture
 * that chose them itself would not be testing the mapping.
 */
describe.each(PLACEMENTS)("attachment aliases (%s placement)", (placement) => {
  let t: TestApp;
  let cookie: string;
  let admin: Who;
  /** Reader of B only: may not learn these files came from anywhere else. */
  let destOnly: Who;

  const A = `alias-a-${placement}`;
  const B = `alias-b-${placement}`;
  const RENAMED_FROM = `alias-r-${placement}`;
  const RENAMED_TO = `alias-r2-${placement}`;
  const BOTH_FROM = `alias-s-${placement}`;
  const BOTH_TO = `alias-s2-${placement}`;
  const GIVEN_UP = `alias-p-${placement}`;
  const KEPT = `alias-p2-${placement}`;

  const req = (path: string, who: Who, init?: RequestInit) =>
    t.app.request(`/api${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json", ...who } : who),
        ...init?.headers,
      },
    });

  const newProject = async (slug: string, reclaim = false) => {
    const res = await req("/projects", admin, {
      method: "POST",
      body: JSON.stringify({
        slug,
        name: slug,
        ...(reclaim ? { reclaim } : {}),
      }),
    });
    expect(res.status).toBe(201);
  };

  const rename = async (slug: string, next: string) => {
    const res = await req(`/projects/${slug}`, admin, {
      method: "PATCH",
      body: JSON.stringify({ slug: next }),
    });
    expect(res.status).toBe(200);
  };

  const createIssue = async (slug: string) => {
    const res = await req(`/projects/${slug}/issues`, admin, {
      method: "POST",
      body: JSON.stringify({ title: `card in ${slug}`, body: "" }),
    });
    expect(res.status).toBe(201);
    return (await json(res)) as { id: number; number: number };
  };

  /**
   * Multipart goes through `t.app.request` directly: the json helper above
   * would stamp a content-type on the body and the route would 422.
   */
  const upload = async (slug: string, number: number, filename: string) => {
    const form = new FormData();
    form.set("file", new File(["hello"], filename, { type: "text/plain" }));
    form.set("issue_number", String(number));
    const res = await t.app.request(`/api/projects/${slug}/attachments`, {
      method: "POST",
      headers: admin,
      body: form,
    });
    expect(res.status).toBe(201);
    return (await json(res)).id as number;
  };

  const move = async (from: string, number: number, to: string) => {
    const res = await req(`/projects/${from}/issues/${number}/move`, admin, {
      method: "POST",
      body: JSON.stringify({ to_project: to, dry_run: false }),
    });
    expect(res.status).toBe(200);
    return (await json(res)) as { moved_to: { slug: string; number: number } };
  };

  const list = async (
    slug: string,
    number: number,
    who: Who = admin,
  ): Promise<Listed[]> => {
    const res = await req(
      `/projects/${slug}/attachments?issue_number=${number}`,
      who,
    );
    expect(res.status).toBe(200);
    return (await json(res)) as Listed[];
  };

  const only = (items: Listed[]): Listed => {
    expect(items).toHaveLength(1);
    return items[0] as Listed;
  };

  beforeAll(async () => {
    t = await makeTestApp(placement);
    cookie = await t.login();
    admin = { cookie };
    for (const slug of [A, B, RENAMED_FROM, BOTH_FROM, GIVEN_UP]) {
      await newProject(slug);
    }

    const user = await addUserWithToken(t.ctx, `alias-dest-${placement}`);
    destOnly = user.headers;
    const res = await req(`/projects/${B}/members/${user.user.id}`, admin, {
      method: "PUT",
      body: JSON.stringify({ role: "reader" }),
    });
    expect(res.status).toBe(204);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  /**
   * The field's definition, executed: every address it lists resolves to
   * this very attachment, as a 200 where the address is still local or a
   * 301 pointing at the canonical URL.
   */
  const expectAliasesResolve = async (attachment: Listed) => {
    expect(attachment.aliases.length).toBeGreaterThan(0);
    for (const alias of attachment.aliases) {
      const res = await req(
        `/projects/${alias.project}/attachments/${alias.id}/download/${attachment.filename}`,
        admin,
      );
      expect([200, 301]).toContain(res.status);
      if (res.status === 301) {
        expect(res.headers.get("location")).toBe(attachment.url);
      }
    }
  };

  describe("a card that moved", () => {
    let landed = { number: 0 };
    let oldId = 0;

    beforeAll(async () => {
      const source = await createIssue(A);
      oldId = await upload(A, source.number, "note.txt");
      const result = await move(A, source.number, B);
      landed = { number: result.moved_to.number };
    });

    it("lists the address the file had in the project it came from", async () => {
      const found = only(await list(B, landed.number));
      expect(found.url).toContain(`/projects/${B}/`);
      // The slug travels with the id deliberately: under a per-project id
      // sequence the new id may be the same number as the old one, and only
      // the pair tells this file apart from `B`'s own attachment 1.
      expect(found.aliases).toEqual([{ project: A, id: oldId }]);
    });

    it("answers on every address it lists", async () => {
      await expectAliasesResolve(only(await list(B, landed.number)));
    });

    it("withholds a source project the reader cannot read", async () => {
      const full = only(await list(B, landed.number));
      const limited = only(await list(B, landed.number, destOnly));
      expect(limited.aliases).toEqual([]);
      // Everything else is the same list; only the provenance is withheld.
      expect({ ...limited, aliases: null }).toEqual({ ...full, aliases: null });
    });
  });

  it("keeps both historic addresses when a card comes back", async () => {
    const source = await createIssue(A);
    const firstId = await upload(A, source.number, "round-trip.txt");
    const toB = await move(A, source.number, B);
    const inB = only(await list(B, toB.moved_to.number));
    const back = await move(B, toB.moved_to.number, A);

    const found = only(await list(A, back.moved_to.number));
    expect(found.aliases).toEqual([
      { project: A, id: firstId },
      { project: B, id: inB.id },
    ]);
    // The canonical address is not one of its own aliases.
    expect(found.aliases).not.toContainEqual({ project: A, id: found.id });
    await expectAliasesResolve(found);
  });

  it("lists a retired slug of its own project, with the id unchanged", async () => {
    const card = await createIssue(RENAMED_FROM);
    const id = await upload(RENAMED_FROM, card.number, "renamed.txt");
    await rename(RENAMED_FROM, RENAMED_TO);

    const found = only(await list(RENAMED_TO, card.number));
    expect(found.id).toBe(id);
    expect(found.aliases).toEqual([{ project: RENAMED_FROM, id }]);
    await expectAliasesResolve(found);
  });

  it("lists the source project under both its names when it was renamed too", async () => {
    const card = await createIssue(BOTH_FROM);
    const oldId = await upload(BOTH_FROM, card.number, "travelled.txt");
    await rename(BOTH_FROM, BOTH_TO);
    const landed = await move(BOTH_TO, card.number, B);

    // The address book records a project id, so expanding it to the source's
    // current spelling alone would miss what was written before the rename.
    const found = only(await list(B, landed.moved_to.number));
    expect(found.aliases).toEqual([
      { project: BOTH_FROM, id: oldId },
      { project: BOTH_TO, id: oldId },
    ]);
    await expectAliasesResolve(found);
  });

  it("drops a retired slug another project has since taken", async () => {
    const card = await createIssue(GIVEN_UP);
    await upload(GIVEN_UP, card.number, "reclaimed.txt");
    await rename(GIVEN_UP, KEPT);
    expect(only(await list(KEPT, card.number)).aliases).toEqual([
      { project: GIVEN_UP, id: expect.any(Number) },
    ]);

    // Somebody else takes the slug: it no longer routes here, so offering it
    // as an alias would hand the reader another project's attachment.
    await newProject(GIVEN_UP, true);
    expect(only(await list(KEPT, card.number)).aliases).toEqual([]);
  });

  it("leaves the field empty for a card that never went anywhere", async () => {
    const card = await createIssue(B);
    await upload(B, card.number, "stayed.txt");
    expect(only(await list(B, card.number)).aliases).toEqual([]);
  });
});
