import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";

/**
 * Extensions every PGlite instance is built with (T-141).
 *
 * PGlite is a WASM build: an extension has to be linked in at construction,
 * so a `CREATE EXTENSION` a migration runs later fails outright unless the
 * bundle was passed here first. Every construction site — the two in
 * driver.ts and the worker thread's own — shares this object, because a
 * project database opened through the path that forgot it would migrate
 * fine on one code path and 500 on the other.
 *
 * `postgres://` deployments need the same extension installed server-side
 * instead; pg_trgm is standard contrib on every distribution's package.
 */
export const PGLITE_EXTENSIONS = { pg_trgm };
