import { styleText } from "node:util";

type Style = Parameters<typeof styleText>[0];
export type Painter = (style: Style, text: string) => string;

/** Colors only when writing to a TTY; NO_COLOR force-disables them. */
export function makePainter(
  stream: unknown,
  env: Record<string, string | undefined> = process.env,
): Painter {
  const enabled =
    Boolean((stream as { isTTY?: boolean })?.isTTY) && !env.NO_COLOR;
  // The wrapper already decided against `stream`; styleText would otherwise
  // re-validate process.stdout, which is not where commands write.
  return (style, text) =>
    enabled ? styleText(style, text, { validateStream: false }) : text;
}

/** Space-aligned columns; empty trailing cells are not padded. */
export function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) =>
          i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

const STEPS: Array<[limit: number, divisor: number, unit: string]> = [
  [60, 1, "s"],
  [3600, 60, "m"],
  [86400, 3600, "h"],
  [2592000, 86400, "d"],
  [31536000, 2592000, "mo"],
];

export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  for (const [limit, divisor, unit] of STEPS) {
    if (seconds < limit) {
      return `${Math.floor(seconds / divisor)}${unit} ago`;
    }
  }
  return `${Math.floor(seconds / 31536000)}y ago`;
}
