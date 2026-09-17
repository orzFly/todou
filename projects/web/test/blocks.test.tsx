import { fireEvent, waitFor } from "@testing-library/react";
import type { BlockRef, IssueListItem, TimelineEvent } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueRefQuery } from "../src/api/issue-refs.ts";
import { api, projectQuery } from "../src/api/queries.ts";
import { BlocksSection } from "../src/components/issue/blocks-section.tsx";
import { IssueRow } from "../src/components/issue/issue-row.tsx";
import { renderEvent } from "../src/components/timeline/event-row.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

afterEach(() => vi.restoreAllMocks());

const user = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const blockRef = (over: Partial<BlockRef> = {}): BlockRef => ({
  edge_id: 5,
  project_id: 7,
  project: "p",
  number: 372,
  ref: "#372",
  hidden: false,
  cleared_at: null,
  blocker_deleted: false,
  ...over,
});

const listItem = (over: Partial<IssueListItem> = {}): IssueListItem => ({
  id: 10,
  number: 1,
  title: "issue 1",
  status: {
    id: 1,
    name: "Todo",
    category: "open",
    color: "#000000",
    position: 1,
    is_default: false,
  },
  author: user,
  assignees: [],
  labels: [],
  created_at: "2026-09-11T00:00:00Z",
  updated_at: "2026-09-11T00:00:00Z",
  body_edited_at: null,
  open_questions: 0,
  spec_version: null,
  spec_review_status: null,
  spec_unresolved_comments: 0,
  deleted_at: null,
  deleted_by: null,
  unread: false,
  unread_comments: 0,
  muted: null,
  blocked_by: [],
  blocks: [],
  moves: [],
  ...over,
});

/** A client whose `p` project answers `useCan(slug, "issue.block")`. */
function clientAs(role: "writer" | "reader") {
  const client = testQueryClient();
  client.setQueryData(projectQuery("p").queryKey, {
    id: 7,
    slug: "p",
    name: "P",
    description: "",
    created_at: "2026-09-01T00:00:00Z",
    viewer_role: role,
  });
  return client;
}

