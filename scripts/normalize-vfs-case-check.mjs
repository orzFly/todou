// Proves on a Linux host that normalize-vfs-case.mjs repairs a macOS-hosted
// build, which a Linux build never exercises: the "s" it produces is already
// there. Takes the Linux-built todou-macos-arm64, turns it into what a Mac
// produces by flipping the byte to "i" and zeroing the page hash that byte
// falls under, then requires the normalizer to give back the original exactly.
//
// The hash slot is found by its value, not by walking the signature the way the
// normalizer does — locating it with the normalizer's own logic would make a
// wrong slot offset agree with itself.
//
// usage: node scripts/normalize-vfs-case-check.mjs dist/todou-macos-arm64
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PAGE = 4096;
const KEY = Buffer.from('"vfs_case_sensitivity":"s"');

const [input] = process.argv.slice(2);
if (!input) {
  console.error("usage: normalize-vfs-case-check.mjs <todou-macos-arm64>");
  process.exit(2);
}
const original = readFileSync(input);
const at = original.indexOf(KEY);
if (at < 0) fail(`no "vfs_case_sensitivity":"s" in ${input}`);
const off = at + KEY.length - 2;

const start = Math.floor(off / PAGE) * PAGE;
const digest = createHash("sha256")
  .update(original.subarray(start, start + PAGE))
  .digest();
const slot = original.indexOf(digest);
if (slot < 0 || original.indexOf(digest, slot + 1) >= 0) {
  fail(`the page hash of byte ${off} is not in ${input} exactly once`);
}

const mac = Buffer.from(original);
mac[off] = "i".charCodeAt(0);
mac.fill(0, slot, slot + digest.length);
const copy = `${input}.normalize-check`;
writeFileSync(copy, mac);
let restored;
try {
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL("normalize-vfs-case.mjs", import.meta.url)), copy],
    { stdio: "inherit" },
  );
  restored = readFileSync(copy).equals(original);
} finally {
  rmSync(copy, { force: true });
}
if (!restored) fail(`normalizing a Mac-shaped ${input} did not restore it`);
console.log(`  ok: normalize-vfs-case restores ${input}`);

function fail(message) {
  console.error(`normalize-vfs-case-check: ${message}`);
  process.exit(1);
}
