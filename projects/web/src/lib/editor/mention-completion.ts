import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { QueryClient } from "@tanstack/react-query";
import { membersQuery } from "@/api/queries.ts";
import { inCodeContext } from "@/lib/editor/code-context.ts";
import { applyWithSpace } from "@/lib/editor/completion-space.ts";

/**
 * Mention completion (@login) beside the reference completion, as a second
 * SOURCE on the same panel — never a second `autocompletion()`, which would
 * install a second panel competing for the same keys (the note on
 * `completionWith` in ref-completion.ts).
 *
 * It inserts `@login` and a pending separator space: the same text a
 * hand-typist produces, resolved by the same server pass. Completion only
 * saves typing; it never creates a shape only it can produce — the principle
 * ref completion runs on (T-161), applied unchanged.
 */

const MAX_OPTIONS = 20;

/**
 * The `@login` the cursor is inside, if any. The query is the run of
 * login-shaped characters after the `@`; no `@`, no trigger.
 */
export function mentionTriggerAt(
  text: string,
): { at: number; query: string } | null {
  const match = /@([a-z0-9-]*)$/i.exec(text);
  if (match === null) return null;
  // `at` points at the `@` itself, so accepting replaces the whole token.
  // The panel refuses a `-` before the `@` too (npm scope, hyphenated
  // word) — deliberately stricter than the server grammar, whose left
  // boundary only rejects `\w`: a hand-typed `x-@alice` still resolves on
  // submit; the panel just declines to guess mid-word.
  const at = match.index;
  if (at > 0 && /[\w-]/.test(text[at - 1] as string)) return null;
  return { at, query: match[1] ?? "" };
}

/** How the candidates order themselves against what was typed. */
export function rankMembers(
  members: {
    user: { login: string; display_name: string; kind?: string };
  }[],
  query: string,
) {
  const lower = query.toLowerCase();
  return [...members]
    .filter(
      (m) =>
        m.user.login.startsWith(lower) ||
        m.user.display_name.toLowerCase().includes(lower),
    )
    .sort((a, b) => {
      const aPrefix = a.user.login.startsWith(lower) ? 0 : 1;
      const bPrefix = b.user.login.startsWith(lower) ? 0 : 1;
      return aPrefix - bPrefix || a.user.login.localeCompare(b.user.login);
    });
}

/**
 * A CompletionSource reading the member list through the query cache — the
 * same cache the settings page and the assignee picker warm, so this is
 * usually a read, not a request.
 */
export function mentionCompletionSource(
  slug: string,
  queryClient: QueryClient,
): CompletionSource {
  return async (
    context: CompletionContext,
  ): Promise<CompletionResult | null> => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    // PERF: this reject has to stay ahead of every await — prose pays this
    // visit on every keystroke, and an `@` is one comparison away.
    if (!before.includes("@")) return null;
    const trigger = mentionTriggerAt(before);
    if (trigger === null) return null;
    if (inCodeContext(syntaxTree(context.state), context.pos)) return null;

    const members = await queryClient
      .fetchQuery(membersQuery(slug))
      .catch(() => null);
    const options = rankMembers(members ?? [], trigger.query)
      .slice(0, MAX_OPTIONS)
      .map(
        (m): Completion => ({
          label: `@${m.user.login}`,
          detail: m.user.display_name,
          // The panel's icon separates people from agents at a glance.
          type: m.user.kind === "machine" ? "mention-agent" : "mention-user",
          apply: applyWithSpace(`@${m.user.login}`),
        }),
      );
    if (options.length === 0) return null;
    return { from: line.from + trigger.at, filter: false, options };
  };
}
