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
import { projectsQuery } from "../src/api/queries.ts";
import { type JumpRow, useJumpRows } from "../src/api/ref-jump.ts";
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
  since: "2020-01-01T00:00:00.000Z",
  entries: [
    { prefix: "M", slug: "mirror", from: "2020-01-01T00:00:00.000Z", to: null },
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
