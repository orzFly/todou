import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import type { Label, Member, Status } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { commandCompletionSource } from "../src/lib/editor/slash-commands.ts";
import {
  buildCommandRegistry,
  commandLinesOf,
  parseCommandLines,
  recognizeCommandLine,
  slugifyCommandName,
  summarizeCommands,
} from "../src/lib/slash-commands.ts";

const status = (
  id: number,
  name: string,
  category: "open" | "closed",
  position: number,
  is_default = false,
): Status => ({ id, name, category, color: "#000000", position, is_default });

const STATUSES: Status[] = [
  status(1, "Todo", "open", 0, true),
  status(2, "In Progress", "open", 1),
  status(3, "Done", "closed", 2),
  status(4, "Won't Fix", "closed", 3),
];

const LABELS: Label[] = [
  { id: 10, name: "bug", color: "#ff0000" },
  { id: 11, name: "area: web", color: "#00ff00" },
];

const member = (id: number, login: string): Member => ({
  user: {
    id,
    login,
    display_name: login,
    kind: "human",
    avatar_url: null,
    owner: null,
  },
  role: "writer",
  created_at: "2026-01-01T00:00:00.000Z",
});

const MEMBERS: Member[] = [member(100, "alice"), member(101, "Bob")];
const ME = { id: 100, login: "alice" };

const registry = buildCommandRegistry({
  statuses: STATUSES,
  labels: LABELS,
  members: MEMBERS,
  me: ME,
});

describe("slugifyCommandName", () => {
  it("lowercases and folds whitespace into hyphens", () => {
    expect(slugifyCommandName("In Progress")).toBe("in-progress");
    expect(slugifyCommandName("  Needs   Review ")).toBe("needs-review");
  });

  it("drops what a command word cannot carry", () => {
    expect(slugifyCommandName("Won't Fix")).toBe("wont-fix");
    expect(slugifyCommandName("Blocked?!")).toBe("blocked");
    expect(slugifyCommandName("需要评审")).toBe("");
  });
});

describe("buildCommandRegistry", () => {
  it("derives one command per status, plus the fixed ones", () => {
    expect(registry.commands.map((c) => c.name)).toEqual([
      "close",
      "reopen",
      "status",
      "label",
      "unlabel",
      "assign",
      "unassign",
      "todo",
      "in-progress",
      "done",
      "wont-fix",
    ]);
  });

  it("closes to the first closed status and reopens to the default open one", () => {
    expect(recognizeCommandLine("/close", registry)?.compiled).toEqual({
      type: "status",
      status_id: 3,
    });
    expect(recognizeCommandLine("/reopen", registry)?.compiled).toEqual({
      type: "status",
      status_id: 1,
    });
  });

  it("keeps a reserved word for itself when a status name collides", () => {
    const colliding = buildCommandRegistry({
      statuses: [status(7, "Close", "closed", 0), status(8, "Open", "open", 1)],
      labels: [],
      members: [],
      me: ME,
    });
    // /close is still the closed-category shorthand — which here happens to
    // be the same status — and the colliding name is reachable explicitly.
    expect(colliding.commands.filter((c) => c.name === "close")).toHaveLength(
      1,
    );
    expect(recognizeCommandLine("/status Close", colliding)?.compiled).toEqual({
      type: "status",
      status_id: 7,
    });
    expect(colliding.commands.map((c) => c.name)).toContain("open");
  });

  it("offers no /close when the project has no closed status", () => {
    const openOnly = buildCommandRegistry({
      statuses: [status(1, "Todo", "open", 0)],
      labels: [],
      members: [],
      me: ME,
    });
    expect(openOnly.byName.has("close")).toBe(false);
  });
});

