#!/usr/bin/env node
// A real, signal-responsive watch process; no tracker or model connection.
import { appendFileSync, readFileSync } from "node:fs";

const log = process.env.TODOU_SMOKE_CHILD_LOG;
const statePath = process.env.TODOU_PI_STATE || process.env.TODOU_OMP_STATE;
function emit(kind, extra = {}) {
  appendFileSync(
    log,
    `${JSON.stringify({
      kind,
      at: new Date().toISOString(),
      pid: process.pid,
      ppid: process.ppid,
      run: process.env.TODOU_SMOKE_RUN_ID,
      ...extra,
    })}\n`,
  );
}
let state;
try {
  state = JSON.parse(readFileSync(statePath, "utf8"));
} catch {
  state = null;
}
emit("child-start", {
  argv: process.argv.slice(2),
  statePath,
  state,
  socket: process.env.TODOU_MESSAGING_SOCKET,
  token: process.env.TODOU_MESSAGING_TOKEN,
  markers: { omp: process.env.OMPCODE, pi: process.env.PI_CODING_AGENT },
});
// The driver waits for the start record, never for this timer. Keeping the
// event loop alive models a watch blocked on its upstream event stream.
const keepAlive = setInterval(() => {}, 60_000);
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    emit("child-signal", { signal });
    clearInterval(keepAlive);
    process.exit(0);
  });
}
