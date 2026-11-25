// Injected into the tjs bundle with esbuild's `--inject`, which evaluates it
// before any other module and rewrites every free `process` and `Buffer` in
// the bundle to these exports. That ordering matters: clipanion, for one,
// reads `process.stdout` and `process.env` while it loads, and string-width
// constructs an `Intl.Segmenter` at load.
//
// The globals are set too, for code that reaches them through `globalThis`
// rather than by name.
import "./intl-global.ts";
import "unicode-segmenter/intl-polyfill";
import { Buffer } from "buffer";
import { process } from "./process.ts";

const scope = globalThis as { process?: unknown; Buffer?: unknown };
scope.process = process;
scope.Buffer = Buffer;

export { Buffer, process };
