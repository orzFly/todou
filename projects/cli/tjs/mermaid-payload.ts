// Build-time injection point for the tjs build, the counterpart of
// src/mermaid/payload.ts: scripts/build-cli-tjs.sh overwrites this file in its
// staged copy of the tree with the mermaid sub-bundle as QuickJS bytecode,
// deflate-raw compressed and base64-encoded (tjs/compile.js --mermaid). It
// must stay tracked, because the CLI build stages via `git ls-files`.
export const MERMAID_BYTECODE: string | null = null;
