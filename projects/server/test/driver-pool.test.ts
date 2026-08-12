import { describe, expect, it, vi } from "vitest";

const poolConfigs: unknown[] = [];

vi.mock("pg", () => ({
  default: {
    Pool: class {
      constructor(config: unknown) {
        poolConfigs.push(config);
      }
      end() {
        return Promise.resolve();
      }
    },
  },
}));

import { openDb } from "../src/db/driver.ts";

describe("openDb postgres pool options", () => {
  it("passes the configured pool limits through to pg.Pool", async () => {
    await openDb("postgres://db.internal/todou", {
      pool: { max: 25, idle_timeout_ms: 5_000, connection_timeout_ms: 3_000 },
    });
    expect(poolConfigs.at(-1)).toEqual({
      connectionString: "postgres://db.internal/todou",
      max: 25,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 3_000,
    });
  });

  it("leaves pg defaults in charge when no pool options are given", async () => {
    await openDb("postgres://db.internal/todou");
    expect(poolConfigs.at(-1)).toEqual({
      connectionString: "postgres://db.internal/todou",
      max: undefined,
      idleTimeoutMillis: undefined,
      connectionTimeoutMillis: undefined,
    });
  });
});
