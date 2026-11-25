// node:readline for the tjs build: `createInterface(…).question()` and
// `close()`, which is how the CLI asks a yes/no question or reads a pasted
// token.
//
// On a terminal Node's readline puts the input into raw mode and echoes what
// is typed itself, so a muted output is what hides a token. The same happens
// here: raw mode, printable characters echoed to `output`, backspace, and
// Enter to finish. Ctrl-C ends the process with SIGINT, the way a terminal in
// cooked mode would. Off a terminal, a line is read as it arrives.

type Readable = {
  read(): Promise<Uint8Array | null>;
  setRawMode?: (enable: boolean) => unknown;
  isTTY?: boolean;
};
type Writable = { write(chunk: string): unknown };

class Interface {
  readonly #input: Readable;
  readonly #output: Writable | undefined;
  readonly #terminal: boolean;
  #pending = "";
  #closed = false;

  constructor(options: {
    input: Readable;
    output?: Writable;
    terminal?: boolean;
  }) {
    this.#input = options.input;
    this.#output = options.output;
    this.#terminal = options.terminal ?? Boolean(options.input.isTTY);
  }

  question(query: string, callback: (answer: string) => void): void {
    this.#output?.write(query);
    void (this.#terminal ? this.#readRaw() : this.#readLine()).then(callback);
  }

  close(): void {
    this.#closed = true;
  }

  async #readLine(): Promise<string> {
    for (;;) {
      const newline = this.#pending.indexOf("\n");
      if (newline !== -1) {
        const line = this.#pending.slice(0, newline).replace(/\r$/, "");
        this.#pending = this.#pending.slice(newline + 1);
        return line;
      }
      const chunk = this.#closed ? null : await this.#input.read();
      if (chunk === null) {
        const rest = this.#pending;
        this.#pending = "";
        return rest;
      }
      this.#pending += new TextDecoder().decode(chunk);
    }
  }

  async #readRaw(): Promise<string> {
    this.#input.setRawMode?.(true);
    let line = "";
    try {
      for (;;) {
        const chunk = await this.#input.read();
        if (chunk === null) return line;
        for (const char of new TextDecoder().decode(chunk)) {
          if (char === "\r" || char === "\n") {
            this.#output?.write("\r\n");
            return line;
          }
          if (char === "\u0003") {
            this.#input.setRawMode?.(false);
            tjs.kill(tjs.pid, "SIGINT");
            return line;
          }
          if (char === "\u007f" || char === "\b") {
            if (line.length > 0) {
              line = [...line].slice(0, -1).join("");
              this.#output?.write("\b \b");
            }
            continue;
          }
          if (char < " ") continue;
          line += char;
          this.#output?.write(char);
        }
      }
    } finally {
      this.#input.setRawMode?.(false);
    }
  }
}

export function createInterface(options: {
  input: Readable;
  output?: Writable;
  terminal?: boolean;
}): Interface {
  return new Interface(options);
}
