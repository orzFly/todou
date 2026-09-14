import { render } from "@testing-library/react";
import type { IssueMetadataEntry } from "@todou/shared";
import { afterEach, describe, expect, it } from "vitest";
import { MetadataBrowse } from "../src/components/issue/metadata-browse.tsx";

/** happy-dom's viewport, which is what its `matchMedia` answers from. */
const happyDom = globalThis as unknown as {
  happyDOM: { setViewport: (viewport: { width?: number }) => void };
};

const writer = {
  id: 7,
  login: "bot-one",
  display_name: "Toolbot",
  kind: "machine" as const,
  avatar_url: null,
  owner: null,
};

const hourAgo = new Date(Date.now() - 3_600_000).toISOString();

const entry = (
  namespace = "ns",
  key = "key",
  value = "value",
): IssueMetadataEntry => ({
  namespace,
  key,
  value,
  updated_at: hourAgo,
  updated_by: writer,
});

function mount(entries: IssueMetadataEntry[], canWrite: boolean): HTMLElement {
  const { container } = render(
    <MetadataBrowse
      groups={[{ namespace: "ns", entries }]}
      canWrite={canWrite}
      onAddKey={() => {}}
      onDeleteNamespace={() => {}}
      onEditValue={() => {}}
      onDeleteKey={() => {}}
      onAdd={() => {}}
    />,
  );
  return container;
}

/** The first data row of the group, read by cell position. */
const dataRow = (container: HTMLElement): HTMLTableRowElement => {
  const row = container.querySelector(
    '[data-testid="metadata-group-ns"] tr:nth-of-type(2)',
  );
  if (!(row instanceof HTMLTableRowElement)) throw new Error("no data row");
  return row;
};

afterEach(() => happyDom.happyDOM.setViewport({ width: 1024 }));

describe("the metadata browse table", () => {
  it("gives a writable row four cells and a read-only row three with no buttons", () => {
    // R1. Falsifies by: the current implementation renders 3 cells in both
    // roles (author, age and the buttons share one cell), so the writable
    // count fails first; the read-only "no buttons" half only means
    // something asserted next to its own 3-cell count.
    const wide = dataRow(mount([entry()], true));
    expect(wide.cells).toHaveLength(4);

    const ro = dataRow(mount([entry()], false));
    expect(ro.cells).toHaveLength(3);
    expect(ro.querySelectorAll("button")).toHaveLength(0);
  });

  it("keeps the action buttons out of the meta cell", () => {
    // R2. Falsifies by: the current implementation puts pencil and trash
    // inside the same <td> as the age and the author, so the meta cell
    // holds buttons and the action cell's text carries the author name.
    const row = dataRow(mount([entry()], true));
    expect(row.cells[2].querySelectorAll("button")).toHaveLength(0);
    expect(row.cells[3].textContent).not.toContain("Toolbot");
    expect(row.cells[3].querySelectorAll("button")).toHaveLength(2);
  });

  it("writes the meta cell as one span, author then age", () => {
    // R3. Falsifies by: the current implementation renders the age first,
    // with no separator, in two spans — its textContent is "1h agoToolbot".
    const row = dataRow(mount([entry()], true));
    expect(row.cells[2].textContent).toBe("Toolbot · 1h ago");
    expect(row.cells[2].querySelectorAll("span")).toHaveLength(1);
  });

  it("keeps colgroup, header and namespace row in step with the data row", () => {
    // R4. Falsifies by: adding a column to the data row without the rest —
    // the current table has 3 <col>, 3 `th[scope=col]` and a namespace row
    // spanning 3. Under table-fixed a stranded data row with a 3-<col>
    // colgroup leaves the 4th column unconstrained, and every other R
    // would still go green; the colgroup count closes that hole.
    const container = mount([entry()], true);
    expect(container.querySelectorAll("colgroup col")).toHaveLength(4);
    expect(container.querySelectorAll("thead th[scope=col]")).toHaveLength(4);
    const nsHead = container.querySelector(
      '[data-testid="metadata-group-ns"] th[scope=colgroup]',
    );
    expect(nsHead?.getAttribute("colspan")).toBe("4");

    const ro = mount([entry()], false);
    expect(ro.querySelectorAll("colgroup col")).toHaveLength(3);
    expect(ro.querySelectorAll("thead th[scope=col]")).toHaveLength(3);
    expect(
      ro
        .querySelector('[data-testid="metadata-group-ns"] th[scope=colgroup]')
        ?.getAttribute("colspan"),
    ).toBe("3");
  });

  it("moves the meta onto the entry's own second row on a narrow viewport", () => {
    // R5. Falsifies by: the current implementation keeps meta inside the
    // main row at any width, so the main row still has 4 cells and no
    // second <tr> exists. The viewport is set before rendering and never
    // switched back mid-test: happy-dom's `change` bookkeeping misses the
    // match → no-match step (use-media-query.test.ts).
    happyDom.happyDOM.setViewport({ width: 390 });
    const container = mount([entry()], true);
    const tbody = container.querySelector('[data-testid="metadata-group-ns"]');
    if (!tbody) throw new Error("no group");
    const rows = tbody.querySelectorAll("tr");
    expect(rows).toHaveLength(3); // namespace head, main row, meta row
    const main = rows[1];
    if (!(main instanceof HTMLTableRowElement)) throw new Error("no main row");
    expect(main.cells).toHaveLength(3);
    const metaRow = rows[2];
    expect(metaRow.textContent).toBe("Toolbot · 1h ago");
    const metaCell = metaRow.querySelector("td");
    expect(metaCell?.getAttribute("colspan")).toBe("3");
  });

  it("renders no second meta row on a wide viewport", () => {
    // R5's wide half: from `sm` up the meta lives in the main row, and the
    // entry must not grow a second row. Falsifies by: deleting the
    // `!wide` guard around the meta <tr>, which appends one under every
    // entry at any width — the exact symptom this card was opened for.
    // The absence assertion is what catches it; the narrow case above
    // stays green under that mutation, so this half cannot be dropped.
    const container = mount([entry()], true);
    const tbody = container.querySelector('[data-testid="metadata-group-ns"]');
    expect(tbody?.querySelectorAll("tr")).toHaveLength(2);
  });

  it("folds a long key with a title instead of breaking it", () => {
    // R6. Falsifies by: the current key cell uses break-all and carries no
    // title, so both assertions fail on the current markup.
    const longKey = "a".repeat(48);
    const row = dataRow(mount([entry("ns", longKey)], true));
    const keyCell = row.cells[0];
    expect(keyCell.getAttribute("title")).toBe(longKey);
    expect(keyCell.className).toContain("truncate");
    expect(keyCell.className).not.toContain("break-all");
  });

  it("puts the separator on data rows, not the namespace heading", () => {
    // R7. Falsifies by: the current data-row cells carry no border-t at
    // all. This pins the class only — whether a line is actually painted
    // is geometry, proven in a real browser (B2), not here.
    const container = mount([entry()], true);
    const row = dataRow(container);
    for (const cell of row.cells) {
      expect(cell.className).toContain("border-t");
    }
    const nsHead = container.querySelector(
      '[data-testid="metadata-group-ns"] th[scope=colgroup]',
    );
    expect(nsHead?.className).not.toContain("border-t");
  });
});
