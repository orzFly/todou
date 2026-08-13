import type { IssueListItem, Label, Status } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { IssueRow } from "../src/pages/issue-list.tsx";
import { renderWithProviders } from "./render.tsx";

const status: Status = {
  id: 1,
  name: "Todo",
  category: "open",
  color: "#000000",
  position: 1,
  is_default: false,
};

const labels: Label[] = [
  { id: 1, name: "area:web", color: "#3b82f6" },
  { id: 2, name: "area:server", color: "#0ea5e9" },
  { id: 3, name: "kind:feature", color: "#22c55e" },
  { id: 4, name: "needs-brainstorm", color: "#a855f7" },
];

const issue = (labelCount: number): IssueListItem => ({
  id: 10,
  number: 1,
  title: "issue 1",
  status,
  author: {
    id: 1,
    login: "user",
    display_name: "User",
    kind: "human",
    avatar_url: null,
    owner: null,
  },
  assignees: [],
  labels: labels.slice(0, labelCount),
  created_at: "2026-08-12T00:00:00Z",
  updated_at: "2026-08-12T00:00:00Z",
  body_edited_at: null,
  open_questions: 0,
  spec_version: null,
  spec_review_status: null,
  spec_unresolved_comments: 0,
  unread: false,
  unread_comments: 0,
});

const renderRow = (labelCount: number) =>
  renderWithProviders(
    <ul>
      <IssueRow
        slug="p"
        issue={issue(labelCount)}
        statuses={[status]}
        allLabels={labels}
        onStatus={() => {}}
        onToggleLabel={() => {}}
      />
    </ul>,
  );

/* Wrapping itself is CSS (flex-wrap on the meta line), which jsdom cannot
   exercise — so the assertions are that nothing hides or folds labels
   anymore; the real-browser pass covers the wrapped rendering. */
describe("IssueRow labels wrap instead of folding (T-98)", () => {
  it("renders every label with no width-based hiding", async () => {
    const view = renderRow(4);
    await view.findByText("issue 1");
    for (const label of labels) {
      expect(view.getByTitle(label.name).className).not.toContain(
        "max-sm:hidden",
      );
    }
  });

  it("renders no +N chip regardless of label count", async () => {
    const view = renderRow(4);
    await view.findByText("issue 1");
    expect(view.queryByText(/^\+\d/)).toBeNull();
  });
});
