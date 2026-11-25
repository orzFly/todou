// The tjs side of the conformance run: bundled with the tjs configuration by
// scripts/tjs-conformance.mjs and executed by the host's tjs. The last line
// is the count; the exit code says whether anything failed. The suites load
// after detectPlatform for the same reason the CLI does (see main.ts).
import { detectPlatform } from "../platform.ts";

await detectPlatform();
const { suites } = await import("./suites.ts");

let passed = 0;
let failed = 0;
for (const { module, cases, mod } of suites) {
  for (const [name, run] of Object.entries(cases)) {
    try {
      await run(mod as never);
      passed += 1;
      console.log(`ok   ${module}: ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL ${module}: ${name}`);
      console.log(
        `     ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
console.log(`${passed} passed, ${failed} failed`);
tjs.exit(failed === 0 ? 0 : 1);
