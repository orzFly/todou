import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { QueryClient } from "@tanstack/react-query";
import type {
  IssueListItem,
  IssueListPage,
  PrefixDirectory,
  Project,
  ReferenceConfig,
  ReferenceDirectory,
} from "@todou/shared";
import { describe, expect, it } from "vitest";
import { issueRefQuery, type ResolvedIssueRef } from "../src/api/issue-refs.ts";
import {
  issueCompletionQuery,
  issueCompletionSearchQuery,
} from "../src/api/issues.ts";
import { projectsQuery } from "../src/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import {
  inCodeContext,
  projectTriggerAt,
  type RefTriggerContext,
  rankCandidates,
  refCompletionSource,
  refTriggerAt,
} from "../src/lib/editor/ref-completion.ts";

const DIRECTORY: PrefixDirectory = {
  entries: [
    { prefix: "M", slug: "mirror", from: "2020-01-01T00:00:00.000Z", to: null },
    { prefix: "X", slug: "hidden", from: "2020-01-01T00:00:00.000Z", to: null },
    { prefix: "C", slug: "one", from: "2020-01-01T00:00:00.000Z", to: null },
    { prefix: "C", slug: "two", from: "2020-01-01T00:00:00.000Z", to: null },
    // A prefix long enough to still be a prefix at three characters, which
    // is where the project panel starts offering.
    {
      prefix: "ACC",
      slug: "accel",
      from: "2020-01-01T00:00:00.000Z",
      to: null,
    },
  ],
  contested: [{ prefix: "C", from: "2020-01-01T00:00:00.000Z", to: null }],
};

const base: RefTriggerContext = {
  slug: "todou",
  prefix: null,
  readableSlugs: ["todou", "mirror"],
  directory: DIRECTORY,
  autolinks: [],
};

describe("refTriggerAt (when the panel opens, and on what)", () => {
  it("opens on this project's # and searches this project", () => {
    expect(refTriggerAt("see #", base)).toEqual({
      slug: "todou",
      anchor: "#",
      at: 4,
      query: "",
    });
    expect(refTriggerAt("see #12", base)?.query).toBe("12");
  });

  it("opens on this project's prefix when the format is PREFIX-N", () => {
    const prefixed = { ...base, prefix: "T" };
    expect(refTriggerAt("fixed by T-1", prefixed)).toEqual({
      slug: "todou",
      anchor: "T-",
      at: 9,
      query: "1",
    });
    // With T-N in force a bare # is not a reference at all.
    expect(refTriggerAt("see #12", prefixed)).toBeNull();
  });

  it("stays shut once a space follows, so # headings are undisturbed", () => {
    expect(refTriggerAt("# ", base)).toBeNull();
    expect(refTriggerAt("# Heading", base)).toBeNull();
  });

  it("wants a boundary before the token", () => {
    expect(refTriggerAt("channel#4", base)).toBeNull();
    expect(refTriggerAt("SOME-T-7", { ...base, prefix: "T" })).toBeNull();
  });

  it("opens on a qualified form for a project the viewer can read", () => {
    expect(refTriggerAt("mirror#1", base)).toEqual({
      slug: "mirror",
      anchor: "mirror#",
      at: 0,
      query: "1",
    });
    expect(refTriggerAt("see mirror/", base)).toEqual({
      slug: "mirror",
      anchor: "mirror/",
      at: 4,
      query: "",
    });
    expect(refTriggerAt("see mirror/#2", base)?.anchor).toBe("mirror/#");
  });

  it("stays shut for a project the viewer cannot read", () => {
    // And does not fall through to this project's own #N either: the
    // grammar consumes the whole shape as literal text.
    expect(refTriggerAt("hidden#1", base)).toBeNull();
  });

  it("opens on a bare prefix with exactly one holder", () => {
    expect(refTriggerAt("also M-3", base)).toEqual({
      slug: "mirror",
      anchor: "M-",
      at: 5,
      query: "3",
    });
  });

  it("stays shut on a contested or unclaimed bare prefix", () => {
    expect(refTriggerAt("also C-3", base)).toBeNull();
    expect(refTriggerAt("also ZZ-3", base)).toBeNull();
  });

  it("stays shut on foreign spellings when the directory is closed", () => {
    const closed = { ...base, directory: null };
    expect(refTriggerAt("mirror#1", closed)).toBeNull();
    expect(refTriggerAt("M-3", closed)).toBeNull();
    // This project's own format still completes.
    expect(refTriggerAt("#1", closed)?.slug).toBe("todou");
  });

  it("does not care which case any of it was typed in", () => {
    expect(refTriggerAt("see Mirror#1", base)).toEqual({
      slug: "mirror",
      anchor: "mirror#",
      at: 4,
      query: "1",
    });
    expect(refTriggerAt("see MIRROR/", base)?.anchor).toBe("mirror/");
    expect(refTriggerAt("also m-3", base)).toEqual({
      slug: "mirror",
      anchor: "M-",
      at: 5,
      query: "3",
    });
    expect(refTriggerAt("fixed by t-1", { ...base, prefix: "T" })?.anchor).toBe(
      "T-",
    );
  });

  it("keeps every other rule exactly as strict, whatever the case", () => {
    expect(refTriggerAt("Hidden#1", base)).toBeNull();
    expect(refTriggerAt("SOME-t-7", { ...base, prefix: "T" })).toBeNull();
    expect(refTriggerAt("also c-3", base)).toBeNull();
  });

  it("yields to an autolink rule holding the prefix", () => {
    const linked = {
      ...base,
      autolinks: [{ prefix: "M-", url_template: "https://x/<num>" }],
    };
    expect(refTriggerAt("M-3", linked)).toBeNull();
  });
});

