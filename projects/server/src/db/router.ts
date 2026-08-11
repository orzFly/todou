import type { Config, ProjectRouteInfo } from "../config.ts";
import { type Db, type DbHandle, openDb } from "./driver.ts";

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
  /** urls whose project-tier migrations already ran in this process */
  #migrated = new Set<string>();

  private constructor(config: Config, system: DbHandle) {
    this.#config = config;
    this.#system = system;
  }

  static async open(config: Config): Promise<DbRouter> {
    const system = await openDb(config.database.system);
    if (shouldAutoMigrate(config, system.kind)) {
      await system.migrate("system");
      // Shared placement keeps project-tier tables in the system database.
      if (config.database.projects.placement === "shared") {
        await system.migrate("project");
      }
    }
    return new DbRouter(config, system);
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

    const handle = await openDb(url);
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

  async #evictIfNeeded(): Promise<void> {
    const max = this.#config.database.projects.max_open;
    while (this.#projectHandles.size > max) {
      const [oldestUrl, oldest] = this.#projectHandles.entries().next()
        .value as [string, DbHandle];
      this.#projectHandles.delete(oldestUrl);
      // In-memory instances lose their data on close; never evict them
      // (only reachable in tests, which bound their own handle counts).
      if (oldest.url.startsWith("pglite://memory")) {
        this.#projectHandles.set(oldestUrl, oldest);
        return;
      }
      await oldest.close();
      this.#migrated.delete(oldestUrl);
    }
  }

  openHandleCount(): number {
    return this.#projectHandles.size;
  }

  /** Close and forget the cached handle for a resolved URL, if any. */
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

function shouldAutoMigrate(config: Config, kind: "pglite" | "postgres") {
  return config.database.auto_migrate ?? kind === "pglite";
}
