import { render, within } from "@testing-library/react";
import { CAPABILITIES, type CapabilityId, MEMBER_ROLES } from "@todou/shared";
import { describe, expect, it } from "vitest";
import {
  DISPLAY_ROWS,
  RolePermissionsTable,
} from "../src/components/shared/role-permissions-table.tsx";

/** The cell of `label` in `role`'s column: "✓" or "—". */
function cell(container: HTMLElement, label: string, role: string): string {
  const found = within(container).getByLabelText(`${label} · ${role}`);
  return found.textContent ?? "";
}

describe("the display rows", () => {
  it("cover every capability exactly once", () => {
    const covered = DISPLAY_ROWS.flatMap((row) => [...row.caps]);
    const catalog = CAPABILITIES.map((cap) => cap.id as CapabilityId);

    expect(
      catalog.filter((id) => !covered.includes(id)),
      "capabilities missing from the table",
    ).toEqual([]);
    expect(
      covered.filter((id) => !catalog.includes(id)),
      "table rows naming capabilities that no longer exist",
    ).toEqual([]);
    expect(new Set(covered).size, "a capability listed in two rows").toBe(
      covered.length,
    );
  });
});

describe("the rendered table", () => {
  it("has one column per role", () => {
    const { container } = render(<RolePermissionsTable />);
    for (const role of MEMBER_ROLES) {
      expect(within(container).getByText(role)).toBeTruthy();
    }
  });

  it("opens issues to a reporter but not to a reader", () => {
    const { container } = render(<RolePermissionsTable />);
    expect(cell(container, "Open a new issue", "reader")).toBe("—");
    expect(cell(container, "Open a new issue", "reporter")).toBe("✓");
    expect(cell(container, "Open a new issue", "writer")).toBe("✓");
  });

  it("keeps triage above the reporter", () => {
    const { container } = render(<RolePermissionsTable />);
    const row = "Change status, assignees and labels";
    expect(cell(container, row, "reporter")).toBe("—");
    expect(cell(container, row, "writer")).toBe("✓");
  });

  it("allows every writer to withdraw specs, but not reporters or readers", () => {
    const { container } = render(<RolePermissionsTable />);
    const row = "Push, withdraw, review and resolve specs";
    expect(cell(container, row, "reader")).toBe("—");
    expect(cell(container, row, "reporter")).toBe("—");
    expect(cell(container, row, "writer")).toBe("✓");
    expect(cell(container, row, "admin")).toBe("✓");
  });

  it("gives the label catalog to a writer", () => {
    const { container } = render(<RolePermissionsTable />);
    const row = "Create, recolor and delete labels";
    expect(cell(container, row, "reporter")).toBe("—");
    expect(cell(container, row, "writer")).toBe("✓");
    expect(cell(container, row, "admin")).toBe("✓");
  });

  // The server lets a writer rewrite anyone's title and body — triaging
  // other people's cards is what an orchestrator does — so only the
  // reporter's cell may claim "your own" (T-650).
  it("marks own-only per role, not per row", () => {
    const { container } = render(<RolePermissionsTable />);
    const edit = "Edit the title and body of an issue";
    expect(cell(container, edit, "reader")).toBe("—");
    expect(cell(container, edit, "reporter")).toBe("✓ *");
    expect(cell(container, edit, "writer")).toBe("✓");
    expect(cell(container, edit, "admin")).toBe("✓");

    const trash = "Move an issue to the trash";
    expect(cell(container, trash, "reporter")).toBe("✓ *");
    expect(cell(container, trash, "writer")).toBe("✓ *");
    expect(cell(container, trash, "admin")).toBe("✓");
  });

  it("reads its roles off the catalog rather than a list of its own", () => {
    const { container } = render(<RolePermissionsTable />);
    // Renaming the project is an admin gate; if the table hardcoded a role
    // per row this is the one that would go stale first.
    expect(cell(container, "Rename or delete the project", "writer")).toBe("—");
    expect(cell(container, "Rename or delete the project", "admin")).toBe("✓");
  });
});
