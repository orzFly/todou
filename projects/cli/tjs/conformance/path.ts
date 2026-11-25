import type * as path from "node:path";
import { type Cases, equal } from "./assert.ts";

export const cases: Cases<typeof path> = {
  "join, relative, resolve and friends": async (mod) => {
    if (process.platform === "win32") return;
    equal(mod.join("/a/b", "../c", "./d"), "/a/c/d", "join");
    equal(mod.relative("/a/b/c", "/a/d"), "../../d", "relative");
    equal(mod.resolve("/a", "b", "../c"), "/a/c", "resolve");
    equal(mod.basename("/a/b.txt"), "b.txt", "basename");
    equal(mod.basename("/a/b.txt", ".txt"), "b", "basename with ext");
    equal(mod.dirname("/a/b/c"), "/a/b", "dirname");
    equal(mod.extname("x.tar.gz"), ".gz", "extname");
    equal(mod.isAbsolute("/x"), true, "absolute");
    equal(mod.isAbsolute("x"), false, "relative");
    equal(mod.sep, "/", "sep");
    equal(mod.delimiter, ":", "delimiter");
    equal(mod.resolve("x"), mod.join(process.cwd(), "x"), "resolve from cwd");
  },
};
