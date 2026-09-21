import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbRouter } from "../src/db/router.ts";
import { makeRouter } from "./helpers.ts";
import { testTmpDir } from "./setup.ts";

const driver = vi.hoisted(() => ({
  opens: [] as string[],
  closes: [] as string[],
  closeGates: new Map<string, Promise<void>>(),
}));

// A fake driver rather than real handles: the eviction policy only reads urls
// and the pin table, the interleaving B3 needs is "B finishes a whole pass
// while A is still parked inside close()", and a file-backed PGlite costs
// ~1.8s per instance to open.
vi.mock("../src/db/driver.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/driver.ts")>();
  return {
    ...actual,
    openDb: async (url: string) => {
      driver.opens.push(url);
      // A real open always yields; without this two racing callers would not
      // overlap and the single-flight case below could not fail.
      await new Promise((resolve) => setTimeout(resolve, 1));
      return {
        db: {} as never,
        kind: "pglite" as const,
        url,
        migrate: async () => {},
        close: async () => {
          driver.closes.push(url);
          await driver.closeGates.get(url);
        },
      };
    },
  };
});

const openRouters: DbRouter[] = [];

async function open(...args: Parameters<typeof makeRouter>) {
  const made = await makeRouter(...args);
  openRouters.push(made.router);
  return made;
}

beforeEach(() => {
  driver.opens.length = 0;
  driver.closes.length = 0;
  driver.closeGates.clear();
});

afterEach(async () => {
  for (const router of openRouters.splice(0)) {
    await router.close();
  }
});

const project = (id: number) => ({ id, slug: `p${id}`, database_url: null });
const routeOf = (p: ReturnType<typeof project>) => p;
const urlOf = (router: DbRouter, id: number) =>
  router.resolveProjectUrl(project(id));

function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** A task body that holds its group's handle until `release` is opened. */
function holdVia(router: DbRouter, id: number) {
  const entered = gate();
  const release = gate();
  const task = router.perDatabase([project(id)], routeOf, async () => {
    entered.open();
    await release.wait;
    return id;
  });
  return { entered, release, task };
}

// The fake driver never creates these directories; the templates point into a
// temp dir anyway so that a broken mock writes there and not into the repo.
const perProject = (dir: string) => `pglite://${dir}/p\${project.id}`;

