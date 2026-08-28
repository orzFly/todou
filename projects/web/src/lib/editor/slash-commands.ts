import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  startCompletion,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { Extension, Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import {
  type CommandDef,
  type CommandRegistry,
  commandLinesOf,
} from "@/lib/slash-commands.ts";
import { inCodeContext } from "./ref-completion.ts";

/**
 * The editor half of slash commands (T-161): a panel to type them with, and
 * a highlight so a recognized command line is visibly different from prose.
 * Neither decides anything — `lib/slash-commands.ts` is the single verdict on
 * what a line means, and it runs again at submit time on the same text.
 *
 * The registry arrives with three async queries, so it comes in through a
 * getter: rebuilding the extension whenever it changes would reconfigure the
 * editor mid-typing and close whatever panel was open.
 */

/** The whole line up to the cursor, which is all a command can occupy. */
function lineBefore(context: CompletionContext): {
  text: string;
  from: number;
} {
  const line = context.state.doc.lineAt(context.pos);
  return {
    text: line.text.slice(0, context.pos - line.from),
    from: line.from,
  };
}

const FIRST_LEVEL = /^\/([a-z0-9-]*)$/;
const SECOND_LEVEL = /^\/([a-z0-9-]+)[ \t]+(.*)$/;

function firstLevelOption(command: CommandDef): Completion {
  return {
    label: `/${command.name}`,
    detail: command.detail,
    type: "command",
    apply: (view, _completion, from, to) => {
      // A trailing space for the argument, then straight into the second
      // level — picking `/label` without a label is never the whole intent.
      const insert =
        command.argument === "none" ? `/${command.name}` : `/${command.name} `;
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
      });
      if (command.argument !== "none") startCompletion(view);
    },
  };
}

export function commandCompletionSource(
  getRegistry: () => CommandRegistry | null,
): (context: CompletionContext) => CompletionResult | null {
  return (context: CompletionContext): CompletionResult | null => {
    const registry = getRegistry();
    if (registry === null) return null;
    const { text, from } = lineBefore(context);
    if (!text.startsWith("/")) return null;
    if (inCodeContext(syntaxTree(context.state), context.pos)) return null;

    const first = FIRST_LEVEL.exec(text);
    if (first !== null) {
      return {
        from,
        options: registry.commands.map(firstLevelOption),
      };
    }

    const second = SECOND_LEVEL.exec(text);
    if (second === null) return null;
    const command = registry.byName.get(second[1] as string);
    if (command === undefined || command.argument === "none") return null;
    const typed = second[2] as string;
    const names =
      command.argument === "label"
        ? registry.labelNames
        : command.argument === "member"
          ? registry.memberLogins
          : registry.statusNames;
    if (names.length === 0) return null;
    return {
      from: context.pos - typed.length,
      options: names.map((name) => ({ label: name, type: "command" })),
    };
  };
}

const commandLine = Decoration.line({ class: "cm-command-line" });
const brokenCommandLine = Decoration.line({
  class: "cm-command-line cm-command-line-broken",
});

function commandDecorations(
  view: EditorView,
  registry: CommandRegistry | null,
): DecorationSet {
  if (registry === null) return Decoration.none;
  const doc = view.state.doc;
  const found = commandLinesOf(doc.toString(), registry);
  const marks: Range<Decoration>[] = [];
  for (const [index, recognized] of found) {
    const line = doc.line(index + 1);
    marks.push(
      (recognized.compiled === null ? brokenCommandLine : commandLine).range(
        line.from,
      ),
    );
  }
  return Decoration.set(marks);
}

/**
 * Highlight for recognized command lines. Redrawn when the document changes
 * and when the registry finally arrives — the latter is why the plugin keeps
 * the last registry it saw rather than reading it once at construction.
 */
function commandHighlight(
  getRegistry: () => CommandRegistry | null,
): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      #registry: CommandRegistry | null;

      constructor(view: EditorView) {
        this.#registry = getRegistry();
        this.decorations = commandDecorations(view, this.#registry);
      }

      update(update: ViewUpdate) {
        const registry = getRegistry();
        if (!update.docChanged && registry === this.#registry) return;
        this.#registry = registry;
        this.decorations = commandDecorations(update.view, registry);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

const commandTheme = EditorView.theme({
  ".cm-command-line": {
    backgroundColor: "color-mix(in oklab, var(--primary) 18%, transparent)",
    borderRadius: "0.25rem",
  },
  ".cm-command-line-broken": {
    backgroundColor: "color-mix(in oklab, var(--destructive) 16%, transparent)",
    textDecoration: "underline wavy var(--destructive)",
    textDecorationSkipInk: "none",
  },
});

/** The highlight and theme half; the panel source is registered by the caller. */
export function commandDecoration(
  getRegistry: () => CommandRegistry | null,
): Extension {
  return [commandHighlight(getRegistry), commandTheme];
}
