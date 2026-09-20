import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// This process is the real ancestor that owns the manifest. The CLI below
// is the unmodified entrypoint, with real HTTP, clocks and process discovery.
const [root, peer, cli, ...args] = process.argv.slice(2);
const dir = join(root, `todou-${peer}`);
mkdirSync(dir, { recursive: true });
const path = join(dir, `${process.pid}.json`);
const record = {
  v: 1,
  pid: process.pid,
  agent: peer,
  session_id: "fixture-session-one",
  socket: join(dir, "receiver.sock"),
  token: "fixture-token-one",
};
writeFileSync(path, JSON.stringify(record));
const env = {
  ...process.env,
  ...(peer === "omp"
    ? { OMPCODE: "1", TODOU_OMP_STATE: path }
    : { PI_CODING_AGENT: "true", TODOU_PI_STATE: path }),
};
const reparent = process.env.TODOU_FIXTURE_REPARENT === "1";
// Exercise both a shell tool's launch path and a direct native child launch.
const child = reparent
  ? spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./watch-launcher.mjs", import.meta.url)),
        cli,
        ...args,
      ],
      { env, stdio: ["ignore", "inherit", "inherit", "ipc"] },
    )
  : peer === "omp"
    ? spawn(
        "/bin/sh",
        ["-c", 'exec "$@"', "watch-fixture", process.execPath, cli, ...args],
        {
          env,
          stdio: ["ignore", "inherit", "inherit"],
        },
      )
    : spawn(process.execPath, [cli, ...args], {
        env,
        stdio: ["ignore", "inherit", "inherit"],
      });
if (reparent) {
  child.on("message", (message) => {
    process.send?.({ path, record, childPid: message.childPid });
  });
  process.on("message", (message) => {
    if (message === "detach") child.send("detach");
  });
} else {
  process.send?.({ path, record, childPid: child.pid });
}
child.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
  process.disconnect?.();
});
child.on("exit", (code, signal) => {
  if (reparent) {
    process.send?.({ launcherExited: true });
    return;
  }
  process.send?.({ childExit: { code, signal } });
  process.exitCode = code ?? 1;
  process.disconnect?.();
});
// The test deliberately ends this owner without signalling its child to
// prove the raw watch notices a dead owner itself. No wrapper cleanup.
