import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITIES } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { GUEST_COVERED } from "./guest-covered.ts";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** The gates themselves, which name capabilities without being a call site. */
const GATE = join(SRC, "services", "access.ts");

const GUEST_CAPS = new Set<string>(
  CAPABILITIES.filter((cap) => (cap as { guest?: "own" }).guest === "own").map(
    (cap) => cap.id,
  ),
);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** The argument list of every call to `name` in `text`, with its offset. */
function callsOf(text: string, name: string): { at: number; args: string }[] {
  const calls: { at: number; args: string }[] = [];
  const needle = `${name}(`;
  for (
    let at = text.indexOf(needle);
    at !== -1;
    at = text.indexOf(needle, at + 1)
  ) {
    // `fooRequireCapability(` and the declaration itself are not call sites.
    const before = text[at - 1] ?? "";
    if (/[\w$]/.test(before)) continue;
    if (text.slice(Math.max(0, at - 9), at) === "function ") continue;
    let depth = 0;
    let end = at + needle.length - 1;
    for (; end < text.length; end++) {
      if (text[end] === "(") depth++;
      else if (text[end] === ")" && --depth === 0) break;
    }
    calls.push({ at, args: text.slice(at + needle.length, end) });
  }
  return calls;
}

/**
 * The function a call sits in: the nearest declaration above it, or the
 * route constant an `app.openapi(route, …)` handler is registered under.
 */
function enclosing(text: string, at: number): string {
  const head = text.slice(0, at);
  const marks = [
    ...head.matchAll(/(?:async )?function (\w+)\s*[(<]/g),
    ...head.matchAll(/app\.openapi\(\s*(\w+)/g),
  ];
  let best: RegExpMatchArray | undefined;
  for (const mark of marks) {
    if (best === undefined || (mark.index ?? 0) > (best.index ?? 0)) {
      best = mark;
    }
  }
  return best?.[1] ?? "(top level)";
}

/** Every call site that lets a guest in: a guest capability, or an address read. */
function guestCallSites(): string[] {
  const sites = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    if (file === GATE) continue;
    const text = readFileSync(file, "utf8");
    const where = relative(SRC, file);
    for (const name of [
      "requireCapability",
      "requireCapabilities",
      "authorizeProjects",
    ]) {
      for (const call of callsOf(text, name)) {
        const cap = /"([a-z_]+\.[a-z_]+)"/.exec(call.args)?.[1];
        if (cap !== undefined && GUEST_CAPS.has(cap)) {
          sites.add(`${where}#${enclosing(text, call.at)}`);
        }
      }
    }
    for (const call of callsOf(text, "projectForRead")) {
      sites.add(`${where}#${enclosing(text, call.at)}`);
    }
  }
  return [...sites].sort();
}

describe("every path a guest is let through has an isolation case", () => {
  const sites = guestCallSites();

  it("finds the call sites it is meant to guard", () => {
    // A scanner that matched nothing would pass the check below vacuously.
    expect(sites).toContain("services/issues.ts#listIssues");
    expect(sites).toContain("services/comments.ts#getComment");
    expect(sites.length).toBeGreaterThan(40);
  });

  it("lists each one in GUEST_COVERED", () => {
    const missing = sites.filter((site) => !(site in GUEST_COVERED));
    expect(
      missing,
      'These gates let a guest in (a capability marked `guest: "own"`, or ' +
        "an address read), but guest-visibility.test.ts names no case that " +
        "proves another member's cards stay invisible through them. Add the " +
        "case, then the entry:\n" +
        missing.join("\n"),
    ).toEqual([]);
  });

  it("lists nothing that no longer exists", () => {
    const stale = Object.keys(GUEST_COVERED).filter(
      (site) => !sites.includes(site),
    );
    expect(stale).toEqual([]);
  });
});