describe("BlocksSection (T-377)", () => {
  const issue = (
    over: Partial<{ blocked_by: BlockRef[]; blocks: BlockRef[] }>,
  ) => ({ number: 1, blocked_by: [], blocks: [], ...over });

  it("names an edge it can read and strikes a cleared one out", async () => {
    const client = clientAs("writer");
    client.setQueryData(issueRefQuery("p", 372).queryKey, null);
    const view = renderWithProviders(
      <BlocksSection
        slug="p"
        issue={issue({
          blocked_by: [
            blockRef(),
            blockRef({
              edge_id: 6,
              number: 373,
              ref: "#373",
              cleared_at: "2026-09-12T00:00:00Z",
            }),
          ],
        })}
        trashed={false}
      />,
      client,
    );
    const section = await view.findByTestId("blocks-blocked_by");
    expect(section.textContent).toContain("#372");
    // Cleared edges stay on the card and say so by being struck through:
    // the history is what tells a reader the wait is over.
    const cleared = section.querySelector(".line-through");
    expect(cleared?.textContent).toContain("#373");
    expect(section.querySelectorAll(".line-through")).toHaveLength(1);
  });

  it("keeps a redacted edge on the card without naming it", async () => {
    const view = renderWithProviders(
      <BlocksSection
        slug="p"
        issue={issue({
          blocked_by: [
            blockRef({
              project_id: null,
              project: null,
              number: null,
              ref: null,
              hidden: true,
            }),
          ],
        })}
        trashed={false}
      />,
      clientAs("writer"),
    );
    const section = await view.findByTestId("blocks-blocked_by");
    expect(section.textContent).toContain("a card you cannot see");
  });

  it("says the blocker is in the trash, which the ref cannot", async () => {
    const client = clientAs("writer");
    client.setQueryData(issueRefQuery("p", 372).queryKey, null);
    const view = renderWithProviders(
      <BlocksSection
        slug="p"
        issue={issue({ blocked_by: [blockRef({ blocker_deleted: true })] })}
        trashed={false}
      />,
      client,
    );
    const section = await view.findByTestId("blocks-blocked_by");
    expect(section.textContent).toContain("(in the trash)");
  });

  it("offers no editing to a reader, and none on a trashed card", async () => {
    const reader = renderWithProviders(
      <BlocksSection
        slug="p"
        issue={issue({ blocked_by: [blockRef()] })}
        trashed={false}
      />,
      clientAs("reader"),
    );
    // The heading triggers, by the names they actually carry: querying the
    // old /^Add$/ would pass here for the wrong reason — nothing answers to
    // it any more — and stop testing who may edit.
    await waitFor(() =>
      expect(reader.queryByRole("button", { name: /^Add a block/ })).toBeNull(),
    );

    const trashed = renderWithProviders(
      <BlocksSection slug="p" issue={issue({})} trashed={true} />,
      clientAs("writer"),
    );
    await waitFor(() =>
      expect(
        trashed.queryByRole("button", { name: /^Add a block/ }),
      ).toBeNull(),
    );
  });

  it("sends the ref as typed", async () => {
    const add = vi
      .spyOn(api, "addIssueBlockedBy")
      .mockResolvedValue({ blocked_by: [] });
    const view = renderWithProviders(
      <BlocksSection slug="p" issue={issue({})} trashed={false} />,
      clientAs("writer"),
    );
    const opener = await view.findByRole("button", {
      name: "Add a blocked by entry",
    });
    fireEvent.click(opener);
    const input = await view.findByPlaceholderText("#12 or other-project#12");
    fireEvent.change(input, { target: { value: "other#31" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(add).toHaveBeenCalledWith("p", 1, "other#31"));
  });
});

describe("the blocked badge", () => {
  it("counts the unresolved edges and ignores the cleared ones", async () => {
    const view = renderWithProviders(
      <IssueRow
        slug="p"
        issue={listItem({
          blocked_by: [
            blockRef(),
            blockRef({ edge_id: 6, cleared_at: "2026-09-12T00:00:00Z" }),
          ],
        })}
      />,
    );
    await view.findByText("issue 1");
    const badge = view.getByTitle("waiting for 1 other issue(s)");
    expect(badge.textContent).toContain("1");
    // Not the amber "waiting on you" pill: this card is waiting on somebody
    // else, and nothing the reader does to it now helps.
    expect(badge.className).not.toContain("amber");
  });

  it("stays away when every edge has cleared", async () => {
    const view = renderWithProviders(
      <IssueRow
        slug="p"
        issue={listItem({
          blocked_by: [blockRef({ cleared_at: "2026-09-12T00:00:00Z" })],
        })}
      />,
    );
    await view.findByText("issue 1");
    expect(view.queryByTitle(/waiting for/)).toBeNull();
  });
});

describe("block timeline rows", () => {
  const ctx = {
    slug: "p",
    issueNumber: 1,
    refConfig: { internalPrefix: null, autolinks: [] },
    slugEntries: [],
    slugOfProject: (id: number) => (id === 7 ? "p" : undefined),
    entities: {
      statusById: new Map(),
      labelById: new Map(),
      memberById: new Map(),
    },
  } as unknown as Parameters<typeof renderEvent>[1];

  const event = (
    event_type: TimelineEvent["event_type"],
    payload: Record<string, unknown>,
  ): TimelineEvent => ({
    type: "event",
    id: 1,
    event_type,
    actor: user,
    payload,
    created_at: "2026-09-12T00:00:00Z",
    agent_context: null,
  });

  it("tells the two ends of one edge apart by role", () => {
    expect(
      renderEvent(
        event("block_added", {
          edge_id: 1,
          role: "blocked",
          other_project_id: 7,
          other_number: 372,
        }),
        ctx,
      ).text,
    ).toBe("marked this blocked by p#372");
    expect(
      renderEvent(
        event("block_added", {
          edge_id: 1,
          role: "blocker",
          other_project_id: 7,
          other_number: 372,
        }),
        ctx,
      ).text,
    ).toBe("marked this a blocker of p#372");
  });

  it("renders the clearing and the re-block", () => {
    expect(
      renderEvent(
        event("block_cleared", {
          edge_id: 1,
          blocker_project_id: 7,
          blocker_number: 372,
        }),
        ctx,
      ).text,
    ).toBe("cleared the block by p#372");
    expect(
      renderEvent(
        event("block_reblocked", {
          edge_id: 1,
          blocker_project_id: 7,
          blocker_number: 372,
        }),
        ctx,
      ).text,
    ).toBe("re-applied the block by p#372");
  });

  it("keeps a redacted row and names nobody", () => {
    expect(
      renderEvent(
        event("block_cleared", {
          edge_id: 1,
          blocker_project_id: null,
          blocker_number: null,
        }),
        ctx,
      ).text,
    ).toBe("cleared the block by a card you cannot see");
  });
});
