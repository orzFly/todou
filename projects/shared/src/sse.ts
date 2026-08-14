/** One decoded `text/event-stream` frame. */
export type SseFrame = { event: string; data: string };

/**
 * Incremental decoder for the `text/event-stream` wire format, for clients
 * that cannot use the browser's EventSource — it offers no way to send an
 * Authorization header, which is the only way a CLI authenticates.
 *
 * Feed it whatever `ReadableStream` chunks arrive: frame boundaries fall
 * wherever the network splits the bytes, so a partial frame is held back
 * until its terminating blank line shows up.
 */
export class SseDecoder {
  #buffer = "";
  /** The previous chunk ended on a \r whose \n, if any, is still coming. */
  #splitCrlf = false;

  /** Every frame completed by `chunk`, in arrival order. */
  push(chunk: string): SseFrame[] {
    let text = chunk;
    // \r, \n and \r\n are all one line break, so they are normalized to \n
    // up front. The pair is the trap: a chunk can end between its halves,
    // and reading each half as its own break would spell a blank line
    // through the middle of a frame and cut it in two. So a trailing \r
    // breaks the line immediately and the \n that may follow it is
    // dropped, which is the same answer either way it arrives.
    if (this.#splitCrlf) {
      this.#splitCrlf = false;
      if (text.startsWith("\n")) text = text.slice(1);
    }
    // The break for a trailing \r is appended after normalizing, not
    // before: written into `text` it would pair with the \r ahead of it
    // and two line breaks would collapse into one.
    let tail = "";
    if (text.endsWith("\r")) {
      this.#splitCrlf = true;
      text = text.slice(0, -1);
      tail = "\n";
    }
    this.#buffer += text.replace(/\r\n?/g, "\n") + tail;
    const frames: SseFrame[] = [];
    for (;;) {
      const end = this.#buffer.indexOf("\n\n");
      if (end === -1) break;
      const frame = parseFrame(this.#buffer.slice(0, end));
      this.#buffer = this.#buffer.slice(end + 2);
      if (frame) frames.push(frame);
    }
    return frames;
  }
}

/** null for a frame carrying no data field (only comments, or only an id). */
function parseFrame(block: string): SseFrame | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    // A colon-led line is a comment; some proxies inject them as keep-alives.
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? "" : line.slice(colon + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length === 0 ? null : { event, data: data.join("\n") };
}
