// Run by the build host's tjs, from scripts/build-cli-tjs.sh:
//
//   tjs run compile.js <bundle.mjs> <runtime> <out> [<runtime> <out>…]
//   tjs run compile.js --mermaid <sub-bundle.cjs> <payload.ts>
//
// The first form compiles the bundle to QuickJS bytecode once and appends it
// to each runtime in the layout `tjs compile` writes and run-main reads back:
// [runtime][bytecode]["tx1k1.js"][u32 LE: runtime length]. `tjs compile` only
// appends to the runtime executing it; doing the same by hand is what lets
// one host produce every target. Bytecode does not depend on the host's
// architecture, so the six outputs carry identical bytes after the runtime.
//
// The second form compiles the mermaid sub-bundle the same way, compresses it
// and writes it into the tracked placeholder tjs/mermaid-payload.ts, for
// tjs/mermaid-loader.ts to evaluate on first use.
//
// Outputs must be byte-for-byte reproducible: `todou upgrade` skips its
// confirmation only when a server's build matches the GitHub release (T-570).
// That is why the compiled file name is fixed rather than taken from the
// argument, which would put a build path into every stack trace and into the
// bytes.

const MAGIC = "tx1k1.js";
const MERMAID_GLOBAL = "__todouMermaidFactory";
const PLACEHOLDER = "MERMAID_BYTECODE: string | null = null;";

const args = tjs.args.slice(3);

function usage() {
  console.error(
    "usage: tjs run compile.js <bundle.mjs> <runtime> <out> [<runtime> <out>…]\n" +
      "       tjs run compile.js --mermaid <sub-bundle.cjs> <payload.ts>",
  );
  tjs.exit(2);
}

function compile(source, name) {
  return tjs.engine.serialize(
    tjs.engine.compile(new TextEncoder().encode(source), name),
  );
}

async function deflateRaw(bytes) {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function link(bundle, pairs) {
  const bytecode = compile(
    new TextDecoder().decode(await tjs.readFile(bundle)),
    "todou.js",
  );
  for (let i = 0; i < pairs.length; i += 2) {
    const [runtime, out] = [pairs[i], pairs[i + 1]];
    const exe = await tjs.readFile(runtime);
    const joined = new Uint8Array(exe.length + bytecode.length + 12);
    joined.set(exe, 0);
    joined.set(bytecode, exe.length);
    joined.set(new TextEncoder().encode(MAGIC), exe.length + bytecode.length);
    new DataView(joined.buffer).setUint32(
      exe.length + bytecode.length + MAGIC.length,
      exe.length,
      true,
    );
    await tjs.writeFile(out, joined, { mode: 0o755 });
    console.log(
      `  -> ${out}: ${joined.length} bytes ` +
        `(runtime ${exe.length} + bytecode ${bytecode.length})`,
    );
  }
}

// A module's exports are out of reach once it has run from bytecode —
// tjs.engine.evalBytecode returns only the evaluation's promise — so the
// sub-bundle hands its CommonJS factory over through a global, which the
// loader takes and deletes.
async function mermaid(subBundle, payload) {
  const code = new TextDecoder().decode(await tjs.readFile(subBundle));
  const wrapped =
    `globalThis[${JSON.stringify(MERMAID_GLOBAL)}] = ` +
    `function (module, exports, require) {\n${code}\n};\n`;
  const bytecode = compile(wrapped, "mermaid.js");
  const packed = (await deflateRaw(bytecode)).toBase64();

  const source = new TextDecoder().decode(await tjs.readFile(payload));
  if (!source.includes(PLACEHOLDER)) {
    console.error(`${payload} does not hold the null placeholder`);
    tjs.exit(1);
  }
  await tjs.writeFile(
    payload,
    source.replace(
      PLACEHOLDER,
      () => `MERMAID_BYTECODE: string | null = ${JSON.stringify(packed)};`,
    ),
  );
  console.log(
    `==> embedded mermaid: ${code.length} bytes of source, ` +
      `${bytecode.length} of bytecode, ${packed.length} as deflate-raw base64`,
  );
}

if (args[0] === "--mermaid") {
  if (args.length !== 3) usage();
  await mermaid(args[1], args[2]);
} else {
  if (args.length < 3 || args.length % 2 !== 1) usage();
  await link(args[0], args.slice(1));
}
