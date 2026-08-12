// Repeatable benchmark for inline vs worker-hosted PGlite project databases
// (database.projects.workers). Exercises the exact production path — drizzle
// on top of openDb() — against N file-backed project databases concurrently,
// and reports throughput, per-op latency percentiles, and main-thread
// event-loop stalls (the "does the HTTP server stay responsive" number).
//
//   node bench/db-workers.ts                     # full grid: 1/2/4/8 projects
//   node bench/db-workers.ts --projects 1 --concurrency 1   # pure per-op overhead
//   node bench/db-workers.ts --json results.json # machine-readable copy
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";
import { type DbHandle, openDb } from "../src/db/driver.ts";

const { values: flags } = parseArgs({
  options: {
    projects: { type: "string", default: "1,2,4,8" },
    modes: { type: "string", default: "inline,worker" },
    ops: { type: "string", default: "200" },
    concurrency: { type: "string", default: "4" },
    "seed-rows": { type: "string", default: "3000" },
    json: { type: "string" },
  },
});

const PROJECT_COUNTS = flags.projects.split(",").map(Number);
const MODES = flags.modes.split(",") as Array<"inline" | "worker">;
/** Ops per project per workload (split across the concurrent runners). */
const OPS = Number(flags.ops);
/** In-flight requests per project database. */
const CONCURRENCY = Number(flags.concurrency);
/** Rows seeded per database for the read workload to aggregate over. */
const SEED_ROWS = Number(flags["seed-rows"]);
const PAYLOAD = "x".repeat(200);

type Workload = "write" | "read" | "heavy";

const STATEMENTS: Record<Workload, (i: number) => ReturnType<typeof sql>> = {
  write: (i) =>
    sql`INSERT INTO bench_items (k, payload) VALUES (${i}, ${PAYLOAD})`,
  read: () =>
    sql`SELECT k % 16 AS bucket, count(*) AS n, sum(k) AS total
        FROM bench_items GROUP BY 1 ORDER BY 1`,
  // Tens of milliseconds of pure WASM compute per query. Inline, these
  // serialize on the main thread across ALL projects; in a worker each
  // one only occupies its own project's thread.
  heavy: () =>
    sql`SELECT count(*) AS n FROM (
          SELECT g, row_number() OVER (ORDER BY g % 97, g) AS rn
          FROM generate_series(1, 150000) g
        ) t WHERE rn % 3 = 0`,
};

/** Heavy ops run at a tenth of the count — each one is ~50-100x the cost. */
function opsFor(workload: Workload): number {
  return workload === "heavy" ? Math.max(10, Math.round(OPS / 10)) : OPS;
}

type ScenarioResult = {
  mode: "inline" | "worker";
  projects: number;
  workload: Workload;
  ops: number;
  wallMs: number;
  opsPerSec: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  stallMaxMs: number;
  stallMeanMs: number;
};

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx] as number;
}

/**
 * Samples how late a 20ms interval timer fires while a workload runs —
 * a direct measure of main-thread starvation. Measured answer: near zero
 * in BOTH modes (PGlite's WASM yields to the event loop constantly), so
 * inline's real cost is the shared one-core throughput ceiling, not
 * frozen timers. The metric stays in the report as evidence.
 */
function startStallMonitor() {
  const intervalMs = 20;
  let max = 0;
  let sum = 0;
  let samples = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const stall = Math.max(0, now - last - intervalMs);
    if (stall > max) max = stall;
    sum += stall;
    samples += 1;
    last = now;
  }, intervalMs);
  return {
    stop(): { max: number; mean: number } {
      clearInterval(timer);
      return { max, mean: samples ? sum / samples : 0 };
    },
  };
}

