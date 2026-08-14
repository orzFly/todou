import { closeSync, openSync, readSync, statSync } from "node:fs";

const CHUNK_BYTES = 256 * 1024;
// In Claude Code a single image Read appends a ~400 KB base64 tool_result
// line, and the current turn's assistant entry is not always flushed yet
// (T-42) — so the newest entry of interest can sit megabytes behind EOF.
// 16 MB bounds the worst-case I/O per command.
const MAX_SCAN_BYTES = 16 * 1024 * 1024;

/**
 * Newest-first scan of a JSONL transcript: calls `pick` on complete lines from
 * the end of the file and returns its first defined result. Shared because
 * every harness that keeps an append-only session log answers "what is the
 * live model?" the same way — read backwards until the newest entry that says
 * so, rather than parsing a file that grows without bound.
 *
 * Reading fails softly: an unreadable or truncated transcript yields
 * undefined, never a throw, and lines below the scan floor are simply never
 * offered to `pick`.
 */
export function findInJsonlTail<T>(
  file: string,
  pick: (line: string) => T | undefined,
): T | undefined {
  try {
    const size = statSync(file).size;
    const floor = Math.max(0, size - MAX_SCAN_BYTES);
    const fd = openSync(file, "r");
    try {
      let end = size;
      // Head fragment of a line that continues past the chunk boundary.
      // Kept as bytes: decoding per chunk would corrupt a multi-byte
      // character straddling the boundary.
      let carry: Buffer = Buffer.alloc(0);
      while (end > floor) {
        const start = Math.max(floor, end - CHUNK_BYTES);
        const chunk = readAt(fd, start, end - start);
        const window = carry.length ? Buffer.concat([chunk, carry]) : chunk;
        const firstNewline = window.indexOf(0x0a);
        if (firstNewline === -1) {
          // One line spans the whole window; keep accumulating backwards.
          carry = window;
        } else {
          const lines = window.toString("utf8", firstNewline + 1).split("\n");
          for (let i = lines.length - 1; i >= 0; i--) {
            const found = pick(lines[i] as string);
            if (found !== undefined) return found;
          }
          carry = window.subarray(0, firstNewline);
        }
        end = start;
      }
      // Only at the true start of the file is the leftover fragment a
      // complete line; below the scan floor its beginning is missing.
      if (floor === 0) return pick(carry.toString("utf8"));
    } finally {
      closeSync(fd);
    }
  } catch {
    // Unreadable transcript is never an error.
  }
  return undefined;
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const n = readSync(fd, buffer, filled, length - filled, position + filled);
    if (n === 0) break; // the file shrank underneath us
    filled += n;
  }
  return filled === length ? buffer : buffer.subarray(0, filled);
}
