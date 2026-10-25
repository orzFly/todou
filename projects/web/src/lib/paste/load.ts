type Converter = typeof import("./html-to-markdown.ts");

let loaded: Converter | null = null;
let loading: Promise<Converter> | null = null;

/**
 * The hast/mdast toolchain is a chunk of its own, fetched once an editor is
 * on screen rather than with the app.
 */
export function prefetchPasteConverter(): Promise<Converter> {
  loading ??= import("./html-to-markdown.ts").then(
    (module) => {
      loaded = module;
      return module;
    },
    (error: unknown) => {
      // A failed fetch (a deploy replaced the chunk, the network dropped)
      // must not pin every later editor to plain text.
      loading = null;
      throw error;
    },
  );
  return loading;
}

/**
 * Synchronous on purpose: a paste event has to be answered before it
 * returns. `null` while the chunk is still on its way, and the paste then
 * goes in as plain text.
 */
export function pasteConverter(): Converter | null {
  return loaded;
}
