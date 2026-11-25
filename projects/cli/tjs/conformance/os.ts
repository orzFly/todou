import type * as os from "node:os";
import { type Cases, equal, ok } from "./assert.ts";

export const cases: Cases<typeof os> = {
  "homedir follows HOME, tmpdir and hostname answer": async (mod) => {
    if (process.platform !== "win32") {
      equal(mod.homedir(), process.env.HOME, "homedir");
    }
    ok(mod.tmpdir().length > 0 && !mod.tmpdir().endsWith("/"), "tmpdir");
    ok(mod.hostname().length > 0, "hostname");
  },
};
