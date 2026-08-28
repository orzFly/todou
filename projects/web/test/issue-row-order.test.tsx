import type { QueryClient } from "@tanstack/react-query";
import { within } from "@testing-library/react";
import type {
  IssueListItem,
  MePrefs,
  ReferenceConfig,
  RefPlacement,
  Status,
} from "@todou/shared";
import { describe, expect, it } from "vitest";
import { prefsQuery } from "../src/api/prefs.ts";
import { referenceConfigQuery } from "../src/api/references.ts";
import {
  IssueRow,
  useIssueListGrid,
} from "../src/components/issue/issue-row.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const SLUG = "p";
const TITLE = "issue 1";
const REF = "T-1";

const status: Status = {
  id: 1,
  name: "Todo",
  category: "open",
  color: "#000000",
  position: 1,
  is_default: false,
};

const issue: IssueListItem = {
  id: 10,
  number: 1,
  title: TITLE,
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
  created_at: "2026-08-28T00:00:00Z",
  updated_at: "2026-08-28T00:00:00Z",
  body_edited_at: null,
  open_questions: 0,
  spec_version: null,
  spec_review_status: null,
  spec_unresolved_comments: 0,
  unread: false,
  unread_comments: 0,
};

const prefixedConfig: ReferenceConfig = {
  format: { prefix: "T", history: [] },
  autolinks: [],
};

function seededClient(placement: RefPlacement): QueryClient {
  const client = testQueryClient();
  client.setQueryData(referenceConfigQuery(SLUG).queryKey, prefixedConfig);
  client.setQueryData(prefsQuery.queryKey, {
    show_weak_unread: true,
    ref_placement_list: placement,
    // Deliberately unlike the list's: a row must read its own surface's key.
    ref_placement_board: "own_line",
    ref_placement_detail: "after",
    ref_placement_reference: "after",
  } satisfies MePrefs);
  return client;
}

/** True when `b` comes after `a` in document order. */
const precedes = (a: Element, b: Element) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

/**
 * Scoped to this render's own container: the order cases mount both
 * preferences side by side, and body-wide queries would see two rows.
 */
async function renderRow(placement: RefPlacement) {
  const { container } = renderWithProviders(
    <ul>
      <IssueRow slug={SLUG} issue={issue} meta={<span>the meta line</span>} />
    </ul>,
    seededClient(placement),
  );
  const view = within(container);
  const title = await view.findByText(TITLE);
  return { view, title, ref: view.getByText(REF) };
}

function GridProbe() {
  return <div data-testid="grid" className={useIssueListGrid()} />;
}

const renderGrid = async (placement: RefPlacement) => {
  const { container } = renderWithProviders(
    <GridProbe />,
    seededClient(placement),
  );
  return (await within(container).findByTestId("grid")).className;
};

describe("IssueRow ref placement (T-153, T-157)", () => {
  it("leads with the ref by default, in its own column", async () => {
    const { title, ref } = await renderRow("before");
    expect(precedes(ref, title)).toBe(true);
    // Its own grid cell, not a passenger of the title's flex box — that is
    // what lets the list size the column to its longest ref (T-155).
    expect(ref.parentElement?.tagName).toBe("LI");
  });

  it("trails the title when the list is set to after", async () => {
    const { title, ref } = await renderRow("after");
    expect(precedes(title, ref)).toBe(true);
    expect(ref.parentElement).toBe(title.parentElement);
  });

  it("keeps the trailing ref off the truncation path", async () => {
    const { title, ref } = await renderRow("after");
    expect(title.className).toContain("truncate");
    expect(ref.className).toContain("shrink-0");
    expect(ref.className).toContain("whitespace-nowrap");
  });

  it("drops the ref column from the list, rather than emptying it", async () => {
    expect(await renderGrid("before")).toContain(
      "grid-cols-[27px_max-content_1fr]",
    );
    expect(await renderGrid("after")).toContain("grid-cols-[27px_1fr]");
  });

  it("indents the meta line under the title in both orders", async () => {
    const leading = await renderRow("before");
    expect(
      leading.view.getByText("the meta line").parentElement?.className,
    ).toContain("col-start-3");

    const trailing = await renderRow("after");
    expect(
      trailing.view.getByText("the meta line").parentElement?.className,
    ).toContain("col-start-2");
  });
});
