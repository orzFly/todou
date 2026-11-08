import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";

export type TestDatabase = { url: string; drop: () => Promise<void> };

/**
 * A new, empty database on the server `adminUrl` points at, for a test that
 * needs one nothing else has written to. Only the generated name enters
 * CREATE/DROP DATABASE; never print the returned URL or put it in an
 * assertion. The role behind `adminUrl` needs CREATEDB.
 */
export async function createTestDatabase(
  adminUrl: string,
  prefix: string,
): Promise<TestDatabase> {
  const name = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
  } catch (err) {
    await admin.end();
    throw err;
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  // pg connection strings may specify dbname separately from pathname.
  url.searchParams.delete("database");
  url.searchParams.delete("dbname");
  return {
    url: url.toString(),
    drop: async () => {
      try {
        // A pool's end() resolves before its connections finish closing,
        // and FORCE would kill those midway: the server's notice then
        // reaches a pool with no error listener and surfaces as an uncaught
        // exception. So wait for the sessions to go first; FORCE is for a
        // test that failed midway and still holds connections.
        for (let tries = 0; tries < 50; tries++) {
          const { rows } = await admin.query<{ sessions: number }>(
            "SELECT count(*)::int AS sessions FROM pg_stat_activity " +
              "WHERE datname = $1 AND backend_type = 'client backend'",
            [name],
          );
          if (rows[0]?.sessions === 0) break;
          await delay(100);
        }
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    },
  };
}