describe("projectTriggerAt (the bare word a project name grows out of)", () => {
  it("takes the word the cursor sits at the end of", () => {
    expect(projectTriggerAt("see mir")).toEqual({ at: 4, typed: "mir" });
  });

  it("counts the start of the line as a boundary", () => {
    expect(projectTriggerAt("channel")).toEqual({ at: 0, typed: "channel" });
  });

  it("reads a hyphenated run as one word", () => {
    // `my-pro` has to be able to reach `my-project/`, so the run cannot stop
    // at the hyphen — and the `mir` in `x-mir` is therefore never a word of
    // its own to offer against.
    expect(projectTriggerAt("x-mir")).toEqual({ at: 0, typed: "x-mir" });
  });

  it("has nothing to offer once the word is finished", () => {
    expect(projectTriggerAt("see mir ")).toBeNull();
    expect(projectTriggerAt("写一句中文")).toBeNull();
  });
});

describe("inCodeContext", () => {
  const treeOf = (chain: string[]) => ({
    resolveInner: () => {
      let node: { name: string; parent: null | typeof node } = {
        name: chain[0] as string,
        parent: null,
      };
      for (const name of chain.slice(1)) node = { name, parent: node };
      return node;
    },
  });

  it("finds code anywhere up the ancestor chain", () => {
    expect(
      inCodeContext(treeOf(["Document", "FencedCode", "CodeText"]), 0),
    ).toBe(true);
    expect(
      inCodeContext(treeOf(["Document", "Paragraph", "InlineCode"]), 0),
    ).toBe(true);
  });

  it("lets ordinary prose through", () => {
    expect(inCodeContext(treeOf(["Document", "Paragraph"]), 0)).toBe(false);
  });
});

const item = (
  number: number,
  title: string,
  category: "open" | "closed" = "open",
): IssueListItem => ({
  number,
  id: number,
  title,
  status: {
    id: 1,
    name: category === "open" ? "Todo" : "Done",
    category,
    color: "#000000",
    position: 0,
    is_default: true,
  },
  author: {
    id: 1,
    login: "alice",
    display_name: "Alice",
    kind: "human",
    avatar_url: null,
    owner: null,
  },
  assignees: [],
  labels: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  body_edited_at: null,
  open_questions: 0,
  spec_version: null,
  spec_review_status: null,
  spec_unresolved_comments: 0,
  deleted_at: null,
  deleted_by: null,
  unread: false,
  unread_comments: 0,
  moves: [],
});

