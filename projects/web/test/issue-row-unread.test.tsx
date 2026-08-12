import type { IssueListItem, Status } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { Table, TableBody } from "../src/components/ui/table.tsx";
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

const issue = (unread: boolean): IssueListItem => ({
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
  labels: [],
  created_at: "2026-08-12T00:00:00Z",
  updated_at: "2026-08-12T00:00:00Z",
  body_edited_at: null,
  open_questions: 0,
  spec_version: null,
  spec_review_status: null,
  spec_unresolved_comments: 0,
  unread,
});

const renderRow = (unread: boolean) =>
  renderWithProviders(
    <Table>
      <TableBody>
        <IssueRow
          slug="p"
          issue={issue(unread)}
          statuses={[status]}
          allLabels={[]}
          onStatus={() => {}}
          onToggleLabel={() => {}}
        />
      </TableBody>
    </Table>,
  );

describe("IssueRow unread dot (#46)", () => {
  it("shows the dot next to the number for foreign activity", async () => {
    const view = renderRow(true);
    await view.findByText("issue 1");
    expect(view.getByTitle("new activity since you last viewed")).toBeTruthy();
  });

  it("keeps the slot empty once read", async () => {
    const view = renderRow(false);
    await view.findByText("issue 1");
    expect(view.queryByTitle("new activity since you last viewed")).toBeNull();
  });
});