describe("recognizeCommandLine", () => {
  it("takes the rest of the line as the argument", () => {
    const parsed = recognizeCommandLine("/label area: web", registry);
    expect(parsed?.argument).toBe("area: web");
    expect(parsed?.compiled).toEqual({ type: "label_add", label_id: 11 });
  });

  it("matches label and status names case-insensitively", () => {
    expect(recognizeCommandLine("/unlabel BUG", registry)?.compiled).toEqual({
      type: "label_remove",
      label_id: 10,
    });
    expect(recognizeCommandLine("/status done", registry)?.compiled).toEqual({
      type: "status",
      status_id: 3,
    });
  });

  it("resolves me and @-prefixed logins for assignment", () => {
    expect(recognizeCommandLine("/assign me", registry)?.compiled).toEqual({
      type: "assign",
      user_id: 100,
    });
    expect(recognizeCommandLine("/unassign @bob", registry)?.compiled).toEqual({
      type: "unassign",
      user_id: 101,
    });
  });

  it("recognizes but does not compile an argument naming nothing", () => {
    const parsed = recognizeCommandLine("/label nope", registry);
    expect(parsed?.argument).toBe("nope");
    expect(parsed?.compiled).toBeNull();
  });

  it("ignores unknown commands and misspellings", () => {
    expect(recognizeCommandLine("/clsoe", registry)).toBeNull();
    expect(recognizeCommandLine("/", registry)).toBeNull();
  });

  it("wants the slash at the start of the line", () => {
    expect(recognizeCommandLine("please /close", registry)).toBeNull();
    expect(recognizeCommandLine(" /close", registry)).toBeNull();
  });

  it("rejects a no-argument command with trailing words", () => {
    expect(recognizeCommandLine("/close this now", registry)).toBeNull();
    expect(recognizeCommandLine("/close   ", registry)?.argument).toBe("");
  });

  it("rejects an argument-taking command with no argument", () => {
    expect(recognizeCommandLine("/label", registry)).toBeNull();
    expect(recognizeCommandLine("/assign", registry)).toBeNull();
  });
});

describe("parseCommandLines", () => {
  it("strips the command lines out of the body", () => {
    const parsed = parseCommandLines(
      "Shipping this.\n/close\n/label bug",
      registry,
    );
    expect(parsed.body).toBe("Shipping this.");
    expect(parsed.commands).toEqual([
      { type: "status", status_id: 3 },
      { type: "label_add", label_id: 10 },
    ]);
    expect(parsed.invalid).toEqual([]);
  });

  it("keeps the surrounding prose intact, blank lines and all", () => {
    const parsed = parseCommandLines(
      "first line\n\n/in-progress\n\nsecond line",
      registry,
    );
    expect(parsed.body).toBe("first line\n\n\nsecond line");
  });

  it("yields an empty body for a commands-only draft", () => {
    const parsed = parseCommandLines("/close", registry);
    expect(parsed.body).toBe("");
    expect(parsed.commands).toHaveLength(1);
  });

  it("leaves unknown slash lines in the body", () => {
    const parsed = parseCommandLines("/clsoe\n/close", registry);
    expect(parsed.body).toBe("/clsoe");
    expect(parsed.commands).toEqual([{ type: "status", status_id: 3 }]);
  });

  it("never reads commands inside a fenced code block", () => {
    const parsed = parseCommandLines(
      "```sh\n/close\n```\n/label bug",
      registry,
    );
    expect(parsed.body).toBe("```sh\n/close\n```");
    expect(parsed.commands).toEqual([{ type: "label_add", label_id: 10 }]);
  });

  it("honours tilde fences and longer closing fences", () => {
    expect(parseCommandLines("~~~\n/close\n~~~", registry).commands).toEqual(
      [],
    );
    expect(
      parseCommandLines("````\n```\n/close\n````\n/close", registry).commands,
    ).toHaveLength(1);
  });

  it("treats an unclosed fence as code to its end", () => {
    expect(parseCommandLines("```\n/close", registry).commands).toEqual([]);
  });

  it("leaves an inline-code command as prose", () => {
    const parsed = parseCommandLines("type `/close` to finish", registry);
    expect(parsed.body).toBe("type `/close` to finish");
    expect(parsed.commands).toEqual([]);
  });

  it("reports an unresolvable argument instead of guessing", () => {
    const parsed = parseCommandLines("/label nope\n/assign nobody", registry);
    expect(parsed.commands).toEqual([]);
    expect(parsed.invalid).toEqual([
      { line: "/label nope", reason: 'no label named "nope"' },
      { line: "/assign nobody", reason: 'no member named "nobody"' },
    ]);
  });

  it("applies repeated commands in the order they appear", () => {
    const parsed = parseCommandLines("/in-progress\n/close", registry);
    expect(parsed.commands).toEqual([
      { type: "status", status_id: 2 },
      { type: "status", status_id: 3 },
    ]);
  });

  it("summarizes what the submit button is about to do", () => {
    const parsed = parseCommandLines(
      "/close\n/label bug\n/assign me",
      registry,
    );
    expect(parsed.summaries).toEqual(["close", "label bug", "assign me"]);
    expect(summarizeCommands(parsed.summaries)).toBe(
      "close, label bug and assign me",
    );
    expect(summarizeCommands(["close"])).toBe("close");
    expect(summarizeCommands([])).toBe("");
  });

  it("names the status a dynamic command moves to", () => {
    expect(parseCommandLines("/in-progress", registry).summaries).toEqual([
      "move to In Progress",
    ]);
    expect(parseCommandLines("/status Done", registry).summaries).toEqual([
      "move to Done",
    ]);
  });
});

