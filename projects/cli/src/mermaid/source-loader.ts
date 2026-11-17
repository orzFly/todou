// Loads mermaid straight from node_modules, for the CLI run from source. The
// release bundle never reaches this module, and must not contain it: it imports
// mermaid, uncompressed. parser.ts imports it under a specifier esbuild does
// not follow.
import { registerHooks } from "node:module";
import type { DiagramParser } from "./types.ts";

const STUB = new URL("./dompurify-stub.ts", import.meta.url).href;

let hooked = false;

export async function loadFromSource(): Promise<DiagramParser> {
  if (!hooked) {
    // Only mermaid's own dompurify is swapped; any other importer keeps the
    // real one.
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (
          specifier === "dompurify" &&
          context.parentURL?.includes("/node_modules/mermaid/")
        ) {
          return { url: STUB, shortCircuit: true };
        }
        return nextResolve(specifier, context);
      },
    });
    hooked = true;
  }
  const { parseAll } = await import("./entry.ts");
  return parseAll;
}
