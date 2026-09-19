import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { QueryClient } from "@tanstack/react-query";
import type { Member } from "@todou/shared";
import { describe, expect, it, vi } from "vitest";
import { membersQuery } from "../src/api/queries.ts";
import {
  mentionCompletionSource,
  mentionTriggerAt,
  rankMembers,
} from "../src/lib/editor/mention-completion.ts";
import { acceptInto } from "./cm.ts";

const syntaxTreeMock = vi.hoisted(() => vi.fn());
// Only `syntaxTree` is faked: a bare doc carries no language, so the real
// one answers an empty tree and `inCodeContext` could never say true. The
// rest of the module stays genuine, so an import added later still works.
vi.mock("@codemirror/language", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@codemirror/language")>()),
  syntaxTree: syntaxTreeMock,
}));

const member = (
  id: number,
  login: string,
  display: string,
  kind: "human" | "machine" = "human",
): Member => ({
  user: {
    id,
    login,
    display_name: display,
    kind,
    avatar_url: null,
    owner: null,
  },
  role: "writer",
  created_at: "2026-01-01T00:00:00Z",
  owner_role: null,
});

const PEOPLE: Member[] = [
  member(1, "alice", "Alice Potato"),
  member(2, "alicia", "Alicia Recent"),
  member(3, "bot-one", "Albert the Bot", "machine"),
];

describe("mentionTriggerAt", () => {
  it("finds a bare @ and a typed prefix", () => {
    expect(mentionTriggerAt("hi @")).toEqual({ at: 3, query: "" });
    expect(mentionTriggerAt("hi @al")).toEqual({ at: 3, query: "al" });
    expect(mentionTriggerAt("@alice")).toEqual({ at: 0, query: "alice" });
  });

  it("rejects an @ glued to a word or hyphen", () => {
    expect(mentionTriggerAt("mail me noreply@ex")).toBeNull();
    expect(mentionTriggerAt("see x@al")).toBeNull();
    expect(mentionTriggerAt("see -@al")).toBeNull();
  });

  it("rejects prose with no @ at all", () => {
    expect(mentionTriggerAt("plain prose")).toBeNull();
  });
});

describe("rankMembers", () => {
  it("login prefix first, then display-name contains", () => {
    const ranked = rankMembers(PEOPLE, "al");
    expect(ranked.map((m) => m.user.login)).toEqual([
      "alice",
      "alicia",
      "bot-one",
    ]);
  });

  it("an empty query keeps everyone, in login order", () => {
    expect(rankMembers(PEOPLE, "").map((m) => m.user.login)).toEqual([
      "alice",
      "alicia",
      "bot-one",
    ]);
  });
});

function seededClient(known: Member[] = PEOPLE): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(membersQuery("a").queryKey, known);
  return client;
}

const completeAt = (client: QueryClient, doc: string, pos = doc.length) =>
  mentionCompletionSource(
    "a",
    client,
  )(new CompletionContext(EditorState.create({ doc }), pos, false));

/** syntaxTree's answers: prose by default, code when asked for it. */
const proseTree = { resolveInner: () => ({ name: "Paragraph", parent: null }) };
const codeTree = {
  resolveInner: () => ({
    name: "FencedCode",
    parent: { name: "Document", parent: null },
  }),
};
syntaxTreeMock.mockReturnValue(proseTree);

/** A doc whose syntaxTree resolves into code — the source must reject. */
const completeInCode = (client: QueryClient, doc: string) => {
  syntaxTreeMock.mockReturnValueOnce(codeTree);
  return mentionCompletionSource(
    "a",
    client,
  )(new CompletionContext(EditorState.create({ doc }), doc.length, false));
};

describe("mentionCompletionSource", () => {
  it("offers matching members with @login labels", async () => {
    const result = await completeAt(seededClient(), "ping @al");
    expect(result?.from).toBe("ping ".length);
    expect(result?.options.map((o) => o.label)).toEqual([
      "@alice",
      "@alicia",
      "@bot-one",
    ]);
    const option = result?.options[0];
    expect(option).toBeDefined();
    expect(
      acceptInto(option as NonNullable<typeof option>, "ping @al", 5, 8),
    ).toBe("ping @alice ");
    expect(
      acceptInto(option as NonNullable<typeof option>, "ping @al bob", 5, 8),
    ).toBe("ping @alice bob");
    expect(result?.options[0]?.detail).toBe("Alice Potato");
  });

  it("offers every member right after the @", async () => {
    const result = await completeAt(seededClient(), "ping @");
    expect(result?.options).toHaveLength(3);
  });

  it("separates agents from people by option type", async () => {
    const result = await completeAt(seededClient(), "ping @");
    const bot = result?.options.find((o) => o.label === "@bot-one");
    expect(bot?.type).toBe("mention-agent");
    const human = result?.options.find((o) => o.label === "@alice");
    expect(human?.type).toBe("mention-user");
  });

  it.each(["future_user_kind", "constructor", "__proto__"])(
    "keeps unknown user kind %s neutral and mentionable",
    async (kind) => {
      const candidate = member(4, "newcomer", "Newcomer");
      candidate.user.kind = kind as typeof candidate.user.kind;
      const result = await completeAt(seededClient([candidate]), "@");
      const option = result?.options[0];
      expect(option?.type).toBe("mention-unknown");
      expect(option?.detail).toBe("Newcomer");
      expect(acceptInto(option!, "@", 0, 1)).toBe("@newcomer ");
    },
  );

  it.each([undefined, null, "", 42])(
    "rejects a missing or malformed user kind %j",
    async (kind) => {
      const candidate = member(4, "newcomer", "Newcomer");
      candidate.user.kind = kind as typeof candidate.user.kind;
      await expect(completeAt(seededClient([candidate]), "@")).rejects.toThrow(
        TypeError,
      );
    },
  );

  it("stays shut without an @, and on npm scopes and emails", async () => {
    const client = seededClient();
    expect(await completeAt(client, "plain prose")).toBeNull();
    expect(await completeAt(client, "see @todou/")).toBeNull();
    expect(await completeAt(client, "see noreply@ex")).toBeNull();
  });

  it("yields nothing rather than an empty panel", async () => {
    expect(await completeAt(seededClient(), "ping @zz")).toBeNull();
  });

  it("stays shut when the caret is in code", async () => {
    expect(await completeInCode(seededClient(), "ping @al")).toBeNull();
  });

  it("reads no cache at all when there is no @", async () => {
    // Falsified by hoisting the `fetchQuery` above the guards — NOT by
    // deleting the `includes("@")` line, which `mentionTriggerAt` rejects
    // the same prose one line later. Read it as "the fetch stays last".
    const client = seededClient();
    const spy = vi.spyOn(client, "fetchQuery");
    expect(await completeAt(client, "plain prose, no at sign")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
