// Every conformance suite next to the module it runs against. The imports are
// plain `node:*` specifiers: vitest resolves them to Node's own modules, and
// the tjs bundle (scripts/tjs-conformance.mjs) to the shims, so one list
// serves both runs.
import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as util from "node:util";
// biome-ignore lint/style/useNodejsImportProtocol: the bare name is clipanion's, and the one the tjs build aliases
import * as tty from "tty";
import type { Cases } from "./assert.ts";
import { cases as childProcessCases } from "./child-process.ts";
import { cases as cryptoCases } from "./crypto.ts";
import { cases as fsCases } from "./fs.ts";
import { cases as fsPromisesCases } from "./fs-promises.ts";
import { cases as httpCases } from "./http.ts";
import { cases as netCases } from "./net.ts";
import { cases as osCases } from "./os.ts";
import { cases as pathCases } from "./path.ts";
import { cases as ttyCases } from "./tty.ts";
import { cases as utilCases } from "./util.ts";

export type Suite = { module: string; cases: Cases<never>; mod: unknown };

const suite = <M>(module: string, cases: Cases<M>, mod: M): Suite => ({
  module,
  cases: cases as Cases<never>,
  mod,
});

export const suites: Suite[] = [
  suite("node:fs/promises", fsPromisesCases, fsPromises),
  suite("node:fs", fsCases, fs),
  suite("node:child_process", childProcessCases, childProcess),
  suite("node:path", pathCases, path),
  suite("node:os", osCases, os),
  suite("node:crypto", cryptoCases, crypto),
  suite("node:util", utilCases, util),
  suite("node:net", netCases, net),
  suite("node:http", httpCases, http),
  suite("tty", ttyCases, tty),
];
