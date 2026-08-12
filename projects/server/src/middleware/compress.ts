import { pipeline, Readable } from "node:stream";
import { constants, createBrotliCompress, createGzip } from "node:zlib";
import { createMiddleware } from "hono/factory";
import { parseAccept } from "hono/utils/accept";
import { COMPRESSIBLE_CONTENT_TYPE_REGEX } from "hono/utils/compress";
import type { AppEnv } from "../auth/middleware.ts";

/** Below this many bytes the encoding overhead outweighs the savings. */
const THRESHOLD_BYTES = 1024;

/**
 * Brotli's default quality (11) is meant for ahead-of-time asset builds
 * and is an order of magnitude slower than gzip. Quality 5 is the lowest
 * level that still out-compresses gzip-6 even on high-entropy JSON
 * (~4.2x vs ~4.0x at comparable throughput, measured on a 1.3 MiB
 * timeline) — below that br loses the ratio race and would not deserve
 * its spot ahead of gzip in CANDIDATES.
 */
const BROTLI_QUALITY = 5;

/** Order is server preference when the client's q-values tie. */
const CANDIDATES = ["br", "gzip"] as const;
type Encoding = (typeof CANDIDATES)[number];

const cacheControlNoTransformRegExp = /(?:^|,)\s*?no-transform\s*?(?:,|$)/i;
const varyAcceptEncodingRegExp = /(?:^|,)\s*accept-encoding\s*(?:,|$)/i;

function selectEncoding(header: string | undefined): Encoding | undefined {
  if (header === undefined) return undefined;
  const accepts = parseAccept(header);
  const wildcardQ = accepts.find((a) => a.type === "*")?.q;
  let best: { encoding: Encoding; q: number } | undefined;
  for (const encoding of CANDIDATES) {
    const explicit = accepts.find((a) => a.type.toLowerCase() === encoding);
    const q = explicit ? explicit.q : (wildcardQ ?? 0);
    if (q === 1) return encoding;
    if (q > 0 && (!best || q > best.q)) best = { encoding, q };
  }
  return best?.encoding;
}

function makeEncoder(encoding: Encoding, sizeHint: number | undefined) {
  if (encoding === "gzip") return createGzip();
  return createBrotliCompress({
    params: {
      [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      ...(sizeHint === undefined
        ? {}
        : { [constants.BROTLI_PARAM_SIZE_HINT]: sizeHint }),
    },
  });
}

type Peeked =
  | { small: Uint8Array; rest?: undefined }
  | { small?: undefined; rest: ReadableStream<Uint8Array> };

/**
 * Dynamic hono responses carry no Content-Length, so the size gate has to
 * read the body itself: buffer until THRESHOLD_BYTES or EOF, whichever
 * comes first. This runs while the response is still inside the middleware
 * chain — headers are unsent — so both outcomes can still be reassembled
 * into a coherent response. Buffering is bounded by the threshold; large
 * or streamed bodies are never accumulated.
 */
async function peekBody(body: ReadableStream<Uint8Array>): Promise<Peeked> {
  const reader = body.getReader();
  const prefix: Uint8Array[] = [];
  let total = 0;
  while (total < THRESHOLD_BYTES) {
    const { done, value } = await reader.read();
    if (done) return { small: Buffer.concat(prefix, total) };
    prefix.push(value);
    total += value.byteLength;
  }
  return {
    rest: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of prefix) controller.enqueue(chunk);
      },
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    }),
  };
}

/**
 * Negotiated response compression (br preferred, then gzip) via node:zlib —
 * hono's own compress middleware is CompressionStream-based, which cannot
 * produce brotli under Node (only "gzip"/"deflate" formats) and whose size
 * threshold never fires for hono-built responses (no Content-Length yet).
 */
export function compressMiddleware() {
  return createMiddleware<AppEnv>(async (c, next) => {
    await next();
    const res = c.res;
    if (
      c.req.method === "HEAD" ||
      !res.body ||
      // Content-Range offsets refer to the uncompressed representation.
      res.status === 206 ||
      res.headers.has("Content-Encoding") ||
      res.headers.has("Transfer-Encoding")
    ) {
      return;
    }
    const type = res.headers.get("Content-Type");
    // The regex also rejects text/event-stream, but SSE deserves its own
    // line of defence: an encoder holds frames until its window fills, so a
    // compressed event stream stops being real-time — silently, and only in
    // production traffic. Keep this guard even if the filter below changes.
    if (!type || /^text\/event-stream\b/i.test(type)) return;
    if (!COMPRESSIBLE_CONTENT_TYPE_REGEX.test(type)) return;
    const cacheControl = res.headers.get("Cache-Control");
    if (cacheControl && cacheControlNoTransformRegExp.test(cacheControl)) {
      return;
    }

    // Vary is stamped before the encoding decision: an identity response
    // cached for this URL must not be replayed to gzip-capable clients,
    // and vice versa.
    const vary = res.headers.get("Vary");
    if (vary !== "*" && !(vary && varyAcceptEncodingRegExp.test(vary))) {
      res.headers.set(
        "Vary",
        vary ? `${vary}, Accept-Encoding` : "Accept-Encoding",
      );
    }

    const encoding = selectEncoding(c.req.header("Accept-Encoding"));
    if (!encoding) return;

    const declared = res.headers.get("Content-Length");
    const size = declared === null ? undefined : Number(declared);
    let body = res.body;
    if (size === undefined) {
      const peeked = await peekBody(body);
      if (peeked.small) {
        // Too small to be worth encoding; the original stream is consumed,
        // so hand the buffered bytes back as the response.
        c.res = new Response(peeked.small, res);
        return;
      }
      body = peeked.rest;
    } else if (size < THRESHOLD_BYTES) {
      return;
    }

    const encoder = makeEncoder(encoding, size);
    // pipeline (not .pipe) so a source error tears the encoder down instead
    // of leaving the response stream hanging; the error itself resurfaces
    // through the web stream below.
    pipeline(
      Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
      encoder,
      () => {},
    );
    c.res = new Response(Readable.toWeb(encoder) as ReadableStream, res);
    c.res.headers.delete("Content-Length");
    c.res.headers.set("Content-Encoding", encoding);
    const etag = c.res.headers.get("ETag");
    if (etag && !etag.startsWith("W/")) {
      // The bytes on the wire changed, so a strong validator no longer holds.
      c.res.headers.set("ETag", `W/${etag}`);
    }
  });
}
