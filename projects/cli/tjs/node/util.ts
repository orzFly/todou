// node:util for the tjs build.
//
// styleText only ever runs with `validateStream: false` (format.ts decides on
// colour itself), so this is Node's ANSI generation without the stream
// checks: the same codes, the same nesting, the same handling of a close code
// already inside the text. Hex colours are left out; nothing in the CLI asks
// for one.

const COLORS: Record<string, readonly [number, number]> = {
  reset: [0, 0],
  bold: [1, 22],
  dim: [2, 22],
  italic: [3, 23],
  underline: [4, 24],
  blink: [5, 25],
  inverse: [7, 27],
  hidden: [8, 28],
  strikethrough: [9, 29],
  doubleunderline: [21, 24],
  black: [30, 39],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  white: [37, 39],
  bgBlack: [40, 49],
  bgRed: [41, 49],
  bgGreen: [42, 49],
  bgYellow: [43, 49],
  bgBlue: [44, 49],
  bgMagenta: [45, 49],
  bgCyan: [46, 49],
  bgWhite: [47, 49],
  framed: [51, 54],
  overlined: [53, 55],
  gray: [90, 39],
  redBright: [91, 39],
  greenBright: [92, 39],
  yellowBright: [93, 39],
  blueBright: [94, 39],
  magentaBright: [95, 39],
  cyanBright: [96, 39],
  whiteBright: [97, 39],
  bgGray: [100, 49],
  bgRedBright: [101, 49],
  bgGreenBright: [102, 49],
  bgYellowBright: [103, 49],
  bgBlueBright: [104, 49],
  bgMagentaBright: [105, 49],
  bgCyanBright: [106, 49],
  bgWhiteBright: [107, 49],
};

const sgr = (code: number) => `\u001b[${code}m`;

// A close code inside the text would end the style early. Node re-opens the
// style after it, except at the very end of the text, and keeps the close
// itself only for 22, which bold and dim share: dropping it there would leave
// the inner one of the two switched on.
function replaceCloseCode(
  text: string,
  closeSeq: string,
  openSeq: string,
  keepClose: boolean,
): string {
  let index = text.indexOf(closeSeq);
  if (index === -1) return text;
  const replacement = keepClose ? closeSeq + openSeq : openSeq;
  let result = "";
  let last = 0;
  while (index !== -1) {
    const after = index + closeSeq.length;
    result += text.slice(last, index);
    result += after === text.length ? closeSeq : replacement;
    last = after;
    index = text.indexOf(closeSeq, last);
  }
  return result + text.slice(last);
}

export function styleText(
  format: string | readonly string[],
  text: string,
  _options?: { validateStream?: boolean; stream?: unknown },
): string {
  let openCodes = "";
  let closeCodes = "";
  let processed = text;
  for (const key of typeof format === "string" ? [format] : format) {
    if (key === "none") continue;
    const codes = COLORS[key];
    if (codes === undefined) {
      throw new TypeError(
        `The argument 'format' must be one of: ${Object.keys(COLORS).join(", ")}. Received '${key}'`,
      );
    }
    const openSeq = sgr(codes[0]);
    const closeSeq = sgr(codes[1]);
    openCodes += openSeq;
    closeCodes = closeSeq + closeCodes;
    processed = replaceCloseCode(processed, closeSeq, openSeq, codes[1] === 22);
  }
  return `${openCodes}${processed}${closeCodes}`;
}

/**
 * Node's isDeepStrictEqual, for what config.ts hands it: two values parsed
 * from TOML, so plain objects, arrays, strings, numbers, booleans and Dates.
 */
export function isDeepStrictEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return false;
  }
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (a instanceof Date) {
    return Object.is(a.getTime(), (b as Date).getTime());
  }
  if (Array.isArray(a)) {
    const other = b as unknown[];
    if (a.length !== other.length) return false;
    return a.every((item, i) => isDeepStrictEqual(item, other[i]));
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) =>
      Object.hasOwn(b, key) &&
      isDeepStrictEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      ),
  );
}
