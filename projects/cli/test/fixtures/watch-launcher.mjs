import { spawn } from "node:child_process";

// Stand in for a shell tool which backgrounds a raw watch and later exits.
// Inherited pipes remain owned by the CLI, while IPC names its actual PID.
const child = spawn(process.execPath, process.argv.slice(2), {
  stdio: ["ignore", "inherit", "inherit"],
});
process.send?.({ childPid: child.pid });
process.on("message", (message) => {
  if (message !== "detach") return;
  child.unref();
  process.disconnect();
});
