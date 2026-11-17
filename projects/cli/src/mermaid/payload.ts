// Build-time injection point, the same mechanism as
// projects/shared/src/build-info.ts: scripts/bundle-cli.sh overwrites this file
// in its staged copy of the tree with the mermaid sub-bundle, brotli-compressed
// and base64-encoded. It must stay tracked, because the CLI build stages via
// `git ls-files`. null means "not a packaged build": mermaid is loaded from
// node_modules instead.
export const MERMAID_PAYLOAD: string | null = null;
