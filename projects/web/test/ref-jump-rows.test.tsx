import type { QueryClient } from "@tanstack/react-query";
import type {
  CommentLocation,
  IssueListItem,
  Project,
  ReferenceConfig,
  ReferenceDirectory,
  TimelineComment,
} from "@todou/shared";
import { describe, expect, it } from "vitest";
import {
  commentLocationQuery,
  commentRefQuery,
  issueRefQuery,
} from "../src/api/issue-refs.ts";
import { recentOpenIssuesQuery } from "../src/api/issues.ts";
import { projectsQuery } from "../src/api/queries.ts";
import {
  type JumpRow,
  PROJECT_PEEK,
  type ProjectPeekRow,
  useJumpRows,
  useProjectPeek,
} from "../src/api/ref-jump.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const author = {
  id: 1,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const item = (number: number, title: string): IssueListItem => ({
  id: number,
  number,
  title,
  status: {
    id: 1,
    name: "In Progress",
    category: "open",
    color: "#3b82f6",
    position: 1,
    is_default: false,
  },
  author,
  assignees: [],
  labels: [],
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
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

const comment = (id: number): TimelineComment => ({
  type: "comment",
  id,
  author,
  body: "hi",
  created_at: "2026-09-01T00:00:00Z",
  component: null,
  edited_at: null,
  resolved_at: null,
  agent_context: null,
});

const DIRECTORY: ReferenceDirectory = {
  entries: [
    { prefix: "M", slug: "mirror", from: "2020-01-01T00:00:00.000Z", to: null },
    // This project's own claim is in there too, as the server sends it: the
    // directory is every prefix the viewer may see, their own included.
    { prefix: "T", slug: "todou", from: "2020-01-01T00:00:00.000Z", to: null },
  ],
  contested: [],
};

const config = (
  prefix: string | null,
  over: Partial<ReferenceConfig> = {},
): ReferenceConfig => ({
  format: { prefix, history: [] },
  autolinks: [],
  ...over,
});

function seedContext(
  client: QueryClient,
  over: Partial<ReferenceConfig> = {},
): QueryClient {
  client.setQueryData(referenceConfigQuery("todou").queryKey, {
    ...config("T"),
    ...over,
  });
  client.setQueryData(referenceConfigQuery("mirror").queryKey, config("M"));
  client.setQueryData(referenceDirectoryQuery.queryKey, DIRECTORY);
  client.setQueryData(
    projectsQuery.queryKey,
    ["todou", "mirror"].map(
      (slug): Project => ({
        id: 1,
        slug,
        name: slug,
        description: "",
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    ),
  );
  return client;
}

/** The hook's output verbatim, so a test reads what the box will read. */
function Probe({ q }: { q: string }) {
  return (
    <pre data-testid="rows">{JSON.stringify(useJumpRows("todou", q))}</pre>
  );
}

async function rowsOf(client: QueryClient, q: string): Promise<JumpRow[]> {
  const { findByTestId } = renderWithProviders(<Probe q={q} />, client);
  const pre = await findByTestId("rows");
  return JSON.parse(pre.textContent ?? "[]") as JumpRow[];
}

/** The home row the peek hangs under: which project, and how it was named. */
type Named = { slug: string; spelled: string } | null;

function PeekProbe({ named }: { named: Named }) {
  return <pre data-testid="peek">{JSON.stringify(useProjectPeek(named))}</pre>;
}

async function peekOf(
  client: QueryClient,
  named: Named,
): Promise<ProjectPeekRow[]> {
  const { findByTestId } = renderWithProviders(
    <PeekProbe named={named} />,
    client,
  );
  const pre = await findByTestId("peek");
  return JSON.parse(pre.textContent ?? "[]") as ProjectPeekRow[];
}

function seedPeek(client: QueryClient, slug: string, count: number) {
  client.setQueryData(recentOpenIssuesQuery(slug, PROJECT_PEEK).queryKey, {
    items: Array.from({ length: count }, (_, i) => item(i + 1, `卡 ${i + 1}`)),
    next_cursor: null,
  });
  return client;
}

describe("useJumpRows", () => {
  it("spells this project's own card in its own format", async () => {
    const client = seedContext(testQueryClient());
    client.setQueryData(
      issueRefQuery("todou", 215).queryKey,
      item(215, "搜索框：粘入类 ref 的跳转提示"),
    );
    const rows = await rowsOf(client, "T-215");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "issue",
      state: "ready",
      slug: "todou",
      number: 215,
      spelled: "T-215",
      crossProject: false,
      commentBy: null,
    });
    expect(rows[0]).toMatchObject({
      item: { title: "搜索框：粘入类 ref 的跳转提示" },
    });
  });

  it("spells another project's card so it cannot read as one of ours", async () => {
    const client = seedContext(testQueryClient());
    client.setQueryData(issueRefQuery("mirror", 3).queryKey, item(3, "Theirs"));
    const rows = await rowsOf(client, "M-3");
    expect(rows[0]).toMatchObject({
      state: "ready",
      slug: "mirror",
      number: 3,
      spelled: "mirror/M-3",
      crossProject: true,
    });
  });

  it("offers nothing when the card is not there", async () => {
    const client = seedContext(testQueryClient());
    client.setQueryData(issueRefQuery("todou", 215).queryKey, null);
    expect(await rowsOf(client, "T-215")).toEqual([]);
  });

  it("holds the row open while the lookup is in flight", async () => {
    const client = seedContext(testQueryClient());
    // Left unresolved on purpose: the row must not decide anything before
    // the answer arrives, because Enter decides with it.
    void client.prefetchQuery({
      ...issueRefQuery("todou", 215),
      queryFn: () => new Promise<IssueListItem | null>(() => {}),
    });
    const rows = await rowsOf(client, "T-215");
    expect(rows).toEqual([
      {
        kind: "issue",
        state: "pending",
        candidate: { kind: "issue", slug: "todou", number: 215 },
      },
    ]);
  });

  it("refuses a qualified prefix the named project never wrote", async () => {
    const client = seedContext(testQueryClient());
    client.setQueryData(
      issueRefQuery("todou", 215).queryKey,
      item(215, "Ours"),
    );
    expect(await rowsOf(client, "todou/X-215")).toEqual([]);
  });

  it("accepts a qualified prefix the named project used to write", async () => {
    // Pasting a ref out of an old commit message is the reason this form
    // gets typed at all (T-214).
    const client = seedContext(testQueryClient(), {
      format: {
        prefix: "T",
        history: [{ prefix: "X", effective_from: "2020-01-01T00:00:00.000Z" }],
      },
    });
    client.setQueryData(
      issueRefQuery("todou", 215).queryKey,
      item(215, "Ours"),
    );
    expect(await rowsOf(client, "todou/X-215")).toMatchObject([
      { state: "ready", number: 215, spelled: "T-215" },
    ]);
  });

  it("follows a bare comment anchor to the card carrying it", async () => {
    const client = seedContext(testQueryClient());
    const located: CommentLocation = {
      issue_number: 141,
      issue_ref: "T-141",
      comment: comment(1837),
    };
    client.setQueryData(commentLocationQuery("todou", 1837).queryKey, located);
    client.setQueryData(
      issueRefQuery("todou", 141).queryKey,
      item(141, "搜索"),
    );
    client.setQueryData(
      commentRefQuery("todou", 141, 1837).queryKey,
      comment(1837),
    );
    expect(await rowsOf(client, "#comment-1837")).toMatchObject([
      {
        state: "ready",
        number: 141,
        commentId: 1837,
        spelled: "T-141",
        commentBy: "Alice",
      },
    ]);
  });

  it("offers a project's home for a query that names one and stops", async () => {
    // Nothing is seeded beyond the context every other case seeds: the row
    // reads the project list the box has already fetched, so anything that
    // needed a lookup would be stuck pending here instead of ready.
    const client = seedContext(testQueryClient());
    expect(await rowsOf(client, "M-")).toEqual([
      { kind: "project", slug: "mirror", spelled: "M-", name: "mirror" },
    ]);
  });

  it("offers the project's home spelled the way the project spells it", async () => {
    const client = seedContext(testQueryClient());
    expect(await rowsOf(client, "MIRROR/")).toMatchObject([
      { kind: "project", spelled: "mirror/" },
    ]);
  });

  it("offers nothing for a project the viewer cannot read", async () => {
    const client = seedContext(testQueryClient());
    expect(await rowsOf(client, "hidden/")).toEqual([]);
  });

  it("offers no project home while the directory is unreadable", async () => {
    const client = seedContext(testQueryClient());
    client.setQueryData(referenceDirectoryQuery.queryKey, null);
    expect(await rowsOf(client, "mirror/")).toEqual([]);
  });

  it("peeks at what a named project is working on, spelled to be typed back", async () => {
    const client = seedPeek(seedContext(testQueryClient()), "mirror", 2);
    const rows = await peekOf(client, { slug: "mirror", spelled: "mirror/" });
    expect(rows).toHaveLength(2);
    // The home row's spelling carried on, so the number is the only thing
    // left to type and the row does not repeat the name above it.
    expect(rows[0]).toMatchObject({
      kind: "project-issue",
      slug: "mirror",
      number: 1,
      spelled: "mirror/1",
    });
  });

  // One `it` per spelling rather than a loop inside one: the probes render
  // into the same document, and only the boundary between tests clears it.
  for (const [spelled, expected] of [
    ["M-", "M-1"],
    ["mirror/", "mirror/1"],
    ["mirror#", "mirror#1"],
    ["mirror/#", "mirror/#1"],
  ] as const) {
    it(`carries ${spelled} on into ${expected}`, async () => {
      const client = seedPeek(seedContext(testQueryClient()), "mirror", 1);
      expect(await peekOf(client, { slug: "mirror", spelled })).toMatchObject([
        { spelled: expected },
      ]);
    });
  }

  it("spells this project's own cards the same way", async () => {
    const client = seedPeek(seedContext(testQueryClient()), "todou", 1);
    expect(
      await peekOf(client, { slug: "todou", spelled: "T-" }),
    ).toMatchObject([{ spelled: "T-1" }]);
  });

  it("asks nothing, and shows nothing, without a project to peek at", async () => {
    const client = seedPeek(seedContext(testQueryClient()), "mirror", 2);
    expect(await peekOf(client, null)).toEqual([]);
  });

  it("names the host of an external link, and asks nobody about it", async () => {
    const client = seedContext(testQueryClient(), {
      autolinks: [
        {
          id: 1,
          prefix: "GH-",
          url_template: "https://github.com/o/r/issues/<num>",
        },
      ],
    });
    expect(await rowsOf(client, "GH-76")).toEqual([
      {
        kind: "external",
        href: "https://github.com/o/r/issues/76",
        text: "GH-76",
        host: "github.com",
      },
    ]);
  });
});
