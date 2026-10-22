import type { IssueListItem, Status, UserRef, Watcher } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { IssueRowMeta } from "../src/components/issue/issue-row.tsx";
import { BoardCardContent } from "../src/pages/board.tsx";
import { renderWithProviders } from "./render.tsx";
import { BOT, CLAUDE, watcher } from "./watcher-fixtures.ts";

const status: Status = {
  id: 1,
  name: "Todo",
  category: "open",
  color: "#000000",
  position: 1,
  is_default: false,
};

const HUMAN: UserRef = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human",
  avatar_url: null,
  owner: null,
};

const issue = (assignees: UserRef[]): IssueListItem => ({
  id: 10,
  number: 4,
  title: "issue 4",
  status,
  author: HUMAN,
  assignees,
  labels: [],
  created_at: "2026-10-22T00:00:00Z",
  updated_at: "2026-10-22T00:00:00Z",
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

/**
 * The avatars in order, each with whether it carries the live dot, and the
 * eye where it sits — read off the DOM in document order. The eye is found by
 * lucide's identity class, matched whole.
 */
function arrangement(root: ParentNode): string[] {
  const out: string[] = [];
  for (const node of root.querySelectorAll("a[href^='/users/'], svg")) {
    if (node.tagName.toLowerCase() === "svg") {
      if ([...node.classList].includes("lucide-eye")) out.push("eye");
      continue;
    }
    const login = (node.getAttribute("href") ?? "").replace("/users/", "");
    out.push(node.querySelector("[data-live-dot]") ? `${login}•` : login);
  }
  return out;
}

const renderRow = (assignees: UserRef[], watchers: Watcher[]) =>
  renderWithProviders(
    <div>
      <IssueRowMeta
        issue={issue(assignees)}
        statuses={[status]}
        allLabels={[]}
        onStatus={() => {}}
        onToggleLabel={() => {}}
        watchers={watchers}
      />
    </div>,
  );

describe("IssueRowMeta watchers (T-540)", () => {
  it("puts the live dot on a watching assignee and no eye", async () => {
    const view = renderRow([CLAUDE, HUMAN], [watcher(CLAUDE), watcher(CLAUDE)]);
    await view.findByLabelText("Claude Agent · watching");
    expect(arrangement(view.container)).toEqual(["claude-agent•", "user"]);
  });

  it("puts an unassigned watcher behind the eye", async () => {
    const view = renderRow([CLAUDE, HUMAN], [watcher(CLAUDE), watcher(BOT)]);
    await view.findByLabelText("Bot One · watching");
    expect(arrangement(view.container)).toEqual([
      "claude-agent•",
      "user",
      "eye",
      "bot-one•",
    ]);
  });

  it("leads with the eye when nobody is assigned", async () => {
    const view = renderRow([], [watcher(BOT)]);
    await view.findByLabelText("Bot One · watching");
    expect(arrangement(view.container)).toEqual(["eye", "bot-one•"]);
  });

  it("is unchanged without watchers", async () => {
    const view = renderRow([HUMAN], []);
    await view.findByLabelText("User");
    expect(arrangement(view.container)).toEqual(["user"]);
  });
});

describe("BoardCardContent watchers (T-540)", () => {
  it("keeps a meta row for a card whose only content is a watcher, padded for the dot", async () => {
    const view = renderWithProviders(
      <BoardCardContent slug="p" issue={issue([])} watchers={[watcher(BOT)]} />,
    );
    await view.findByLabelText("Bot One · watching");
    const meta = view.container.querySelector("[data-card-meta]");
    expect(meta).not.toBeNull();
    expect(arrangement(meta as Element)).toEqual(["eye", "bot-one•"]);
    // The clip room the bot badge needs on the right holds for watchers too.
    expect(meta?.querySelector(".ml-auto")?.className).toContain("pr-1.5");
  });

  it("drops the meta row again with no watchers", async () => {
    const view = renderWithProviders(
      <BoardCardContent slug="p" issue={issue([])} watchers={[]} />,
    );
    await view.findByText("issue 4");
    expect(view.container.querySelector("[data-card-meta]")).toBeNull();
  });
});
