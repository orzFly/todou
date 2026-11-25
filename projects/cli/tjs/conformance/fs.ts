import type * as fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Cases, deepEqual, equal } from "./assert.ts";

export const cases: Cases<typeof fs> = {
  "constants and openAsBlob": async (mod) => {
    deepEqual(
      [
        mod.constants.F_OK,
        mod.constants.R_OK,
        mod.constants.W_OK,
        mod.constants.X_OK,
      ],
      [0, 4, 2, 1],
      "access constants",
    );
    const dir = await mkdtemp(join(tmpdir(), "todou-conformance-"));
    try {
      await writeFile(join(dir, "f"), "blob body");
      const blob = await mod.openAsBlob(join(dir, "f"), { type: "text/plain" });
      equal(blob.size, 9, "size");
      equal(blob.type, "text/plain", "type");
      equal(await blob.text(), "blob body", "text");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
