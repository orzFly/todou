import { render } from "@testing-library/react";
import type { IssueListPage, Status } from "@todou/shared";
import { describe, expect, it } from "vitest";
import {
  csvToIds,
  effectiveCategory,
  effectiveSort,
  idsToCsv,
  issueSearchSchema,
  listParams,
  patchIssueStatus,
  toggleId,
} from "../src/api/issues.ts";
import { LabelChip } from "../src/components/issue/label-chip.tsx";
import { StatusPill } from "../src/components/issue/status-pill.tsx";

describe("issueSearchSchema (filter state ↔ URL)", () => {
  it("accepts an empty search", () => {
    expect(issueSearchSchema.parse({})).toEqual({});
  });

  it("keeps csv id lists and coerces assignee", () => {
    const parsed = issueSearchSchema.parse({
      status: "1,2",
      label: "3",
      assignee: "7",
      category: "open",
      sort: "number",
      order: "asc",
      q: "potato",
    });
    expect(parsed.status).toBe("1,2");
    expect(parsed.assignee).toBe(7);
  });

  it("rejects malformed csv", () => {
    expect(issueSearchSchema.safeParse({ status: "1,x" }).success).toBe(false);
  });

  it("accepts the explicit 'all' category", () => {
    expect(issueSearchSchema.parse({ category: "all" }).category).toBe("all");
  });
});

describe("list defaults (open, recently updated)", () => {
  it("defaults to the open category and updated-desc sort", () => {
    expect(effectiveCategory({})).toBe("open");
    expect(effectiveSort({})).toEqual({ sort: "updated", order: "desc" });
    expect(listParams({})).toMatchObject({
      category: "open",
      sort: "updated",
      order: "desc",
    });
  });

  it("keeps explicit choices and maps 'all' to no category param", () => {
    expect(effectiveCategory({ category: "closed" })).toBe("closed");
    expect(listParams({ category: "all" }).category).toBeUndefined();
    expect(listParams({ sort: "number", order: "asc" })).toMatchObject({
      sort: "number",
      order: "asc",
    });
  });
});

describe("csv helpers", () => {
  it("round-trips ids", () => {
    expect(csvToIds("1,2,3")).toEqual([1, 2, 3]);
    expect(csvToIds(undefined)).toBeUndefined();
    expect(idsToCsv([1, 2])).toBe("1,2");
    expect(idsToCsv([])).toBeUndefined();
  });

  it("toggles membership", () => {
    expect(toggleId([1, 2], 2)).toEqual([1]);
    expect(toggleId([1], 3)).toEqual([1, 3]);
  });
});

describe("patchIssueStatus (optimistic cache update)", () => {
  const status = (id: number, name: string): Status => ({
    id,
    name,
    category: "open",
    color: "#123456",
    position: 0,
    is_default: false,
  });

  const page: IssueListPage = {
    items: [
      {
        id: 10,
        number: 1,
        title: "a",
        status: status(1, "Todo"),
        author: {
          id: 1,
          login: "user",
          display_name: "User",
          kind: "human",
          owner: null,
        },
        assignees: [],
        labels: [],
        created_at: "2026-08-11T00:00:00Z",
        updated_at: "2026-08-11T00:00:00Z",
        body_edited_at: null,
      },
    ],
    next_cursor: null,
  };

  it("replaces only the targeted issue's status", () => {
    const next = patchIssueStatus(page, 1, status(2, "Done"));
    expect(next.items[0]?.status.name).toBe("Done");
    // Original page is untouched (rollback keeps the snapshot valid).
    expect(page.items[0]?.status.name).toBe("Todo");
  });

  it("leaves other issues alone", () => {
    const next = patchIssueStatus(page, 99, status(2, "Done"));
    expect(next.items[0]?.status.name).toBe("Todo");
  });
});

describe("presentational chips", () => {
  it("renders status name with its color dot", () => {
    const { getByText } = render(
      <StatusPill
        status={{
          id: 1,
          name: "In Progress",
          category: "open",
          color: "#3b82f6",
          position: 1,
          is_default: false,
        }}
      />,
    );
    expect(getByText("In Progress")).toBeTruthy();
  });

  it("renders label chips tinted by label color", () => {
    const { getByText } = render(
      <LabelChip label={{ id: 1, name: "bug", color: "#ff0000" }} />,
    );
    expect(getByText("bug")).toBeTruthy();
  });
});
