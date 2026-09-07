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
      entry("orch", "owner", "planner", dayAgo),
      entry("orch", "phase", "plan", hourAgo),
    ]);
    const section = await screen.findByTestId("metadata-sidebar");
    expect(section.textContent).toContain("ci");
    expect(section.textContent).toContain("orch");
    expect(section.textContent).toContain("1h ago");
    expect(section.textContent).toContain("1d ago");
    // Two groups, two counts.
    expect(section.textContent).toContain("1");
    expect(section.textContent).toContain("2");
  });

  it("shows a dash for a card nobody has written on", async () => {
    mount([], "reader");
    const section = await screen.findByTestId("metadata-sidebar");
    expect(section.textContent).toContain("—");
    // Not hidden: "this card has none" and "this does not exist here" have to
    // stay tellable apart.
    expect(section.textContent).toContain("Metadata");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("lets a writer open an empty card, because writing lives in the dialog", async () => {
    mount([], "writer");
    await openDialog();
    expect(screen.getByRole("button", { name: "Add namespace" })).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
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
    expect(screen.queryByRole("button", { name: "Add key" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add namespace" })).toBeNull();
    // The value is text, not a control.
    expect(
      screen.queryByRole("button", { name: /Edit this value/ }),
    ).toBeNull();
  });

  it("sends an edit with the value it displayed as the expectation", async () => {
    const spy = vi
      .spyOn(api, "writeIssueMetadata")
      .mockResolvedValue({ entries: [] });
    mount([entry("orch", "phase", "plan")]);
    await openDialog();

    fireEvent.click(screen.getByTitle("Edit this value"));
    const input = await screen.findByLabelText("orch/phase");
    fireEvent.change(input, { target: { value: "impl" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0]?.[2]).toEqual({
      entries: [
        // `if_match` is the value on screen, so an edit over what a tool has
        // since written is refused instead of quietly winning.
        { namespace: "orch", key: "phase", value: "impl", if_match: "plan" },
      ],
    });
  });

  it("expects the value that was on screen when the edit began", async () => {
    const spy = vi
      .spyOn(api, "writeIssueMetadata")
      .mockResolvedValue({ entries: [] });
    const client = mount([entry("orch", "phase", "plan")]);
    await openDialog();
    fireEvent.click(screen.getByTitle("Edit this value"));
    const input = await screen.findByLabelText("orch/phase");
    fireEvent.change(input, { target: { value: "impl" } });

    // A tool writes to the same key mid-edit; the change feed refetches, and
    // the row re-renders around the open editor.
    client.setQueryData(issueMetadataQuery(SLUG, NUMBER).queryKey, {
      entries: [entry("orch", "phase", "spec")],
    });
    await waitFor(() =>
      expect(screen.getByLabelText("orch/phase")).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    // "plan", not "spec": an expectation read at save time would have become
    // the tool's own new value, and the save would have overwritten it —
    // which is the one thing if_match is here to stop.
    expect(spy.mock.calls[0]?.[2]).toEqual({
      entries: [
        { namespace: "orch", key: "phase", value: "impl", if_match: "plan" },
      ],
    });
  });

  it("deletes a key without a second confirmation", async () => {
    const spy = vi
      .spyOn(api, "writeIssueMetadata")
      .mockResolvedValue({ entries: [] });
    mount([entry("orch", "phase", "plan")]);
    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: "Delete orch/phase" }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0]?.[2]).toEqual({
      entries: [
        { namespace: "orch", key: "phase", value: null, if_match: "plan" },
      ],
    });
  });

  it("adds a key expecting it not to be there", async () => {
    const spy = vi
      .spyOn(api, "writeIssueMetadata")
      .mockResolvedValue({ entries: [] });
    mount([entry("orch", "phase", "plan")]);
    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));
    fireEvent.change(await screen.findByLabelText("New key in orch"), {
      target: { value: "owner" },
    });
    fireEvent.change(screen.getByLabelText("New value in orch"), {
      target: { value: "agent-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0]?.[2]).toEqual({
      entries: [
        { namespace: "orch", key: "owner", value: "agent-1", if_match: null },
      ],
    });
  });

  it("refuses an illegal namespace name before any request", async () => {
    const spy = vi
      .spyOn(api, "writeIssueMetadata")
      .mockResolvedValue({ entries: [] });
    mount([]);
    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: "Add namespace" }));
    fireEvent.change(await screen.findByLabelText("New namespace"), {
      target: { value: "Orch" },
    });
    fireEvent.change(screen.getByLabelText("First key of the new namespace"), {
      target: { value: "phase" },
    });
    expect(screen.getByText(/A namespace is lowercase/)).toBeTruthy();
    const add = screen.getByRole("button", {
      name: "Add",
    }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.click(add);
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports a lost race in place and never retries by itself", async () => {
    const conflict = Object.assign(new Error("if_match did not hold"), {
      status: 409,
      code: "metadata_precondition",
      details: {
        failed: [{ namespace: "orch", key: "phase", current: "spec" }],
      },
    });
    const spy = vi.spyOn(api, "writeIssueMetadata").mockRejectedValue(conflict);
    mount([entry("orch", "phase", "plan")]);
    await openDialog();

    fireEvent.click(screen.getByTitle("Edit this value"));
    fireEvent.change(await screen.findByLabelText("orch/phase"), {
      target: { value: "impl" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const notice = await screen.findByTestId("metadata-conflict");
    expect(notice.textContent).toContain("orch/phase");
    expect(notice.textContent).toContain("spec");
    // One attempt. What to do about a value someone else moved is the
    // reader's decision, so nothing is re-sent until they say so.
    expect(spy).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Write over the new value" }),
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls[1]?.[2]).toEqual({
      entries: [
        // Re-sent against what the server said is there now, not blindly.
        { namespace: "orch", key: "phase", value: "impl", if_match: "spec" },
      ],
    });
  });
});
