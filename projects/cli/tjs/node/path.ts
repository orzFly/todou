// node:path for the tjs build: tjs:path is a port of Node's own module.
import path from "tjs:path";

export const {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} = path;
