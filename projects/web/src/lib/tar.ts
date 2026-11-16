/**
 * An uncompressed tar archive written as a stream (T-699): each entry's
 * body is opened only when the archive reaches it and passed through chunk
 * by chunk, so a bundle of large files never sits in memory whole.
 *
 * POSIX ustar with pax extended headers, which every extractor still in use
 * reads — GNU tar, bsdtar (macOS, Windows 10+), 7-Zip.
 */

export interface TarEntry {
  /** Path inside the archive. Any length, any script: pax carries it. */
  name: string;
  /**
   * Written into the header before the first body byte exists, which is why
   * a body that turns out longer or shorter fails the archive rather than
   * corrupting every entry after it.
   */
  size: number;
  mtime: Date;
  open: () => Promise<ReadableStream<Uint8Array>>;
}

const BLOCK = 512;
const encoder = new TextEncoder();

/** Largest value an 11-digit octal header field holds: 8 GiB − 1. */
const MAX_OCTAL = 0o77777777777;

function writeString(header: Uint8Array, offset: number, value: string) {
  header.set(encoder.encode(value), offset);
}

/** Zero-padded octal plus the NUL terminator, filling `width` bytes. */
function writeOctal(
  header: Uint8Array,
  offset: number,
  width: number,
  value: number,
) {
  writeString(
    header,
    offset,
    `${value.toString(8).padStart(width - 1, "0")}\0`,
  );
}

function headerBlock(
  name: string,
  size: number,
  mtime: number,
  type: "0" | "x",
): Uint8Array {
  const header = new Uint8Array(BLOCK);
  writeString(header, 0, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, mtime);
  writeString(header, 156, type);
  writeString(header, 257, "ustar\0");
  writeString(header, 263, "00");
  // The checksum is summed with its own field read as eight spaces.
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  writeString(header, 148, `${sum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

/**
 * One pax record, `"<len> <key>=<value>\n"`, where `<len>` counts the whole
 * record including its own digits — so adding a digit can push the total
 * over to needing one more.
 */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bodyLength = encoder.encode(body).length;
  const digits = String(bodyLength).length;
  let length = bodyLength + digits;
  if (String(length).length > digits) length++;
  return `${length}${body}`;
}

/**
 * What the plain header's 100-byte name field can hold of `name`: the
 * fallback a pax-unaware reader would use, kept recognisable.
 */
function asciiName(name: string): string {
  return name.replaceAll(/[^ -~]/g, "_").slice(0, 100);
}

function padding(size: number): Uint8Array | null {
  const rest = size % BLOCK;
  return rest === 0 ? null : new Uint8Array(BLOCK - rest);
}

function* entryHeader(entry: TarEntry): Generator<Uint8Array> {
  const mtime = Math.max(0, Math.floor(entry.mtime.getTime() / 1000));
  const fallback = asciiName(entry.name);
  const records = [
    fallback === entry.name ? "" : paxRecord("path", entry.name),
    entry.size > MAX_OCTAL ? paxRecord("size", String(entry.size)) : "",
  ].join("");
  if (records !== "") {
    const pax = encoder.encode(records);
    yield headerBlock(
      `PaxHeader/${fallback}`.slice(0, 100),
      pax.length,
      mtime,
      "x",
    );
    yield pax;
    const pad = padding(pax.length);
    if (pad) yield pad;
  }
  yield headerBlock(fallback, Math.min(entry.size, MAX_OCTAL), mtime, "0");
}

async function* tarChunks(
  entries: readonly TarEntry[],
  onProgress?: (bytes: number) => void,
): AsyncGenerator<Uint8Array> {
  let total = 0;
  for (const entry of entries) {
    yield* entryHeader(entry);
    const reader = (await entry.open()).getReader();
    let written = 0;
    let finished = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          finished = true;
          break;
        }
        written += value.length;
        if (written > entry.size) {
          throw new Error(
            `${entry.name} is larger than its listed ${entry.size} bytes`,
          );
        }
        yield value;
        total += value.length;
        onProgress?.(total);
      }
    } finally {
      // Abandoned mid-body — a cancelled save, an oversize body — the
      // response is still downloading into nothing until told to stop.
      if (!finished) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (written !== entry.size) {
      throw new Error(
        `${entry.name} ended after ${written} of ${entry.size} bytes`,
      );
    }
    const pad = padding(entry.size);
    if (pad) yield pad;
  }
  yield new Uint8Array(BLOCK * 2);
}

/**
 * The archive as a pull stream: nothing is fetched until the consumer reads,
 * and a cancelled read stops the archive before the next entry is opened.
 * `onProgress` reports body bytes written so far — headers excluded, so the
 * sum of the entries' sizes is where it ends.
 */
export function tarStream(
  entries: readonly TarEntry[],
  onProgress?: (bytes: number) => void,
): ReadableStream<Uint8Array> {
  const chunks = tarChunks(entries, onProgress);
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const next = await chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      async cancel() {
        await chunks.return(undefined);
      },
    },
    { highWaterMark: 0 },
  );
}
