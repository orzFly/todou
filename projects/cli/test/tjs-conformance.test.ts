// The node side of the tjs conformance cases (T-792): each case runs against
// Node's real module here, and against the tjs shim through
// scripts/tjs-conformance.mjs. A case that passes here and fails there is a
// shim that has drifted from Node.
import { describe, it } from "vitest";
import { suites } from "../tjs/conformance/suites.ts";

for (const { module, cases, mod } of suites) {
  describe(module, () => {
    for (const [name, run] of Object.entries(cases)) {
      it(name, () => run(mod as never));
    }
  });
}
