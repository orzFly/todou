import type { IssueListFilter, IssueListRow } from "@todou/shared";
import { admitsRow, filterIsDecidable } from "@todou/shared";
import { describe, expect, it } from "vitest";

const fields = (
  over: Partial<Omit<Extract<IssueListRow, { kind: "fields" }>, "kind">> = {},
): Extract<IssueListRow, { kind: "fields" }> => ({
  kind: "fields",
  status_id: 10,
  ...over,
});

/** The board's statuses: 10 and 11 open, 20 closed. */
const categoryOf = (id: number): "open" | "closed" | undefined =>
  ({ 10: "open", 11: "open", 20: "closed" })[id] as
    | "open"
    | "closed"
    | undefined;

describe("filterIsDecidable", () => {
  it("admits the filters a row's fields can answer", () => {
    for (const filter of [
      {},
      { status: [1] },
      { label: [2], assignee: 3 },
      { category: "open" as const },
      // Pagination narrows nothing, so it cannot make a filter undecidable.
      { status: [1], cursor: "abc" },
      // An empty `q` is what the URL schema leaves behind when the search
      // box is cleared; it filters nothing.
      { q: "" },
      { deleted: false },
    ]) {
      expect(filterIsDecidable(filter)).toBe(true);
    }
  });

  it("refuses a text search and the trash", () => {
    // `q` matches the body too, which no list row carries.
    expect(filterIsDecidable({ q: "flood" })).toBe(false);
    // The trash sorts by deletion time and hides other people's cards from
    // a non-admin; neither follows from status, labels and assignees.
    expect(filterIsDecidable({ deleted: true })).toBe(false);
  });
});

describe("admitsRow", () => {
  it("is unknown for a filter it cannot judge", () => {
    expect(admitsRow({ q: "flood" }, fields())).toBe("unknown");
    expect(admitsRow({ deleted: true }, fields())).toBe("unknown");
  });

  it("admits everything under an empty filter", () => {
    expect(admitsRow({}, fields())).toBe(true);
  });

  describe("status", () => {
    it("is always decidable, because a fields verdict always carries it", () => {
      expect(admitsRow({ status: [10, 11] }, fields({ status_id: 10 }))).toBe(
        true,
      );
      expect(admitsRow({ status: [11] }, fields({ status_id: 10 }))).toBe(
        false,
      );
    });

    it("matches nothing under an empty id list, like the SQL does", () => {
      expect(admitsRow({ status: [] }, fields())).toBe(false);
    });
  });

  describe("category", () => {
    it("maps the status id through the caller's statuses", () => {
      expect(
        admitsRow(
          { category: "open" },
          fields({ status_id: 10 }),
          undefined,
          categoryOf,
        ),
      ).toBe(true);
      expect(
        admitsRow(
          { category: "open" },
          fields({ status_id: 20 }),
          undefined,
          categoryOf,
        ),
      ).toBe(false);
    });

    it("is unknown without a mapping, or for a status outside it", () => {
      expect(admitsRow({ category: "open" }, fields())).toBe("unknown");
      expect(
        admitsRow(
          { category: "open" },
          fields({ status_id: 99 }),
          undefined,
          categoryOf,
        ),
      ).toBe("unknown");
    });
  });

  describe("label", () => {
    it("matches any of the filtered labels", () => {
      expect(admitsRow({ label: [5, 6] }, fields({ label_ids: [6, 7] }))).toBe(
        true,
      );
      expect(admitsRow({ label: [5] }, fields({ label_ids: [6, 7] }))).toBe(
        false,
      );
      expect(admitsRow({ label: [5] }, fields({ label_ids: [] }))).toBe(false);
    });

    it("falls back to the cached set when the verdict omits it", () => {
      // Omitted means "this set did not change", so the value the client
      // already has is the current one.
      expect(admitsRow({ label: [5] }, fields(), { label_ids: [5] })).toBe(
        true,
      );
      expect(admitsRow({ label: [5] }, fields(), { label_ids: [9] })).toBe(
        false,
      );
    });

    it("is unknown when neither the verdict nor the cache has it", () => {
      expect(admitsRow({ label: [5] }, fields())).toBe("unknown");
      expect(admitsRow({ label: [5] }, fields(), {})).toBe("unknown");
    });
  });

  describe("assignee", () => {
    it("matches membership of the assignee set", () => {
      expect(admitsRow({ assignee: 3 }, fields({ assignee_ids: [3] }))).toBe(
        true,
      );
      expect(admitsRow({ assignee: 3 }, fields({ assignee_ids: [4] }))).toBe(
        false,
      );
      expect(admitsRow({ assignee: 3 }, fields({ assignee_ids: [] }))).toBe(
        false,
      );
    });

    it("falls back to the cached set, else unknown", () => {
      expect(admitsRow({ assignee: 3 }, fields(), { assignee_ids: [3] })).toBe(
        true,
      );
      expect(admitsRow({ assignee: 3 }, fields(), { assignee_ids: [4] })).toBe(
        false,
      );
      expect(admitsRow({ assignee: 3 }, fields())).toBe("unknown");
    });
  });

  describe("several dimensions at once", () => {
    it("ANDs them", () => {
      const filter: IssueListFilter = { status: [10], label: [5] };
      expect(admitsRow(filter, fields({ label_ids: [5] }))).toBe(true);
      expect(admitsRow(filter, fields({ label_ids: [9] }))).toBe(false);
    });

    it("lets one dimension's no settle another's unknown", () => {
      // This is what keeps a board column cheap: it filters on status only,
      // so an unknown label set never reaches it — and even where a filter
      // does carry both, a status miss is already the whole answer.
      expect(admitsRow({ status: [11], label: [5] }, fields())).toBe(false);
      expect(
        admitsRow(
          { category: "closed", assignee: 3 },
          fields({ status_id: 10 }),
          undefined,
          categoryOf,
        ),
      ).toBe(false);
    });

    it("is unknown while every judged dimension says yes", () => {
      expect(admitsRow({ status: [10], label: [5] }, fields())).toBe("unknown");
    });
  });
});
