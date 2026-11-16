/**
 * Saving a stream the page produced (T-699) to a file on disk.
 *
 * Where the File System Access API exists (Chromium), the stream is piped
 * straight into the file the reader picked, so nothing is held in memory and
 * an archive larger than RAM still saves. Elsewhere there is no way for a
 * page to hand the browser's download manager a stream without a service
 * worker, so the bytes are collected into a Blob first — Chromium and
 * Firefox both page large blobs to disk, but the save starts only when the
 * last byte has arrived.
 */

interface SaveFilePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{ createWritable: () => Promise<WritableStream<Uint8Array>> }>;
}

/** Where `saveStream` writes. */
export type SaveTarget =
  | { kind: "file"; writable: WritableStream<Uint8Array> }
  | { kind: "blob"; name: string };

/**
 * Asks where to save. Call it first thing in the click handler: the picker
 * may only open on a user gesture, and an `await` before it spends that.
 * `null` means the reader dismissed the picker.
 */
export async function pickSaveTarget(
  name: string,
  type: { description: string; mime: string; extension: string },
): Promise<SaveTarget | null> {
  const picker = (window as SaveFilePickerWindow).showSaveFilePicker;
  if (picker === undefined) return { kind: "blob", name };
  try {
    const handle = await picker.call(window, {
      suggestedName: name,
      types: [
        {
          description: type.description,
          accept: { [type.mime]: [type.extension] },
        },
      ],
    });
    return { kind: "file", writable: await handle.createWritable() };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return null;
    }
    throw error;
  }
}

/**
 * Writes `stream` to `target`. A failure part-way aborts the file, which the
 * File System Access API keeps in a swap file until close — so a broken
 * archive never lands under the name the reader chose.
 */
export async function saveStream(
  target: SaveTarget,
  stream: ReadableStream<Uint8Array>,
): Promise<void> {
  if (target.kind === "file") {
    await stream.pipeTo(target.writable);
    return;
  }
  const blob = await new Response(stream).blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = target.name;
  anchor.click();
  // Not revoked at once: the click only queues the download, and Firefox
  // reads the URL some time after this function returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
