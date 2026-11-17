// Stands in for dompurify wherever the CLI loads mermaid. Without a window,
// dompurify's default export has no addHook and no sanitize, and mermaid.parse
// calls both: a valid pie then failed with "DOMPurify.addHook is not a
// function", and so did a broken flowchart, in place of its real error. Nothing parsed here is rendered or emitted as HTML, so passing
// text through unsanitized opens nothing.
const noop = (): void => {};

export default {
  addHook: noop,
  removeHook: noop,
  removeHooks: noop,
  removeAllHooks: noop,
  sanitize: (input: unknown) => input,
};
