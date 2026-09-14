/**
 * The boundary values both metadata encodings round-trip, as one table. A
 * copy per suite lets the next extension reach only one side, and a value
 * that survives JSON but not Bulk is the defect this table exists to catch.
 */
export const METADATA_VALUE_CASES: Array<[string, string]> = [
  ["empty", ""],
  ["spaces", "   "],
  ["padded", "  padded  "],
  ["multiline", "one\ntwo\nthree"],
  ["with-EOF-line", "body\nEOF\nmore"],
  ["with-hash-line", "text\n# not a comment\nmore"],
  ["with-equals", "a=b=c"],
  ["leading-quote", '"quoted start'],
  ["cjk", "值有一行\n两行"],
  ["exact-limit", "x".repeat(4096)],
  // Falsifies by: dropping the `<<` exclusion from the Bulk serializer's
  // plain judgement — the value goes out bare and reads back as a heredoc
  // intro whose end mark never arrives.
  ["heredoc-intro", "<<EOF"],
  // The same removal, reaching the parser's other heredoc error: the intro
  // is malformed, so it reports an illegal mark instead.
  ["heredoc-intro-bad-mark", "<< EOF"],
  // The same removal, and it pins the exclusion to the prefix: spelled as a
  // whole-intro match such as `^<<[A-Za-z0-9_-]+$`, nothing here matches and
  // this row reddens alone.
  ["heredoc-intro-bare", "<<"],
  // Green today, because multi-line values already take the heredoc path.
  // What it guards is the shortcut that renders `<<`-leading values with a
  // hardcoded EOF mark: that heredoc closes on the body's own EOF line and
  // reads back one line short. It is the only row here — and the only value
  // in the exhaustive scan — that the shortcut reddens.
  ["heredoc-intro-with-mark-line", "<<EOF\nEOF"],
];
