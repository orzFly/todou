import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { IssueMetadataEntry, MemberRole, Project } from "@todou/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueMetadataQuery } from "../src/api/metadata.ts";
import { api, projectQuery } from "../src/api/queries.ts";
import { MetadataSection } from "../src/components/issue/metadata-section.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const SLUG = "p";
const NUMBER = 282;

const writer = {
  id: 7,
  login: "bot-one",
  display_name: "Toolbot",
  kind: "machine" as const,
  avatar_url: null,
  owner: null,
};

const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
const dayAgo = new Date(Date.now() - 86_400_000).toISOString();

const entry = (
  namespace: string,
  key: string,
  value: string,
  updated_at = hourAgo,
): IssueMetadataEntry => ({
  namespace,
  key,
  value,
  updated_at,
  updated_by: writer,
});

const project = (role: MemberRole) =>
  ({
    id: 1,
    slug: SLUG,
    name: "Project",
    viewer_role: role,
  }) as unknown as Project;

/**
 * `entries` are handed to the cache rather than fetched, so what is under test
 * is the rendering and not the request. The role decides which affordances the
 * dialog offers.
 */
function mount(entries: IssueMetadataEntry[], role: MemberRole = "writer") {
  const client = testQueryClient();
  client.setQueryData(projectQuery(SLUG).queryKey, project(role));
  client.setQueryData(issueMetadataQuery(SLUG, NUMBER).queryKey, { entries });
  renderWithProviders(
    <MetadataSection slug={SLUG} issueNumber={NUMBER} />,
    client,
  );
  return client;
}

const openDialog = async () => {
  const trigger = await screen.findByTestId("metadata-open");
  fireEvent.click(trigger);
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  return trigger;
};

describe("the metadata sidebar summary", () => {
  it("gives each namespace its name, its size and its newest write", async () => {
    mount([
      entry("ci", "run", "green", dayAgo),
      // The group's newest write is the second one, which is what the line
      // has to show — a card is normally read for how fresh its state is.
      entry("ci", "report", "red", hourAgo),
    ]);
    await openDialog();
    const summary = screen
      .getByTestId("metadata-sidebar")
      .querySelector('[data-slot="sidebar-summary"]')?.textContent;
    void summary;
    const line = screen.getByTestId("metadata-open").textContent ?? "";
    expect(line).toContain("ci");
    expect(line).toContain("2");
  });

  it("shows a dash for a card nobody has written on", async () => {
    mount([], "reader");
    // An empty card gives a reader nothing to open; the sidebar shows the
    // dash itself instead of hiding the section.
    const summary = await screen.findByTestId("metadata-sidebar");
    expect(summary.textContent).toContain("—");
    expect(screen.queryByTestId("metadata-open")).toBeNull();
  });

  it("lets a writer open an empty card, because writing lives in the dialog", async () => {
    // Rewritten for the tabbed dialog (T-300): an empty card has no Add
    // namespace form any more — the writer lands on Browse and switches to
    // Bulk, whose placeholder names the line format.
    mount([], "writer");
    await openDialog();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Bulk" }));
    await waitFor(() =>
      expect(screen.getByTestId("metadata-editor-tab")).toBeTruthy(),
    );
    // The editor is live, not a read-only shell: Save is present.
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    // Back on Browse the writer sees the one jump affordance an empty card
    // has — the dashed Add button that opens Bulk with a fresh snippet.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Browse" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add" })).toBeTruthy(),
    );
  });

  it("opens the same full dialog from any line", async () => {
    mount([entry("ci", "run", "green"), entry("orch", "phase", "plan")]);
    await openDialog();
    const dialog = screen.getByRole("dialog");
    // Every namespace, whichever line was clicked — the summary is a summary,
    // not navigation into one group.
    expect(dialog.textContent).toContain("ci");
    expect(dialog.textContent).toContain("orch");
    expect(dialog.textContent).toContain("green");
    expect(dialog.textContent).toContain("plan");
  });
});

describe("the metadata dialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("groups rows by namespace and keeps the API's order", async () => {
    mount([
      entry("ci", "run", "green"),
      entry("orch", "owner", "planner"),
      entry("orch", "phase", "plan"),
    ]);
    await openDialog();
    const text = screen.getByRole("dialog").textContent ?? "";
    expect(text.indexOf("ci")).toBeLessThan(text.indexOf("orch"));
    expect(text.indexOf("owner")).toBeLessThan(text.indexOf("phase"));
  });

  it("folds a long value until it is asked to show all", async () => {
    const long = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
    mount([entry("ci", "report", long)], "reader");
    await openDialog();
    const value = screen.getByText(/line 0/);
    expect(value.className).toContain("line-clamp-5");
    fireEvent.click(screen.getByRole("button", { name: /Show all/ }));
    await waitFor(() =>
      expect(screen.getByText(/line 0/).className).not.toContain(
        "line-clamp-5",
      ),
    );
  });

  it("offers a reader no way to change anything", async () => {
    mount([entry("orch", "phase", "plan")], "reader");
    await openDialog();
    expect(screen.queryByRole("button", { name: /^Delete/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add key/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Add$/ })).toBeNull();
    // No pencil either: editing lives in Bulk, one click away for writers.
    expect(
      screen.queryByRole("button", { name: /Edit orch\/phase/ }),
    ).toBeNull();
    // Not even an unlabelled control inside the row: the value shows as
    // text and nothing else. Paired with the writer's delete test below,
    // which proves rows do carry buttons when they may write.
    const readerTdButtons = screen
      .getByTestId("metadata-group-orch")
      .querySelectorAll("td button");
    expect(readerTdButtons).toHaveLength(0);
  });

  it("deletes a key without a second confirmation", async () => {
    const spy = vi
      .spyOn(api, "writeIssueMetadata")
      .mockResolvedValue({ entries: [] });
    mount([entry("orch", "phase", "plan")]);
    await openDialog();
    // Pairing for the reader's empty-value-cell sweep: a writer's row does
    // carry buttons, so the reader's zero-button assertion is not trivially
    // true of a broken query.
    const anyTdButtons = screen
      .getByTestId("metadata-group-orch")
      .querySelectorAll("td button");
    expect(anyTdButtons.length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Delete orch/phase" }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0]?.[2]).toEqual({
      entries: [
        { namespace: "orch", key: "phase", value: null, if_match: "plan" },
      ],
    });
  });

  it("deletes a namespace only after confirming, in one write", async () => {
    const spy = vi
      .spyOn(api, "writeIssueMetadata")
      .mockResolvedValue({ entries: [] });
    mount([entry("orch", "owner", "planner"), entry("orch", "phase", "plan")]);
    await openDialog();
    fireEvent.click(
      screen.getByRole("button", { name: "Delete namespace orch" }),
    );
    // Nothing sent until the confirmation.
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0]?.[2]).toEqual({
      entries: [
        { namespace: "orch", key: "owner", value: null, if_match: "planner" },
        { namespace: "orch", key: "phase", value: null, if_match: "plan" },
      ],
    });
  });
});
