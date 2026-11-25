import type { FileHandle } from "node:fs/promises";

/**
 * The part of a Node writable this needs: `write` with its completion
 * callback, which is what carries back-pressure when the return value is not
 * looked at. `process.stdout` and every test's stream fit it.
 */
export type ChunkWriter = {
  write(chunk: Uint8Array, callback: (error?: Error | null) => void): unknown;
  /**
   * Present on a Node stream, which also reports a failed write as an `error`
   * event — one that takes the process down when nobody listens for it.
   */
  on?(event: "error", listener: (error: Error) => void): unknown;
  off?(event: "error", listener: (error: Error) => void): unknown;
};

/**
 * Copies a fetch body to a stream or an open file one chunk at a time, each
 * written before the next is read, so a large download never sits in memory
 * whole. It stands in for `Readable.fromWeb` plus `pipeline`, which the CLI's
 * single-file runtime does not have (T-792), and fails the same way they do:
 * a write that fails rejects, and the body is cancelled.
 *
 * The sink is never ended or closed here: stdout belongs to the process, and
 * a file belongs to whoever opened it.
 */
export async function pipeWebStream(
  body: ReadableStream<Uint8Array>,
  sink: ChunkWriter | FileHandle,
): Promise<void> {
  const reader = body.getReader();
  let onError: (error: Error) => void = () => {};
  const failed = new Promise<never>((_, reject) => {
    onError = reject;
  });
  // Only ever raced below; a failure after the copy has ended is nobody's.
  failed.catch(() => {});
  const writer = isFileHandle(sink) ? undefined : sink;
  writer?.on?.("error", onError);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (writer === undefined) await writeAll(sink as FileHandle, value);
      else await Promise.race([writeChunk(writer, value), failed]);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    writer?.off?.("error", onError);
    reader.releaseLock();
  }
}

// `stat` rather than `fd`: the single-file build's FileHandle has no
// descriptor to show, and no writable stream has a `stat`.
function isFileHandle(sink: ChunkWriter | FileHandle): sink is FileHandle {
  return typeof (sink as FileHandle).stat === "function";
}

function writeChunk(sink: ChunkWriter, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    sink.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

/** A file write may land short of the whole buffer; the rest goes after it. */
async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.length - offset,
    );
    offset += bytesWritten;
  }
}
