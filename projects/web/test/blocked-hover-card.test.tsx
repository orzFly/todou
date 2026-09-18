import { act, fireEvent, waitFor, within } from "@testing-library/react";
import type { BlockRef, IssueListItem, MePrefs } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prefsQuery } from "../src/api/prefs.ts";
import { api } from "../src/api/queries.ts";
import { referenceConfigQuery } from "../src/api/references.ts";
import { BlockedBadge } from "../src/components/issue/attention-badge.tsx";
import { IssueRow } from "../src/components/issue/issue-row.tsx";
import { HoverDepth } from "../src/components/shared/hover-preview.ts";
import { BoardCardContent } from "../src/pages/board.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

afterEach(() => vi.restoreAllMocks());

const block = (
  number: number,
  overrides: Partial<BlockRef> = {},
): BlockRef => ({
  edge_id: number,
  project_id: 1,
  project: "todou",
  number,
  ref: `T-${number}`,
  hidden: false,
  cleared_at: null,
  blocker_deleted: false,
  ...overrides,
});

const item = (number: number, title: string): IssueListItem => ({
  id: number,
  number,
  title,
  status: {
    id: 1,
    name: "Next",
    category: "open",
    color: "#6b7280",
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
  created_at: "2026-09-18T00:00:00Z",
  updated_at: "2026-09-18T00:00:00Z",
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
});

// Deliberately different order, project and direction: a count alone cannot
// tell whether the preview is naming the cards that actually hold this up.
const issue: IssueListItem = {
  ...item(1, "Owner"),
  blocked_by: [
    block(8),
    block(7),
    block(9, { project: "other", project_id: 2, ref: "OTHER-9" }),
    block(10, { cleared_at: "2026-09-17T00:00:00Z" }),
  ],
  blocks: [block(11)],
};
const titles = new Map([
  [7, "First prerequisite"],
  [8, "Second prerequisite"],
  [9, "Cross-project prerequisite"],
  [10, "Already cleared"],
  [11, "Downstream card"],
]);

function setup(placement: MePrefs["ref_placement_board"] = "own_line") {
  const client = testQueryClient();
  client.setQueryData(prefsQuery.queryKey, {
    show_weak_unread: true,
    ref_placement_list: "before",
    ref_placement_board: placement,
    ref_placement_detail: "before",
    ref_placement_reference: "before",
    boxed_ref_links: true,
    truncate_ref_title: true,
    show_repeated_ref_title: false,
  } satisfies MePrefs);
  for (const slug of ["todou", "other"]) {
    client.setQueryData(referenceConfigQuery(slug).queryKey, {
      format: { prefix: slug === "todou" ? "T" : "OTHER", history: [] },
      autolinks: [],
    });
  }
  const reads = vi
    .spyOn(api, "listIssues")
    .mockImplementation(async (_slug, params) => ({
      // Response order must not accidentally provide the relationship order.
      items: (Array.isArray(params?.numbers) ? params.numbers.map(Number) : [])
        .sort((a, b) => a - b)
        .map((number) => item(number, titles.get(number) ?? "Unexpected card")),
      next_cursor: null,
    }));
  const details = vi.spyOn(api, "getIssue");
  return { client, reads, details };
}

const hover = (el: Element, pointerType = "mouse") =>
  fireEvent.pointerOver(el, { pointerType, bubbles: true });
const unhover = (el: Element, relatedTarget: EventTarget = document.body) =>
  fireEvent.pointerOut(el, {
    pointerType: "mouse",
    bubbles: true,
    relatedTarget,
  });
const pause = (ms = 600) =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const cards = () =>
  document.querySelectorAll("[data-slot='hover-card-content']");
const opened = () =>
  waitFor(() => {
    expect(cards()).toHaveLength(1);
    return cards()[0] as HTMLElement;
  });
const badge = (root: ParentNode) =>
  waitFor(() => {
    const el = root.querySelector("span[title^='waiting for']");
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
const rows = (card: HTMLElement) =>
  within(card)
    .getAllByRole("listitem")
    .map((row) => ({
      text: row.textContent,
      href: row.querySelector("a")?.getAttribute("href") ?? null,
    }));
const expectedRows = [
  { text: "T-8 Second prerequisite", href: "/projects/todou/issues/8" },
  { text: "T-7 First prerequisite", href: "/projects/todou/issues/7" },
  {
    text: "other/OTHER-9 Cross-project prerequisite",
    href: "/projects/other/issues/9",
  },
];

async function resolved(card: HTMLElement) {
  await waitFor(() => {
    expect(rows(card)).toHaveLength(expectedRows.length);
    for (const [index, expected] of expectedRows.entries()) {
      expect(rows(card)[index]).toMatchObject(expected);
    }
  });
}

describe("blocked badge preview (T-423)", () => {
  it.each(["row", "board"] as const)(
    "C1 %s pairs every unresolved blocker with its own title and destination",
    async (surface) => {
      const { client } = setup();
      const view = renderWithProviders(
        surface === "row" ? (
          <ul>
            <IssueRow slug="todou" issue={issue} />
          </ul>
        ) : (
          <BoardCardContent slug="todou" issue={issue} />
        ),
        client,
      );
      const trigger = await badge(view.container);
      expect(trigger.textContent).toBe("3");
      hover(trigger);
      const card = await opened();
      await resolved(card);
      expect(rows(card)).toHaveLength(Number(trigger.textContent));
      expect(trigger.contains(card)).toBe(false);
    },
  );

  it.each(["row", "board"] as const)(
    "C8 %s keeps the blocked trigger and portal outside the spec link",
    async (surface) => {
      const { client } = setup();
      const withSpec = {
        ...issue,
        spec_version: 3,
        spec_review_status: "unreviewed" as const,
      };
      const view = renderWithProviders(
        surface === "row" ? (
          <ul>
            <IssueRow slug="todou" issue={withSpec} />
          </ul>
        ) : (
          <BoardCardContent slug="todou" issue={withSpec} />
        ),
        client,
      );
      const spec = await view.findByRole("link", { name: "spec" });
      const trigger = await badge(view.container);
      hover(trigger);
      const card = await opened();
      await resolved(card);
      expect(spec.getAttribute("href")).toBe("/projects/todou/issues/1/spec");
      expect(trigger.closest("a")).toBeNull();
      expect(spec.contains(trigger)).toBe(false);
      expect(spec.contains(card)).toBe(false);
      expect(card.closest("a")).toBeNull();
      expect(document.querySelectorAll("a a")).toHaveLength(0);
      for (const link of within(card).getAllByRole("link")) {
        expect(link.parentElement?.closest("a")).toBeNull();
      }
      expect(rows(card)).toEqual(expectedRows);
    },
  );

  it.each(["before", "own_line", "after"] as const)(
    "C2 board shows a lone blocked badge with %s placement",
    async (placement) => {
      const { client } = setup(placement);
      const view = renderWithProviders(
        <BoardCardContent slug="todou" issue={issue} />,
        client,
      );
      expect((await badge(view.container)).textContent).toBe("3");
    },
  );

  it("C3 hidden and trashed blockers remain counted; cleared and empty relations have no badge", async () => {
    const { client, reads, details } = setup();
    reads.mockResolvedValue({ items: [], next_cursor: null });
    details.mockResolvedValue({
      ...item(7, "First prerequisite"),
      body: "",
      deleted_at: "2026-09-17T00:00:00Z",
    });
    const refs = [
      block(7, { blocker_deleted: true }),
      block(20, {
        hidden: true,
        project_id: null,
        project: null,
        number: null,
        ref: null,
      }),
      block(21, { cleared_at: "2026-09-17T00:00:00Z" }),
    ];
    const view = renderWithProviders(
      <>
        <BlockedBadge slug="todou" blockedBy={refs} />
        <BlockedBadge slug="todou" blockedBy={[refs[2]]} />
        <BlockedBadge slug="todou" blockedBy={[]} />
        <BlockedBadge slug="todou" blockedBy={undefined} />
      </>,
      client,
    );
    const trigger = await badge(view.container);
    expect(
      view.container.querySelectorAll("span[title^='waiting for']"),
    ).toHaveLength(1);
    expect(trigger.textContent).toBe("2");
    expect(details).not.toHaveBeenCalled();
    hover(trigger);
    const card = await opened();
    await waitFor(() =>
      expect(rows(card)).toEqual([
        {
          text: "T-7 First prerequisite (in the trash)",
          href: "/projects/todou/issues/7",
        },
        { text: "a card you cannot see", href: null },
      ]),
    );
    expect(rows(card)).toHaveLength(Number(trigger.textContent));
    expect(reads).not.toHaveBeenCalled();
    expect(details.mock.calls).toEqual([["todou", 7]]);
  });

  it("C4 only loads on sustained hover, batches by project, and reuses the reference cache", async () => {
    const { client, reads, details } = setup();
    const view = renderWithProviders(
      <BlockedBadge slug="todou" blockedBy={issue.blocked_by} />,
      client,
    );
    const trigger = await badge(view.container);
    await pause();
    expect(reads).not.toHaveBeenCalled();
    hover(trigger);
    await pause(80);
    expect(cards()).toHaveLength(0);
    unhover(trigger);
    await pause();
    expect(reads).not.toHaveBeenCalled();
    hover(trigger);
    await resolved(await opened());
    expect(
      reads.mock.calls.map(([slug, params]) => [slug, params?.numbers]),
    ).toEqual([
      ["todou", [8, 7]],
      ["other", [9]],
    ]);
    unhover(trigger);
    await waitFor(() => expect(cards()).toHaveLength(0));
    hover(trigger);
    await resolved(await opened());
    expect(reads).toHaveBeenCalledTimes(2);
    expect(details).not.toHaveBeenCalled();
  });

  it("C5 touch does not open a preview or load titles", async () => {
    const { client, reads } = setup();
    const view = renderWithProviders(
      <BlockedBadge slug="todou" blockedBy={issue.blocked_by} />,
      client,
    );
    const trigger = await badge(view.container);
    hover(trigger, "touch");
    fireEvent.pointerDown(trigger, { pointerType: "touch" });
    fireEvent.pointerUp(trigger, { pointerType: "touch" });
    fireEvent.click(trigger);
    await pause();
    expect(cards()).toHaveLength(0);
    expect(reads).not.toHaveBeenCalled();
  });

  it("C6 neither a nested badge nor a blocker link opens another preview", async () => {
    const { client, reads, details } = setup();
    const nested = renderWithProviders(
      <HoverDepth.Provider value={1}>
        <BlockedBadge slug="todou" blockedBy={issue.blocked_by} />
      </HoverDepth.Provider>,
      client,
    );
    hover(await badge(nested.container));
    await pause();
    expect(cards()).toHaveLength(0);
    expect(reads).not.toHaveBeenCalled();
    nested.unmount();
    const view = renderWithProviders(
      <BlockedBadge slug="todou" blockedBy={issue.blocked_by} />,
      client,
    );
    hover(await badge(view.container));
    const card = await opened();
    await resolved(card);
    const link = within(card).getAllByRole("link")[0];
    expect(link.getAttribute("data-state")).toBeNull();
    hover(link);
    await pause();
    expect(cards()).toHaveLength(1);
    expect(details).not.toHaveBeenCalled();
  });

  it("C7 pointer can enter the portal, select without dragging the board, and follow a blocker", async () => {
    const { client } = setup();
    const drag = vi.fn();
    const view = renderWithProviders(
      <div onPointerDown={drag}>
        <BoardCardContent slug="todou" issue={issue} />
      </div>,
      client,
    );
    const trigger = await badge(view.container);
    hover(trigger);
    const card = await opened();
    await resolved(card);
    unhover(trigger, card);
    hover(card);
    await pause(250);
    expect(cards()).toHaveLength(1);
    const link = within(card).getAllByRole("link")[0];
    fireEvent.pointerDown(link, { pointerType: "mouse" });
    expect(drag).not.toHaveBeenCalled();
    fireEvent.click(link, { ctrlKey: true });
    expect(view.router.state.location.pathname).toBe("/");
    expect(cards()).toHaveLength(1);
    fireEvent.click(link);
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe(
        "/projects/todou/issues/8",
      ),
    );
  });
});
