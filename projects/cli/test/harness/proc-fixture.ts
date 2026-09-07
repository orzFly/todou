import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import type { ProcessTreeIo } from "../../src/harness/process-tree.ts";

export type Proc = {
  pid: number;
  ppid: number;
  uid?: number;
  env?: Record<string, string>;
  argv?: string[];
  cwd?: string;
  comm?: string;
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A temporary directory removed with the fixtures above. */
export function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** A fake /proc holding exactly the chain a test cares about. */
export function procTree(procs: Proc[]): Partial<ProcessTreeIo> {
  const root = scratchDir("todou-proc-");
  for (const p of procs) {
    const dir = join(root, String(p.pid));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "stat"),
      `${p.pid} (${p.comm ?? "proc"}) S ${p.ppid} 0 0 0 -1 0 0 0 0 0 0 0`,
    );
    writeFileSync(
      join(dir, "environ"),
      `${Object.entries(p.env ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join("\0")}\0`,
    );
    writeFileSync(join(dir, "cmdline"), `${(p.argv ?? ["proc"]).join("\0")}\0`);
    if (p.cwd) symlinkSync(p.cwd, join(dir, "cwd"));
  }
  return {
    platform: "linux",
    procRoot: root,
    startPid: procs[0]?.pid ?? 1,
  };
}

/** A /proc with nothing in it: the "no process tree" degradation. */
export function noTree(): Partial<ProcessTreeIo> {
  return procTree([]);
}