describe("handle eviction", () => {
  it("still trims to max_open, oldest first (regression watchdog)", async () => {
    // Regression watchdog: green on the parent commit too. It only says the
    // rewritten loop did not break plain LRU.
    const dir = testTmpDir("todou-router-evict-");
    const { router } = await open("dedicated", {
      maxOpen: 2,
      urlTemplate: perProject(dir),
    });
    for (const id of [1, 2, 3, 4]) await router.forProject(project(id));
    expect(driver.closes).toEqual([urlOf(router, 1), urlOf(router, 2)]);
    expect(router.openHandleCount()).toBe(2);
  });

  it("skips an in-memory handle without giving up the round", async () => {
    const dir = testTmpDir("todou-router-evict-");
    const { router } = await open("dedicated", {
      maxOpen: 2,
      // compileUrlTemplate is a template literal in a Function body and the
      // TOML quotes it with single quotes, so the expression can only use
      // double quotes.
      urlTemplate: `pglite://\${project.id === 1 ? "memory/evict" : "${dir}/q" + project.id}`,
    });
    for (const id of [1, 2, 3, 4]) await router.forProject(project(id));
    expect(driver.closes).toEqual([urlOf(router, 2)]);
    // Three, not two: an in-memory handle can never be closed, so it holds a
    // budget slot forever. The round gives up that one candidate's slot, not
    // the rest of the scan.
    expect(router.openHandleCount()).toBe(3);
  });

  it("never evicts a pinned handle, a stale one, or one another open just returned", async () => {
    const dir = testTmpDir("todou-router-evict-");
    const { router } = await open("dedicated", {
      maxOpen: 2,
      urlTemplate: perProject(dir),
    });
    const held = [1, 2, 3, 4].map((id) => holdVia(router, id));
    for (const h of held) await h.entered.wait; // sequential entry pins the LRU order
    // Red on the parent commit as well, but on the fixture's premise (no pins
    // at all), not on the identity check or the candidate window this case
    // guards — those two only go red when the landed implementation is broken.
    expect(router.openHandleCount()).toBe(4); // all pinned: two passes gave up
    held[0]?.release.open();
    held[1]?.release.open();
    await Promise.all([held[0]?.task, held[1]?.task]);

    const holdClose = gate();
    driver.closeGates.set(urlOf(router, 1), holdClose.wait);
    const a = router.forProject(project(5));
    await vi.waitFor(() => expect(driver.closes).toContain(urlOf(router, 1)));
    // A whole second pass runs while A is parked inside close(p1).
    await router.forProject(project(6));
    holdClose.open();
    await expect(a).resolves.toBeDefined();
    expect(driver.closes).toEqual([urlOf(router, 1), urlOf(router, 2)]);
    expect(router.openHandleCount()).toBe(4); // p3/p4 pinned + p5 + p6
    held[2]?.release.open();
    held[3]?.release.open();
    await Promise.all([held[2]?.task, held[3]?.task]);
  });

  it("counts holders per url, and reclaims the excess on the next open", async () => {
    const dir = testTmpDir("todou-router-evict-");
    const { router } = await open("dedicated", {
      maxOpen: 1,
      urlTemplate: `pglite://${dir}/b\${project.id % 3}`,
    });
    await router.forProject(project(1)); // warm b1 so both holders hit the cache
    // two concurrent requests whose groups resolve to one url — only k < N
    // ever produces this, and a boolean pin set would lose the second holder
    const a = holdVia(router, 1);
    const b = holdVia(router, 4);
    await a.entered.wait;
    await b.entered.wait;
    a.release.open();
    await a.task;
    await router.forProject(project(2)); // b2
    expect(router.openHandleCount()).toBe(2);
    expect(driver.closes).toEqual([]);
    b.release.open();
    await b.task;
    await router.forProject(project(3)); // b0: the excess is collectable now
    expect(router.openHandleCount()).toBe(1);
    expect(driver.closes).toEqual([urlOf(router, 1), urlOf(router, 2)]);
  });

  it("opens a url once when two callers race for it", async () => {
    const dir = testTmpDir("todou-router-evict-");
    const { router } = await open("dedicated", {
      maxOpen: 2,
      urlTemplate: perProject(dir),
    });
    const [a, b] = await Promise.all([
      router.forProject(project(1)),
      router.forProject(project(1)),
    ]);
    expect(a).toBe(b);
    // PGlite does not lock its data directory, so a second instance on the
    // same one opens fine and silently corrupts it; the loser of the `set`
    // race is also dropped from the table and never closed.
    expect(driver.opens.filter((u) => u === urlOf(router, 1))).toHaveLength(1);
  });

  it("opens through the public forProject so the existing spies still fire (regression watchdog)", async () => {
    // Regression watchdog: the contract holds on the parent commit already.
    // It stands in for test/activity-calendar-access.test.ts, whose seven
    // `vi.spyOn(router, "forProject")` rely on the instance property shadowing
    // the prototype method — that file does not reach perDatabase yet, so it
    // cannot catch a pin that opens through the private path instead.
    const dir = testTmpDir("todou-router-evict-");
    const { router } = await open("dedicated", {
      maxOpen: 2,
      urlTemplate: perProject(dir),
    });
    const spy = vi.spyOn(router, "forProject");
    await router.perDatabase(
      [project(1), project(2), project(3)],
      routeOf,
      async () => 1,
    );
    expect(spy).toHaveBeenCalledTimes(3);
  });
});
