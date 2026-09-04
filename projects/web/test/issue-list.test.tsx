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
import {
  LabelChip,
  LabelChips,
  LabelInline,
  splitLabelName,
} from "../src/components/issue/label-chip.tsx";
import { StatusPill } from "../src/components/issue/status-pill.tsx";
import { groupStickyTop } from "../src/pages/issue-list.tsx";

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

  it("survives params the router already read as numbers", () => {
    // `?q=1`, `?status=3`, `?label=5` reach validateSearch as numbers, and a
    // bare z.string() there throws the whole route away (T-189).
    expect(issueSearchSchema.parse({ q: 1 }).q).toBe("1");
    expect(issueSearchSchema.parse({ status: 3 }).status).toBe("3");
    expect(issueSearchSchema.parse({ label: 5 }).label).toBe("5");
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
          avatar_url: null,
          owner: null,
        },
        assignees: [],
        labels: [],
        created_at: "2026-08-11T00:00:00Z",
        updated_at: "2026-08-11T00:00:00Z",
        body_edited_at: null,
        open_questions: 0,
        spec_version: null,
        spec_review_status: null,
        spec_unresolved_comments: 0,
        deleted_at: null,
        deleted_by: null,
        unread: false,
        unread_comments: 0,
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
      <StatusPill status={{ name: "In Progress", color: "#3b82f6" }} />,
    );
    expect(getByText("In Progress")).toBeTruthy();
  });

  it("renders label chips with the full name reachable", () => {
    const { getByText } = render(
      <LabelChip label={{ id: 1, name: "bug", color: "#ff0000" }} />,
    );
    expect(getByText("bug")).toBeTruthy();
  });

  it("tints the chip with the label color instead of showing a dot (T-90)", () => {
    const chip = render(
      <LabelChip label={{ id: 1, name: "bug", color: "#ff0000" }} />,
    ).container.firstElementChild as HTMLElement;
    expect(chip.style.backgroundColor).not.toBe("");
    expect(chip.style.color).not.toBe("");
    expect(chip.querySelectorAll("span").length).toBe(0);
  });

  it("keeps the full name in the title when valueOnly trims the prefix", () => {
    const { getByTitle } = render(
      <LabelChip
        label={{ id: 1, name: "area:web", color: "#3b82f6" }}
        valueOnly
      />,
    );
    expect(getByTitle("area:web").textContent).toBe("web");
  });

  it("renders a menu-row label with the prefix outside a borderless badge", () => {
    const { container, getByTitle } = render(
      <LabelInline label={{ id: 1, name: "area:web", color: "#3b82f6" }} />,
    );
    const badge = getByTitle("area:web") as HTMLElement;
    expect(badge.textContent).toBe("web");
    expect(badge.style.borderColor).toBe("transparent");
    expect(container.textContent).toBe("area:web");
  });

  it("groups same-prefix labels behind one muted prefix (T-90)", () => {
    const { container, getByTitle, getByText } = render(
      <LabelChips
        labels={[
          { id: 1, name: "area:web", color: "#3b82f6" },
          { id: 2, name: "area:cli", color: "#0ea5e9" },
          { id: 3, name: "needs-brainstorm", color: "#8b5cf6" },
        ]}
      />,
    );
    // one shared "area:" text node, not one per label
    expect(
      [...container.querySelectorAll("span")].filter(
        (n) => n.textContent === "area:",
      ).length,
    ).toBe(1);
    expect(getByTitle("area:web").textContent).toBe("web");
    expect(getByTitle("area:cli").textContent).toBe("cli");
    expect(getByText("needs-brainstorm")).toBeTruthy();
  });

  it("shares vertical metrics between status pill and label chip (T-98)", () => {
    const pill = render(
      <StatusPill status={{ name: "Todo", color: "#3b82f6" }} />,
    ).container.firstElementChild;
    const chip = render(
      <LabelChip label={{ id: 1, name: "bug", color: "#ff0000" }} />,
    ).container.firstElementChild;
    for (const metric of ["text-xs", "py-0.5", "border"]) {
      expect(pill?.className.split(" ")).toContain(metric);
      expect(chip?.className.split(" ")).toContain(metric);
    }
  });
});

describe("splitLabelName (first-colon split)", () => {
  it("splits a structured name at the first colon", () => {
    expect(splitLabelName("area:web")).toEqual({
      prefix: "area:",
      value: "web",
    });
  });

  it("keeps colon-free names whole", () => {
    expect(splitLabelName("needs-brainstorm")).toEqual({
      prefix: null,
      value: "needs-brainstorm",
    });
  });

  it("only the first colon splits", () => {
    expect(splitLabelName("a:b:c")).toEqual({ prefix: "a:", value: "b:c" });
  });

  it("a leading colon is not a prefix", () => {
    expect(splitLabelName(":x")).toEqual({ prefix: null, value: ":x" });
  });
});

describe("groupStickyTop (offsets follow the measured header)", () => {
  it("stacks the floating toolbar on a two-row header", () => {
    // 700 wide: header wraps to 97, the filters wrap to 118.
    expect(groupStickyTop(97, 118, true)).toBe(215);
  });

  it("stacks the floating toolbar on a one-row header", () => {
    // 1280 wide: header 57, filters on one line at 82.
    expect(groupStickyTop(57, 82, true)).toBe(139);
  });

  it("leaves the toolbar out while it scrolls with the list", () => {
    // Below sm the toolbar is not sticky, so only the header floats.
    expect(groupStickyTop(97, 118, false)).toBe(97);
  });
});
