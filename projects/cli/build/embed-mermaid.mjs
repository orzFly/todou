#!/usr/bin/env node
// Usage: embed-mermaid.mjs <sub-bundle.cjs> <payload.ts>
//
// Compresses the mermaid sub-bundle and writes it into the payload placeholder,
// keeping the placeholder's comment and export and replacing only the value.
// Called by scripts/bundle-cli.sh on a staged tree.
//
// The output must be byte-for-byte reproducible: `todou upgrade` skips its
// confirmation only when a server's build matches the GitHub release exactly
// (T-570). Brotli is deterministic for a given input, quality and size hint.
import { readFileSync, writeFileSync } from "node:fs";
import { brotliCompressSync, constants } from "node:zlib";

const [input, payload] = process.argv.slice(2);
if (input === undefined || payload === undefined) {
  console.error("usage: embed-mermaid.mjs <sub-bundle.cjs> <payload.ts>");
  process.exit(2);
}

const code = readFileSync(input);
const packed = brotliCompressSync(code, {
  params: {
    [constants.BROTLI_PARAM_QUALITY]: 11,
    [constants.BROTLI_PARAM_SIZE_HINT]: code.length,
  },
}).toString("base64");

const placeholder = "MERMAID_PAYLOAD: string | null = null;";
const source = readFileSync(payload, "utf8");
if (!source.includes(placeholder)) {
  console.error(`${payload} does not hold the null placeholder`);
  process.exit(1);
}
writeFileSync(
  payload,
  source.replace(
    placeholder,
    () => `MERMAID_PAYLOAD: string | null = ${JSON.stringify(packed)};`,
  ),
);
console.log(
  `==> embedded mermaid: ${code.length} bytes, ${packed.length} as brotli base64`,
);