describe("rankCandidates", () => {
  const items = [item(100, "hundred"), item(1, "one"), item(12, "twelve")];

  it("puts the exact number first, then prefixes smallest first", () => {
    expect(rankCandidates(items, "1").map((i) => i.number)).toEqual([
      1, 12, 100,
    ]);
    expect(rankCandidates(items, "12").map((i) => i.number)).toEqual([12]);
  });

  it("matches titles case-insensitively for word queries", () => {
    expect(rankCandidates(items, "TWEL").map((i) => i.number)).toEqual([12]);
  });

  it("keeps the recency order when nothing was typed", () => {
    expect(rankCandidates(items, "").map((i) => i.number)).toEqual([
      100, 1, 12,
    ]);
  });
});

function seededClient(options?: {
  prefix?: string | null;
  projects?: string[];
  pages?: Record<string, IssueListItem[]>;
}): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const config: ReferenceConfig = {
    format: { prefix: options?.prefix ?? null, history: [] },
    autolinks: [],
  };
  const directory: ReferenceDirectory = {
    entries: [...DIRECTORY.entries],
    contested: [...DIRECTORY.contested],
  };
  const readable = options?.projects ?? ["todou", "mirror", "accel"];
  for (const slug of readable) {
    client.setQueryData(referenceConfigQuery(slug).queryKey, config);
  }
  client.setQueryData(referenceDirectoryQuery.queryKey, directory);
  client.setQueryData(
    projectsQuery.queryKey,
    readable.map(
      (slug): Project => ({
        id: 1,
        slug,
        name: `The ${slug} project`,
        description: "",
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    ),
  );
  for (const [slug, items] of Object.entries(options?.pages ?? {})) {
    client.setQueryData(issueCompletionQuery(slug).queryKey, {
      items,
      next_cursor: null,
    } satisfies IssueListPage);
  }
  return client;
}

const completeAt = (
  client: QueryClient,
  slug: string,
  doc: string,
  pos = doc.length,
) =>
  refCompletionSource(
    slug,
    client,
  )(new CompletionContext(EditorState.create({ doc }), pos, false));

describe("refCompletionSource", () => {
  it("offers the project's issues and completes only the number", async () => {
    const client = seededClient({
      pages: { todou: [item(7, "Seventh potato"), item(70, "Seventieth")] },
    });
    const result = await completeAt(client, "todou", "fixed by #7");
    expect(result?.from).toBe("fixed by ".length);
    expect(result?.options.map((o) => o.label)).toEqual(["#7", "#70"]);
    expect(result?.options[0]?.apply).toBe("#7");
    expect(result?.options[0]?.detail).toBe("Seventh potato");
  });

  it("keeps the spelling the typist chose", async () => {
    const client = seededClient({ pages: { mirror: [item(7, "Theirs")] } });
    const qualified = await completeAt(client, "todou", "see mirror#7");
    expect(qualified?.options[0]?.apply).toBe("mirror#7");
    const bare = await completeAt(client, "todou", "see M-7");
    expect(bare?.options[0]?.apply).toBe("M-7");
  });

  it("inserts the canonical spelling however the anchor was typed", async () => {
    const client = seededClient({ pages: { mirror: [item(7, "Theirs")] } });
    const result = await completeAt(client, "todou", "see Mirror#7");
    expect(result?.options[0]?.apply).toBe("mirror#7");
  });

  it("spells this project's own refs in its current format", async () => {
    const client = seededClient({
      prefix: "T",
      pages: { todou: [item(9, "Ninth")] },
    });
    const result = await completeAt(client, "todou", "fixed by T-9");
    expect(result?.options[0]?.apply).toBe("T-9");
  });

  it("marks closed candidates apart from open ones", async () => {
    const client = seededClient({
      pages: { todou: [item(1, "Open one"), item(2, "Shut one", "closed")] },
    });
    const result = await completeAt(client, "todou", "#");
    expect(result?.options.map((o) => o.type)).toEqual([
      "issue-open",
      "issue-closed",
    ]);
  });

  it("never offers a project the viewer cannot read", async () => {
    const client = seededClient({
      projects: ["todou"],
      pages: { hidden: [item(1, "Secret")] },
    });
    expect(await completeAt(client, "todou", "see hidden#1")).toBeNull();
  });

  it("stays quiet on a line with nothing to complete", async () => {
    const client = seededClient({ pages: { todou: [item(1, "One")] } });
    expect(await completeAt(client, "todou", "plain prose")).toBeNull();
    expect(await completeAt(client, "todou", "# Heading")).toBeNull();
  });

  it("finds an exact number past the recent window", async () => {
    const client = seededClient({ pages: { todou: [item(1, "One")] } });
    client.setQueryData(issueRefQuery("todou", 999).queryKey, item(999, "Old"));
    const result = await completeAt(client, "todou", "#999");
    expect(result?.options.map((o) => o.label)).toEqual(["#999"]);
  });

  it("completes a moved card at the number that was typed", async () => {
    const client = seededClient({
      pages: { todou: [item(1, "One")], mirror: [] },
    });
    const moved: ResolvedIssueRef = {
      ...item(45, "Landed in harbor"),
      at: { slug: "harbor", number: 45 },
    };
    client.setQueryData(issueRefQuery("mirror", 3).queryKey, moved);
    const result = await completeAt(client, "todou", "see mirror#3");
    // `mirror#45` is a different card, or none. The written form resolves to
    // the moved card when it is stored, so the typed number is the right one
    // to hand back (T-274).
    expect(result?.options[0]?.apply).toBe("mirror#3");
    expect(result?.options[0]?.detail).toBe("Landed in harbor");
  });

  it("falls back to a server search for a word query", async () => {
    const client = seededClient({ pages: { todou: [item(1, "One")] } });
    client.setQueryData(
      issueCompletionSearchQuery("todou", "potato").queryKey,
      {
        items: [item(42, "A potato")],
        next_cursor: null,
      } satisfies IssueListPage,
    );
    const result = await completeAt(client, "todou", "#potato");
    expect(result?.options.map((o) => o.label)).toEqual(["#42"]);
  });

  it("yields nothing rather than an empty panel", async () => {
    const client = seededClient({ pages: { todou: [item(1, "One")] } });
    expect(await completeAt(client, "todou", "#87")).toBeNull();
  });

  const labelsAt = async (client: QueryClient, doc: string) =>
    (await completeAt(client, "todou", doc))?.options.map((o) => o.label);

  describe("the project level", () => {
    it("offers a project against a word that names no shape yet", async () => {
      const client = seededClient();
      const result = await completeAt(client, "todou", "see mir");
      expect(result?.from).toBe("see ".length);
      // `M-` is not a prefix of `mir`, so it is the slug form's turn.
      expect(result?.options.map((o) => o.label)).toEqual(["mirror/"]);
      expect(result?.options[0]?.detail).toBe("The mirror project");
    });

    it("offers the prefix form until it stops being a prefix", async () => {
      const client = seededClient();
      expect(await labelsAt(client, "see acc")).toEqual(["ACC-"]);
      expect(await labelsAt(client, "see acce")).toEqual(["accel/"]);
    });

    it("does not care which case the word was typed in", async () => {
      const client = seededClient();
      expect(await labelsAt(client, "see ACC")).toEqual(["ACC-"]);
      expect(await labelsAt(client, "see MIR")).toEqual(["mirror/"]);
    });

    it("stays shut below three characters", async () => {
      const client = seededClient();
      expect(await completeAt(client, "todou", "see m")).toBeNull();
      expect(await completeAt(client, "todou", "see mi")).toBeNull();
    });

    it("leaves the field to the cards once a shape has matched", async () => {
      const client = seededClient({ pages: { mirror: [item(7, "Theirs")] } });
      expect(await labelsAt(client, "see mirror/")).toEqual(["mirror/7"]);
    });

    it("never offers a project the viewer cannot read", async () => {
      const client = seededClient({ projects: ["todou"] });
      expect(await completeAt(client, "todou", "see mir")).toBeNull();
      expect(await completeAt(client, "todou", "see acc")).toBeNull();
    });

    it("offers nothing against a word after a hyphen", async () => {
      const client = seededClient();
      expect(await completeAt(client, "todou", "see about-mir")).toBeNull();
    });
  });
});
