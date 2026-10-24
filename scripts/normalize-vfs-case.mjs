// Rewrites the one byte of a `deno compile` output that depends on the build
// host's OS, so that a build from macOS or Windows is byte-identical to the
// Linux-built GitHub release (T-572). deno records `"vfs_case_sensitivity"` as
// "i" whenever deno itself was compiled for macOS or Windows, whatever the
// target and whatever the volume, with no flag to override it
// (cli/lib/standalone/virtual_fs.rs, `VfsBuilder::new`). The release ships "s",
// so this writes "s": same length, nothing after it moves.
//
// A Mach-O output also carries deno's ad-hoc linker signature, which stores a
// SHA-256 per 4 KiB page; the page holding the byte gets its hash recomputed.
// Re-signing with `codesign` instead would drop the linker-signed flag and
// differ anyway.
//
// Already "s" — every Linux build — leaves the file untouched, but the field
// still has to be there exactly once: a deno upgrade that renames or moves it
// fails here on the Linux CI, rather than leaving Mac builds silently different.
//
// usage: node scripts/normalize-vfs-case.mjs <file>...   (edits in place)
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const KEY = Buffer.from('"vfs_case_sensitivity":"');
const LC_CODE_SIGNATURE = 0x1d;
const CSMAGIC_CODEDIRECTORY = 0xfade0c02;
const CS_HASHTYPE_SHA256 = 2;

for (const file of process.argv.slice(2)) {
  const b = readFileSync(file);
  const at = b.indexOf(KEY);
  if (at < 0 || b.indexOf(KEY, at + 1) >= 0) {
    fail(file, `expected "vfs_case_sensitivity" exactly once`);
  }
  const off = at + KEY.length;
  const value = String.fromCharCode(b[off]);
  if (value === "s") continue;
  if (value !== "i") fail(file, `unexpected vfs_case_sensitivity "${value}"`);
  b[off] = "s".charCodeAt(0);
  if (b.readUInt32LE(0) === 0xfeedfacf) rehashPage(file, b, off);
  writeFileSync(file, b);
  console.log(`  normalized ${file}: vfs_case_sensitivity "i" -> "s"`);
}

// 64-bit little-endian Mach-O, the only kind deno emits for aarch64-apple-darwin.
// The SuperBlob and CodeDirectory inside the signature are big-endian.
function rehashPage(file, b, off) {
  let p = 32;
  let sig = -1;
  for (let i = 0, n = b.readUInt32LE(16); i < n; i++) {
    if (b.readUInt32LE(p) === LC_CODE_SIGNATURE) sig = b.readUInt32LE(p + 8);
    p += b.readUInt32LE(p + 4);
  }
  if (sig < 0) fail(file, "Mach-O without LC_CODE_SIGNATURE");
  let cd = -1;
  for (let i = 0, n = b.readUInt32BE(sig + 8); i < n; i++) {
    const o = sig + b.readUInt32BE(sig + 16 + i * 8);
    if (b.readUInt32BE(o) === CSMAGIC_CODEDIRECTORY) {
      if (cd >= 0) fail(file, "more than one CodeDirectory");
      cd = o;
    }
  }
  if (cd < 0) fail(file, "no CodeDirectory");
  const hashOffset = b.readUInt32BE(cd + 16);
  const codeLimit = b.readUInt32BE(cd + 32);
  const hashSize = b[cd + 36];
  const hashType = b[cd + 37];
  const pageSize = 2 ** b[cd + 39];
  if (hashType !== CS_HASHTYPE_SHA256 || hashSize !== 32) {
    fail(
      file,
      `CodeDirectory hash type ${hashType}/${hashSize} is not SHA-256`,
    );
  }
  if (off >= codeLimit) fail(file, "byte lies outside the signed range");
  const page = Math.floor(off / pageSize);
  const start = page * pageSize;
  const digest = createHash("sha256")
    .update(b.subarray(start, Math.min(start + pageSize, codeLimit)))
    .digest();
  digest.copy(b, cd + hashOffset + page * hashSize);
}

function fail(file, message) {
  console.error(`normalize-vfs-case: ${file}: ${message}`);
  process.exit(1);
}