describe("commandCompletionSource (the panel)", () => {
  const source = commandCompletionSource(() => registry);
  const at = (doc: string, pos = doc.length) =>
    source(new CompletionContext(EditorState.create({ doc }), pos, false));

  it("opens the whole command list on a line-leading slash", () => {
    const result = at("/");
    expect(result?.from).toBe(0);
    expect(result?.options.map((o) => o.label)).toEqual([
      "/close",
      "/reopen",
      "/status",
      "/label",
      "/unlabel",
      "/assign",
      "/unassign",
      "/todo",
      "/in-progress",
      "/done",
      "/wont-fix",
    ]);
  });

  it("shows each command's target so the panel says where it lands", () => {
    const options = at("/")?.options ?? [];
    expect(options.find((o) => o.label === "/close")?.detail).toBe("→ Done");
    expect(options.find((o) => o.label === "/in-progress")?.detail).toBe(
      "→ In Progress",
    );
  });

  it("offers arguments once the command is typed", () => {
    expect(at("/label ")?.options.map((o) => o.label)).toEqual([
      "bug",
      "area: web",
    ]);
    expect(at("/assign ")?.options.map((o) => o.label)).toEqual([
      "me",
      "alice",
      "Bob",
    ]);
    expect(at("/status ")?.options.map((o) => o.label)).toEqual([
      "Todo",
      "In Progress",
      "Done",
      "Won't Fix",
    ]);
  });

  it("replaces only the argument already typed", () => {
    const result = at("/label ar");
    expect(result?.from).toBe("/label ".length);
  });

  it("stays shut where a command cannot live", () => {
    expect(at("please /close")).toBeNull();
    // A no-argument command has no second stage.
    expect(at("/close ")).toBeNull();
    expect(at("/clsoe ")).toBeNull();
  });

  it("yields nothing without a registry", () => {
    const bare = commandCompletionSource(() => null);
    expect(
      bare(new CompletionContext(EditorState.create({ doc: "/" }), 1, false)),
    ).toBeNull();
  });
});

describe("commandLinesOf (what the editor highlights)", () => {
  it("reports the line numbers carrying a command", () => {
    const found = commandLinesOf("prose\n/close\n```\n/close\n```", registry);
    expect([...found.keys()]).toEqual([1]);
  });

  it("highlights a recognized line even when its argument resolves to nothing", () => {
    const found = commandLinesOf("/label nope", registry);
    expect(found.get(0)?.compiled).toBeNull();
    expect([...found.keys()]).toEqual([0]);
  });
});
