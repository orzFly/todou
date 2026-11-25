import { main } from "./main.ts";

// An exit code rather than process.exit: stderr to a pipe is asynchronous, and
// exiting outright can drop the very lines a failing run exists to print. A
// `.then` rather than a top-level await, which the CommonJS bundle cannot hold.
void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
