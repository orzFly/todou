// QuickJS ships no `Intl` at all, and unicode-segmenter's polyfill only adds
// `Segmenter` to an `Intl` that already exists. This runs first so that it
// has one to add to; prelude.ts imports it ahead of the polyfill for that
// reason.
const scope = globalThis as { Intl?: object };
scope.Intl ??= {};
