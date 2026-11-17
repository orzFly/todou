import { brotliDecompressSync } from "node:zlib";
import { MERMAID_PAYLOAD } from "./payload.ts";
import type { DiagramParser } from "./types.ts";

// A variable rather than a literal, so that esbuild leaves the import alone
// instead of bundling mermaid into todou.cjs uncompressed.
const SOURCE_LOADER = "./source-loader.ts";

let loading: Promise<DiagramParser> | undefined;

/**
 * mermaid's parser, loaded on first use and kept for the process. Costs
 * about 300 ms from the embedded payload and 450 ms from source, which is
 * why nothing calls this unless a body actually holds a diagram.
 */
export function loadDiagramParser(): Promise<DiagramParser> {
  loading ??= load();
  return loading;
}

async function load(): Promise<DiagramParser> {
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
