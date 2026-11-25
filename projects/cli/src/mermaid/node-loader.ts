// How node, and the node bundle, get mermaid's parser: from the brotli payload
// a packaged build embeds, or from node_modules in a source run. Reached only
// through `#mermaid-loader`, so the CLI's single-file build, which has neither
// `node:zlib` nor `require`, can put a loader of its own in this one place
// (T-792).
import { brotliDecompressSync } from "node:zlib";
import { MERMAID_PAYLOAD } from "./payload.ts";
import type { DiagramParser } from "./types.ts";

// A variable rather than a literal, so that esbuild leaves the import alone
// instead of bundling mermaid into todou.cjs uncompressed.
const SOURCE_LOADER = "./source-loader.ts";

export async function loadPayload(): Promise<DiagramParser> {
  if (MERMAID_PAYLOAD === null) {
    const loader = (await import(
      SOURCE_LOADER
    )) as typeof import("./source-loader.ts");
    return loader.loadFromSource();
  }
  const code = brotliDecompressSync(
    Buffer.from(MERMAID_PAYLOAD, "base64"),
  ).toString("utf8");
  const module = { exports: {} as { parseAll?: DiagramParser } };
  new Function("module", "exports", "require", code)(
    module,
    module.exports,
    require,
  );
  if (typeof module.exports.parseAll !== "function") {
    throw new Error("the embedded mermaid bundle exports no parseAll");
  }
  return module.exports.parseAll;
}
