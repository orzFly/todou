import type * as crypto from "node:crypto";
import { type Cases, equal, ok } from "./assert.ts";

export const cases: Cases<typeof crypto> = {
  "randomUUID, randomBytes and sha256": async (mod) => {
    ok(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        mod.randomUUID(),
      ),
      "uuid v4",
    );
    equal(mod.randomBytes(6).toString("hex").length, 12, "hex length");
    equal(mod.randomBytes(70000).length, 70000, "beyond one getRandomValues");
    equal(
      mod.createHash("sha256").update("abc").digest("hex"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      "sha256 of a string",
    );
    const hash = mod.createHash("sha256");
    hash.update(new Uint8Array([0x61, 0x62]));
    hash.update(new Uint8Array([0x63]));
    equal(
      hash.digest("hex"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      "sha256 in chunks",
    );
  },
};
