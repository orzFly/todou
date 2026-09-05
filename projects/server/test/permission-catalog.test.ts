import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITIES, MEMBER_ROLES } from "@todou/shared";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** The one file allowed to name a role literally: the gate itself. */
const GATE = join(SRC, "services", "access.ts");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** The argument list of every `requireProject(` call in `text`, with lines. */
function requireProjectCalls(text: string): { line: number; args: string }[] {
  const calls: { line: number; args: string }[] = [];
  const needle = "requireProject(";
  for (
    let at = text.indexOf(needle);
    at !== -1;
    at = text.indexOf(needle, at + 1)
  ) {
    let depth = 0;
    let end = at + needle.length - 1;
    for (; end < text.length; end++) {
      if (text[end] === "(") depth++;
      else if (text[end] === ")" && --depth === 0) break;
    }
    calls.push({
      line: text.slice(0, at).split("\n").length,
      args: text.slice(at + needle.length, end),
    });
  }
  return calls;
}

const FILES = sourceFiles(SRC);

describe("no gate escapes the capability catalog", () => {
  it("has no requireProject call passing a role literal", () => {
    const roleLiteral = new RegExp(`"(${MEMBER_ROLES.join("|")})"`);
    const offenders: string[] = [];
    for (const file of FILES) {
      if (file === GATE) continue;
      for (const call of requireProjectCalls(readFileSync(file, "utf8"))) {
        if (roleLiteral.test(call.args)) {
          offenders.push(`${relative(SRC, file)}:${call.line}`);
        }
      }
    }
    expect(
      offenders,
      "A role spelled at the call site is a permission rule the table cannot " +
        "read and nobody changing the rules will find. Register the check as " +
        "a capability in shared/src/permissions.ts and call " +
        "requireCapability(ctx, actor, slug, '<id>') instead:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });
});

describe("no capability goes unused", () => {
  it("uses every gate capability somewhere in the server source", () => {
    const source = FILES.filter((f) => f !== GATE)
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    const orphans = CAPABILITIES.filter(
      (cap) => cap.enforce === "gate" && !source.includes(`"${cap.id}"`),
    ).map((cap) => cap.id);
    expect(
      orphans,
      "These capabilities claim to be enforced but no gate asks for them — " +
        "either the endpoint lost its check, or the entry should be deleted " +
        "from shared/src/permissions.ts:\n" +
        orphans.join("\n"),
    ).toEqual([]);
  });
});
