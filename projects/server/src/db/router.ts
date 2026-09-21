import type { Logger } from "drizzle-orm/logger";
import type { Config, ProjectRouteInfo } from "../config.ts";
import { type Db, type DbHandle, openDb } from "./driver.ts";

export type DbTestHooks = {
  onQuery?(sql: string, params: unknown[], url: string): void;
};

function queryLogger(url: string, hooks?: DbTestHooks): Logger | undefined {
  const onQuery = hooks?.onQuery;
  return onQuery && { logQuery: (sql, params) => onQuery(sql, params, url) };
}

/**
 * Routes queries to the system database and to per-project databases.
 * Handles are cached by RESOLVED URL, so any number of projects whose
 * template resolves to the same target share one connection.
 */
export class DbRouter {
  #config: Config;
  #system: DbHandle;
  /** url → handle, insertion order doubles as LRU order. */
  #projectHandles = new Map<string, DbHandle>();
  /**
   * Resolved url → how many task bodies are holding that handle right now.
   * Keyed by url rather than kept on the DbHandle: a handle can be evicted
   * and reopened as a new object, while eviction, closeUrl and #migrated all
   * account by url — a count on the object would silently reset.
   */
  #pins = new Map<string, number>();
  /**
   * url → the open already under way for it. Opening awaits the driver and
   * the migration before the handle reaches #projectHandles, so without this
   * two concurrent callers each build a PGlite on the same data directory —
   * PGlite does not lock it — and the first one written is then overwritten,
   * left out of the table and never closed.
   */
  #opening = new Map<string, Promise<DbHandle>>();
  /** urls whose project-tier migrations already ran in this process */
  #migrated = new Set<string>();
  // Kept on the instance rather than resolved into loggers once in open():
  // project handles are opened lazily, so at open() time they do not exist.
  #hooks: DbTestHooks | undefined;

  private constructor(config: Config, system: DbHandle, hooks?: DbTestHooks) {
    this.#config = config;
    this.#system = system;
    this.#hooks = hooks;
  }

  static async open(config: Config, hooks?: DbTestHooks): Promise<DbRouter> {
    const system = await openDb(config.database.system, {
      pool: config.database.pool,
      logger: queryLogger(config.database.system, hooks),
    });
    if (shouldAutoMigrate(config, system.kind)) {
      await system.migrate("system");
      // Shared placement keeps project-tier tables in the system database.
      if (config.database.projects.placement === "shared") {
        await system.migrate("project");
      }
    }
    return new DbRouter(config, system, hooks);
  }

  system(): Db {
    return this.#system.db;
  }

  systemHandle(): DbHandle {
    return this.#system;
  }

  resolveProjectUrl(project: ProjectRouteInfo): string {
    if (project.database_url) return project.database_url;
    if (this.#config.database.projects.placement === "shared") {
      return this.#config.database.system;
    }
    const template = this.#config.projectUrlFor;
    if (!template) {
      throw new Error("dedicated placement requires a compiled url_template");
    }
    return template(project);
  }

