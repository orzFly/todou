import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/**
 * Ask a yes/no question on stderr and read the answer from stdin. Default is
 * no: an empty line, EOF, or anything that is not `y`/`yes` declines, so a
 * stray Enter can never be the thing that destroys something.
 *
 * The prompt goes to stderr, not stdout — stdout carries data (see
 * ApiCommand.output), and a piped `--json` run must not find a question
 * mixed into its payload.
 */
export function confirm(
  stdin: Readable,
  stderr: Writable,
  question: string,
): Promise<boolean> {
  const rl = createInterface({
    input: stdin,
    output: stderr,
    terminal: Boolean((stdin as { isTTY?: boolean }).isTTY),
  });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === "y" || normalized === "yes");
    });
  });
}
