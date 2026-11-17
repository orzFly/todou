import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { commands } from "../src/commands/index.ts";
import { commandTable, guardUnknownCommand } from "../src/suggest.ts";
import { runCli } from "./harness.ts";

/**
 * `todou issue view [--server #0] …` → `issue view`, per listed entry. The
 * listing is bold-numbered whatever the color depth.
 */
function listed(stdout: string): string[] {
  const plain = stripVTControlCharacters(stdout);
  return [
    ...plain.matchAll(/^ +\d+\. todou ([a-z][\w-]*(?: [a-z][\w-]*)*)/gm),
  ].map((match) => match[1] as string);
}

/** First words that more than one command lives under, so help lists them. */
const namespaces = (() => {
  const under = new Map<string, Set<unknown>>();
  for (const command of commands) {
    for (const path of command.paths ?? []) {
      if (path.length < 2) continue;
      const ns = path[0] as string;
      under.set(ns, (under.get(ns) ?? new Set()).add(command));
    }
  }
  return [...under].filter(([, set]) => set.size > 1).map(([ns]) => ns);
})();

describe("namespace --help (T-728)", () => {
  it.each(namespaces)("lists each command under %s once", async (ns) => {
    const { stdout } = await runCli([ns, "--help"]);
    const names = listed(stdout);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toEqual([...new Set(names)]);
  });

  it("offers an alias under its first name only", async () => {
    const agent = listed((await runCli(["agent", "--help"])).stdout);
    expect(agent.filter((name) => name === "agent how-to-watch")).toHaveLength(
      1,
    );
    expect(agent).not.toContain("agent can-i-follow");

    const issue = listed((await runCli(["issue", "--help"])).stdout);
    expect(issue).toContain("issue view");
    expect(issue).not.toContain("issue show");
    expect(issue).not.toContain("issue update");
  });

  it("opens the entry -h=<index> names, counting as printed", async () => {
    const names = listed((await runCli(["issue", "--help"])).stdout);
    const index = names.indexOf("issue edit");
    expect(index).toBeGreaterThan(names.indexOf("issue view"));

    const argv = ["issue", `-h=${index}`];
    expect(guardUnknownCommand(argv, commandTable(commands))).toBeNull();
    const { stdout } = await runCli(argv);
    expect(stripVTControlCharacters(stdout)).toContain("$ todou issue edit");
  });
});
