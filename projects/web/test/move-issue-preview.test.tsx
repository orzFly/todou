import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { MoveIssueResult, Project } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, projectsQuery } from "../src/api/queries.ts";
import { MoveIssueDialog } from "../src/components/issue/move-issue-dialog.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

/** The move dialog's preview failure branch (T-376): the dry-run read can
 * fail like any other, and until it succeeds there is nothing to confirm
 * against — the failure block is the only honest content. */

const destination = {
  id: 2,
  slug: "dest",
  name: "Destination",
  description: "",
  created_at: "2026-01-01T00:00:00Z",
  viewer_role: "writer",
} as unknown as Project;

const preview = (over: Partial<MoveIssueResult> = {}): MoveIssueResult => ({
  moved_to: { slug: "dest", number: 55, comment_id: undefined },
  reinhabited: false,
  mapping: {
    status: { from: "Next", to: "Todo" },
    dropped_labels: [],
    dropped_assignees: [],
  },
  issue: null,
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe("move dialog · preview failure (T-376)", () => {
  it("offers Retry and shows the mapping once the preview lands", async () => {
    const move = vi
      .spyOn(api, "moveIssue")
      .mockRejectedValueOnce(new Error("preview refused"));
    const client = testQueryClient();
    client.setQueryData(projectsQuery.queryKey, [destination]);
    renderWithProviders(
      <MoveIssueDialog
        slug="src"
        issueNumber={9}
        open={true}
        onOpenChange={() => {}}
      />,
      client,
    );

    // Pick the destination, which arms the preview query.
    fireEvent.click(await screen.findByText("Destination"));
    expect(await screen.findByText("preview refused")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();

    move.mockResolvedValueOnce(preview());
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(move).toHaveBeenCalledTimes(2));
    await screen.findByText(/Next.*Todo/);
    expect(screen.queryByText("preview refused")).toBeNull();
  });
});
