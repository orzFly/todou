// What `#mermaid-loader` resolves to in the tjs build. The mermaid sub-bundle
// travels as QuickJS bytecode (tjs/compile.js --mermaid): deserializing that
// takes about 70 ms where compiling the source would take 870, and it is
// only paid by a command whose body holds a diagram.
import type { DiagramParser } from "../src/mermaid/types.ts";
import { MERMAID_BYTECODE } from "./mermaid-payload.ts";

/** Set by the sub-bundle's bytecode when it runs; see compile.js. */
const FACTORY = "__todouMermaidFactory";

type Factory = (
  module: { exports: { parseAll?: DiagramParser } },
  exports: object,
  require: (id: string) => unknown,
) => void;

/**
 * The sub-bundle is CommonJS for node's sake and asks for `util` twice, for
 * the text codecs and `inspect`; QuickJS has the codecs as globals, and the
 * inspect output only ever lands in an error message.
 */
function requireForMermaid(id: string): unknown {
  if (id === "util") {
    return {
      TextEncoder,
      TextDecoder,
      inspect: (value: unknown) =>
        typeof value === "string"
          ? value
          : (JSON.stringify(value) ?? String(value)),
    };
  }
  throw new Error(`the embedded mermaid bundle asked for '${id}'`);
}

async function inflate(packed: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([packed as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function loadPayload(): Promise<DiagramParser> {
  if (MERMAID_BYTECODE === null) {
    throw new Error("this build carries no mermaid payload");
  }
  const bytecode = await inflate(Uint8Array.fromBase64(MERMAID_BYTECODE));
  await tjs.engine.evalBytecode(tjs.engine.deserialize(bytecode));
  const scope = globalThis as Record<string, unknown>;
  const factory = scope[FACTORY] as Factory | undefined;
  delete scope[FACTORY];
  if (typeof factory !== "function") {
    throw new Error("the embedded mermaid bytecode defined no factory");
  }
  const module = { exports: {} as { parseAll?: DiagramParser } };
  factory(module, module.exports, requireForMermaid);
  if (typeof module.exports.parseAll !== "function") {
    throw new Error("the embedded mermaid bundle exports no parseAll");
  }
  return module.exports.parseAll;
}