  async forProject(project: ProjectRouteInfo): Promise<Db> {
    return (await this.#handleForProject(project)).db;
  }

  async #handleForProject(project: ProjectRouteInfo): Promise<DbHandle> {
    const url = this.resolveProjectUrl(project);
    if (url === this.#system.url) return this.#system;

    const cached = this.#projectHandles.get(url);
    if (cached) {
      // Refresh LRU position.
      this.#projectHandles.delete(url);
      this.#projectHandles.set(url, cached);
      return cached;
    }

    const pending = this.#opening.get(url);
    if (pending) return pending;
    const opening = this.#openProject(url);
    this.#opening.set(url, opening);
    try {
      return await opening;
    } finally {
      // Only the initiator clears the entry, and it clears it on failure too
      // so the next caller retries the open instead of joining a dead one.
      this.#opening.delete(url);
    }
  }

  async #openProject(url: string): Promise<DbHandle> {
    const handle = await openDb(url, {
      workerHost: this.#config.database.projects.workers,
      pool: this.#config.database.pool,
      logger: queryLogger(url, this.#hooks),
    });
    if (
      shouldAutoMigrate(this.#config, handle.kind) &&
      !this.#migrated.has(url)
    ) {
      await handle.migrate("project");
      this.#migrated.add(url);
    }
    this.#projectHandles.set(url, handle);
    await this.#evictIfNeeded();
    return handle;
  }

  /**
   * Projects that resolve to one database are one unit of work: they can be
   * read in a single pass, and `forProject` needs opening only once for the
   * whole group (any member resolves to the same url).
   *
   * `route` is a function rather than the caller pre-resolving its rows into
   * `ProjectRouteInfo[]`, for two reasons. `database_url` is optional on that
   * type, so a row whose field is spelled `databaseUrl` is structurally
   * assignable and compiles, while `resolveProjectUrl` reads `undefined` and
   * silently sends a project that was pinned to its own database off to the
   * template's — keeping the conversion at the call site is what keeps the
   * row's real shape in view. And this file cannot call `routeInfoOf` itself:
   * `access.ts` reaches back here through `bootstrap.ts`, and biome's
   * `noImportCycles` is an error outside the web workspace.
   *
   * Group order is the order each group's first member appears in `projects`,
   * and results stay one entry per group, so a caller that sorts the flattened
   * rows on a key with ties still breaks them the same way every time.
   *
   * A throwing callback settles the returned promise, but the other workers
   * are not cancelled — they run out their remaining groups unawaited. A
   * caller that wants to skip a database it cannot open has to catch inside
   * its own callback; there is no all-or-nothing here to lean on.
   */
  async perDatabase<P, R>(
    projects: readonly P[],
    route: (project: P) => ProjectRouteInfo,
    run: (db: Db, group: P[]) => Promise<R>,
  ): Promise<R[]> {
    const groups = new Map<string, { route: ProjectRouteInfo; members: P[] }>();
    for (const project of projects) {
      const info = route(project);
      const url = this.resolveProjectUrl(info);
      const group = groups.get(url);
      if (group) group.members.push(project);
      else groups.set(url, { route: info, members: [project] });
    }
    return inFlight(
      this.#config.database.projects.max_open,
      [...groups.values()].map(
        (group) => () =>
          this.#withPinnedHandle(group.route, (db) => run(db, group.members)),
      ),
    );
  }

  /**
   * A handle is not an eviction candidate while a task body holds it.
   *
   * Closing a handle mid-transaction does not "cut the query off": on inline
   * PGlite the next statement inside the open transaction wedges the whole
   * event loop (measured on 0.5.4 — no rejection, and timers stop firing),
   * and on the worker host the evicting side first waits out close()'s 2s
   * grace race. So the pin is taken before the open: the handle is claimed
   * from the first moment it exists.
   */
  async #withPinnedHandle<R>(
    project: ProjectRouteInfo,
    run: (db: Db) => Promise<R>,
  ): Promise<R> {
    const url = this.resolveProjectUrl(project);
    this.#pins.set(url, (this.#pins.get(url) ?? 0) + 1);
    try {
      return await run(await this.forProject(project));
    } finally {
      const left = (this.#pins.get(url) ?? 1) - 1;
      if (left > 0) this.#pins.set(url, left);
      else this.#pins.delete(url);
    }
  }

  /**
   * Idempotently make sure the project's target database exists and is
   * migrated (the target may already be provisioned when several projects
   * resolve to the same database). Returns the ready-to-use Db.
   */
  async provision(project: ProjectRouteInfo): Promise<Db> {
    const url = this.resolveProjectUrl(project);
    if (url === this.#system.url) {
      // Shared tier is migrated at open(); nothing to provision.
      return this.#system.db;
    }
    const handle = await this.#handleForProject(project);
    if (!this.#migrated.has(url)) {
      await handle.migrate("project");
      this.#migrated.add(url);
    }
    return handle.db;
  }

  /** Resolved URLs of all OTHER projects, for exclusive-ownership checks. */
  isUrlShared(url: string, otherProjects: ProjectRouteInfo[]): boolean {
    return otherProjects.some((p) => this.resolveProjectUrl(p) === url);
  }

  /**
   * max_open bounds the idle cache, not the peak. A handle a task body holds
   * (#withPinnedHandle), an in-memory instance, and the most recently touched
   * max_open handles all stay, so one pass may legitimately end over budget;
   * the excess is collected by the next open's pass.
   *
   * The candidate window is the OLDEST `size - max` entries rather than
   * "scan until size <= max": once pins keep the table over budget, an
   * unwindowed scan walks all the way to the MRU end, which is exactly the
   * handle a concurrent open just created and is about to hand to its caller.
   */
  async #evictIfNeeded(): Promise<void> {
    const max = this.#config.database.projects.max_open;
    const overBudget = this.#projectHandles.size - max;
    if (overBudget <= 0) return;
    for (const [url, handle] of [...this.#projectHandles].slice(
      0,
      overBudget,
    )) {
      if (this.#projectHandles.size <= max) return;
      // close() is awaited, and another pass may have closed or reopened this
      // url meanwhile: neither driver's close is idempotent (PGlite throws
      // "PGlite is closed", pg-pool "Called end on pool more than once").
      if (this.#projectHandles.get(url) !== handle) continue;
      if ((this.#pins.get(url) ?? 0) > 0) continue;
      // In-memory instances lose their data on close; never evict them
      // (only reachable in tests, which bound their own handle counts).
      if (url.startsWith("pglite://memory")) continue;
      this.#projectHandles.delete(url);
      // Dropped before the await: a concurrent reopen of this url would
      // otherwise have its fresh migration marker deleted by our tail.
      this.#migrated.delete(url);
      await handle.close();
    }
  }

  /**
   * The cache's current size, which can briefly exceed `max_open`: pinned
   * handles, in-memory ones, and the most recently touched `max_open` are all
   * kept by an eviction pass.
   */
  openHandleCount(): number {
    return this.#projectHandles.size;
  }

  /**
   * Close and forget the cached handle for a resolved URL, if any.
   *
   * Ignores pins on purpose: its only caller deletes the project and then rm's
   * the data directory, so a reader still on this handle has nothing left to
   * read. A second caller would make this a new source of cut-off queries.
   */
  async closeUrl(url: string): Promise<void> {
    const handle = this.#projectHandles.get(url);
    if (handle) {
      this.#projectHandles.delete(url);
      this.#migrated.delete(url);
      await handle.close();
    }
  }

  async close(): Promise<void> {
    for (const handle of this.#projectHandles.values()) {
      await handle.close();
    }
    this.#projectHandles.clear();
    await this.#system.close();
  }
}

/**
 * Run `tasks`, at most `limit` of them in flight, results in input order.
 *
 * The bound is `database.projects.max_open` because that is the router's
 * handle budget, not because safety rests on it: a handle a task body holds
 * is pinned (`#withPinnedHandle`) and is never an eviction candidate, so a
 * burst past the budget costs open connections rather than cut-off queries.
 *
 * One task runs exactly as sequentially as a bare `await` would, which is the
 * whole of `placement=shared` — hence no separate serial path to keep in step
 * with this one.
 */
async function inFlight<T>(
  limit: number,
  tasks: (() => Promise<T>)[],
): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < tasks.length; i = next++) {
      const task = tasks[i];
      if (task === undefined) return;
      out[i] = await task();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, worker),
  );
  return out;
}

function shouldAutoMigrate(config: Config, kind: "pglite" | "postgres") {
  return config.database.auto_migrate ?? kind === "pglite";
}