async function runWorkload(
  handles: DbHandle[],
  workload: Workload,
  opsPerProject: number,
): Promise<{
  wallMs: number;
  latencies: number[];
  stall: { max: number; mean: number };
}> {
  const latencies: number[] = [];
  const monitor = startStallMonitor();
  const started = performance.now();
  await Promise.all(
    handles.flatMap((handle) => {
      const perRunner = Math.ceil(opsPerProject / CONCURRENCY);
      return Array.from({ length: CONCURRENCY }, async (_, runner) => {
        for (let i = 0; i < perRunner; i++) {
          const opStart = performance.now();
          await handle.db.execute(STATEMENTS[workload](runner * perRunner + i));
          latencies.push(performance.now() - opStart);
        }
      });
    }),
  );
  const wallMs = performance.now() - started;
  return { wallMs, latencies, stall: monitor.stop() };
}

async function runScenario(
  mode: "inline" | "worker",
  projects: number,
  baseDir: string,
): Promise<ScenarioResult[]> {
  const handles: DbHandle[] = [];
  for (let p = 0; p < projects; p++) {
    handles.push(
      await openDb(`pglite://${baseDir}/${mode}-${projects}-p${p}`, {
        workerHost: mode === "worker",
      }),
    );
  }
  for (const handle of handles) {
    await handle.db.execute(
      sql`CREATE TABLE bench_items (id serial PRIMARY KEY, k int NOT NULL, payload text NOT NULL)`,
    );
    await handle.db.execute(
      sql`INSERT INTO bench_items (k, payload)
          SELECT g, ${PAYLOAD} FROM generate_series(1, ${SEED_ROWS}) g`,
    );
    // Warmup so first-query WASM/prepare costs don't skew the measurement.
    for (let i = 0; i < 10; i++) {
      await handle.db.execute(STATEMENTS.write(-1 - i));
      await handle.db.execute(STATEMENTS.read(i));
    }
    await handle.db.execute(STATEMENTS.heavy(0));
  }

  const results: ScenarioResult[] = [];
  for (const workload of ["write", "read", "heavy"] as Workload[]) {
    const { wallMs, latencies, stall } = await runWorkload(
      handles,
      workload,
      opsFor(workload),
    );
    latencies.sort((a, b) => a - b);
    results.push({
      mode,
      projects,
      workload,
      ops: latencies.length,
      wallMs,
      opsPerSec: (latencies.length / wallMs) * 1000,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies[latencies.length - 1] as number,
      stallMaxMs: stall.max,
      stallMeanMs: stall.mean,
    });
  }

  for (const handle of handles) await handle.close();
  return results;
}

function printTable(results: ScenarioResult[]): void {
  const headers = [
    "mode",
    "projects",
    "workload",
    "ops",
    "wall ms",
    "ops/s",
    "p50 ms",
    "p95 ms",
    "p99 ms",
    "max ms",
    "evloop max ms",
  ];
  const rows = results.map((r) => [
    r.mode,
    String(r.projects),
    r.workload,
    String(r.ops),
    r.wallMs.toFixed(0),
    r.opsPerSec.toFixed(0),
    r.p50.toFixed(2),
    r.p95.toFixed(2),
    r.p99.toFixed(2),
    r.max.toFixed(1),
    r.stallMaxMs.toFixed(1),
  ]);
  const widths = headers.map((h, c) =>
    Math.max(h.length, ...rows.map((row) => (row[c] as string).length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, c) => cell.padStart(widths[c] as number)).join("  ");
  console.log(line(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(line(row));
}

const baseDir = await mkdtemp(join(tmpdir(), "todou-db-bench-"));
console.log(
  `pglite inline vs worker · ${availableParallelism()} cores · node ${process.version}`,
);
console.log(
  `projects=${PROJECT_COUNTS.join("/")} ops/project=${OPS} concurrency/project=${CONCURRENCY} seed=${SEED_ROWS} rows · data under ${baseDir}\n`,
);

const results: ScenarioResult[] = [];
try {
  for (const projects of PROJECT_COUNTS) {
    for (const mode of MODES) {
      results.push(...(await runScenario(mode, projects, baseDir)));
    }
  }
} finally {
  await rm(baseDir, { recursive: true, force: true });
}

printTable(results);

if (flags.json) {
  await writeFile(flags.json, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\nresults written to ${flags.json}`);
}
