// The tjs build's entry.
//
// The CLI is imported only after detectPlatform has resolved (see
// platform.ts), so that `process.arch` is settled before any module reads it.
// esbuild turns the dynamic import into a deferred initialisation inside the
// same bundle; nothing is loaded from disk.
//
// Node keeps a process alive until its event loop is empty and only then
// exits with `process.exitCode`; a tjs standalone program is ended here
// instead, once `main` has returned: the `exit` listeners run, stdout and
// stderr are drained, and the code is handed to tjs.exit. Work a command
// leaves running after its `execute()` returns is cut off at that point,
// which is why the CLI awaits everything it starts.
import { detectPlatform } from "./platform.ts";
import { process } from "./process.ts";

await detectPlatform();
const { main } = await import("../src/main.ts");

let code: number;
try {
  code = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  code = 1;
}
process.exitCode = code;
process.emit("exit", code);
await Promise.all([process.stdout.flushed(), process.stderr.flushed()]);
tjs.exit(Number(process.exitCode ?? 0));
