import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { IssueMetadataEntry, MemberRole, Project } from "@todou/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueMetadataQuery } from "../src/api/metadata.ts";
import { api, projectQuery } from "../src/api/queries.ts";
import { MetadataSection } from "../src/components/issue/metadata-section.tsx";
import { cmGetValue, cmSetValue } from "./cm.ts";
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

const entry = (
  namespace: string,
  key: string,
  value: string,
): IssueMetadataEntry => ({
  namespace,
  key,
  value,
  updated_at: hourAgo,
  updated_by: writer,
});

const project = (role: MemberRole) =>
  ({
    id: 1,
    slug: SLUG,
    name: "Project",
    viewer_role: role,
  }) as unknown as Project;

function mount(entries: IssueMetadataEntry[], role: MemberRole = "writer") {
  const client = testQueryClient();
  client.setQueryData(projectQuery(SLUG).queryKey, project(role));
  client.setQueryData(issueMetadataQuery(SLUG, NUMBER).queryKey, { entries });
  const rendered = renderWithProviders(
    <MetadataSection slug={SLUG} issueNumber={NUMBER} />,
    client,
  );
  return { client, unmount: rendered.unmount };
}

const openDialog = async () => {
  fireEvent.click(await screen.findByTestId("metadata-open"));
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
};

/** Radix tabs activate on mousedown, not click. */
const openTab = async (name: "Browse" | "Bulk" | "JSON") => {
  fireEvent.mouseDown(screen.getByRole("tab", { name }));
  await waitFor(() =>
    expect(screen.getByTestId("metadata-editor-tab")).toBeTruthy(),
  );
};

/**
 * Wait until the active panel's editor has mounted (the `.cm-content` the
 * mount effect produces), then return the editor host. The dialog portals
 * to document.body, which is the root cm.ts's selectors can see.
 */
const editorReady = async (): Promise<HTMLElement> => {
  await waitFor(() => {
    expect(
      screen.getByTestId("metadata-editor-tab").querySelector(".cm-content"),
    ).not.toBeNull();
  });
  return document.body;
};

describe("the metadata editor tabs", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("opens Bulk with the snapshot serialized into the editor", async () => {
    // S1. Falsifies by: the text starting empty instead of the serialized
    // snapshot.
    mount([entry("ci", "status", "passing"), entry("ci", "note", "hi")]);
    await openDialog();
    await openTab("Bulk");
    expect(cmGetValue(await editorReady())).toBe(
      "ci/status = passing\nci/note = hi",
    );
  });

  it("keeps a draft against a background refetch, snapshot intact", async () => {
    // S2. Falsifies by: dropping the dirty check — the refetch would
    // rewrite the text mid-edit.
    const spy = vi
      .spyOn(api, "writeIssueMetadata")
      .mockResolvedValue({ entries: [] });
    const { client } = mount([entry("orch", "phase", "plan")]);
    await openDialog();
    await openTab("Bulk");
    cmSetValue(await editorReady(), "orch/phase = impl");
    // A tool writes to the same key; the change feed refetches.
    client.setQueryData(issueMetadataQuery(SLUG, NUMBER).queryKey, {
      entries: [entry("orch", "phase", "spec")],
    });
    await waitFor(() =>
      expect(screen.getByTestId("metadata-counts").textContent).toBeTruthy(),
    );
    // The draft survives.
    expect(cmGetValue(await editorReady())).toBe("orch/phase = impl");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0]?.[2]).toEqual({
      entries: [
        // "plan" — the snapshot from when the tab opened, not the refetched
        // "spec": an expectation read at save time would overwrite the
        // tool's write, which is what if_match exists to stop.
        { namespace: "orch", key: "phase", value: "impl", if_match: "plan" },
      ],
    });
  });

  it("sends a deleted line as value null with the snapshot expectation", async () => {
    // S3 — the deletion direction through the save pipeline. Falsifies by:
    // dropping if_match from the deleted entry.
    const spy = vi
      .spyOn(api, "writeIssueMetadata")
      .mockResolvedValue({ entries: [] });
    mount([entry("orch", "phase", "plan"), entry("orch", "owner", "planner")]);
    await openDialog();
    await openTab("Bulk");
    cmSetValue(await editorReady(), "orch/phase = plan");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0]?.[2]).toEqual({
      entries: [
        { namespace: "orch", key: "owner", value: null, if_match: "planner" },
      ],
    });
  });

  it("deletes a JSON member the same way — one diff for both tabs", async () => {
    // S4. Falsifies by: giving the JSON tab its own diff path that loses
    // deletions.
    const spy = vi
      .spyOn(api, "writeIssueMetadata")
      .mockResolvedValue({ entries: [] });
    mount([entry("orch", "phase", "plan")]);
    await openDialog();
    await openTab("JSON");
    cmSetValue(await editorReady(), '{\n  "orch": {}\n}');
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0]?.[2]).toEqual({
      entries: [
        { namespace: "orch", key: "phase", value: null, if_match: "plan" },
      ],
    });
  });

  it("shows parse errors in place and never sends", async () => {
    // S5. Falsifies by: sending despite errors. The paired legal-input case
    // proves the spy itself works.
    const spy = vi
      .spyOn(api, "writeIssueMetadata")
      .mockResolvedValue({ entries: [] });
    mount([]);
    await openDialog();
    await openTab("Bulk");
    cmSetValue(await editorReady(), "Bad = line");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.getByTestId("metadata-editor-tab").textContent).toContain(
        "line 1",
      ),
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("is read-only for a reader, who sees no Save at all", async () => {
    // S6. Falsifies by: ignoring readOnly. The writer case proves the
    // pairing — same query, different role, different UI.
    const { unmount } = mount([entry("orch", "phase", "plan")], "reader");
    await openDialog();
    await openTab("JSON");
    await editorReady();
    const host = document
      .querySelector('[data-testid="metadata-editor-tab"]')
      ?.querySelector<HTMLElement>('[data-slot="code-editor"]');
    expect(host?.getAttribute("data-read-only")).toBe("true");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    // Writer pairing: the Save button exists for them. Unmount the reader
    // tree, remount as writer, reopen; the selector must find Save now.
    unmount();
    mount([entry("orch", "phase", "plan")], "writer");
    await openDialog();
    await openTab("JSON");
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("refuses a save above the 64-entry write cap without any request", async () => {
    // D9. Falsifies by: truncating or dropping the cap check — the save
    // would then go out (possibly 400ing at the server, or silently
    // dropping entries) instead of refusing in place. The spy pair proves
    // refusal was the panel's own decision, not a network failure.
    const spy = vi
      .spyOn(api, "writeIssueMetadata")
      .mockResolvedValue({ entries: [] });
    // 40 existing keys stay untouched; the text adds 30 more, so the diff
    // is 30 > 64? No — make it 65: 64 untouched keys deleted + 1 addition
    // would still exceed. Simplest: keep 30 untouched keys and add 35 new
    // ones, giving a 35-entry diff... that is under the cap. Build a diff
    // over the cap directly: 60 kept, 5 deleted, 10 added = 15 < 64. So:
    // 70 snapshot keys, text deletes all 70 and adds 0 → 70 > 64.
    const keys = Array.from({ length: 70 }, (_, i) =>
      entry("ci", `k${i}`, `v${i}`),
    );
    mount(keys);
    await openDialog();
    await openTab("Bulk");
    // Empty the document: every one of the 70 keys is deleted.
    cmSetValue(await editorReady(), "");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.getByTestId("metadata-editor-tab").textContent).toContain(
        "70 entries",
      ),
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("drops the draft when switching tabs and back", async () => {
    // S7. Falsifies by: force-mounting both panels so the draft survives.
    mount([entry("orch", "phase", "plan")]);
    await openDialog();
    await openTab("Bulk");
    cmSetValue(await editorReady(), "orch/phase = typed-but-unsaved");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Browse" }));
    await waitFor(() =>
      expect(screen.queryByTestId("metadata-editor-tab")).toBeNull(),
    );
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Bulk" }));
    await waitFor(async () => {
      expect(await editorReady().then((h) => cmGetValue(h))).toBe(
        "orch/phase = plan",
      );
    });
  });
});

describe("the metadata dialog shell", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("counts namespaces and keys separately", async () => {
    // X1. Falsifies by: counting only namespaces.
    mount([
      entry("ci", "run", "green"),
      entry("orch", "owner", "planner"),
      entry("orch", "phase", "plan"),
    ]);
    await openDialog();
    expect(screen.getByTestId("metadata-counts").textContent).toBe(
      "2 namespaces · 3 keys",
    );
  });

  it("has no description line under the title", async () => {
    // X2. Falsifies by: leaving the old description in place. Paired with
    // the title assertion, which proves the dialog rendered at all.
    mount([entry("orch", "phase", "plan")]);
    await openDialog();
    expect(screen.getByRole("dialog").textContent).toContain("Metadata");
    expect(screen.queryByText("These values are written by tools")).toBeNull();
  });

  it("words a deletion 409 by what happened, and retry expects current", async () => {
    // X3 — deletion-direction conflict. Falsifies by: re-sending without
    // the value; the re-sent payload must still be a delete.
    const conflict = Object.assign(new Error("if_match did not hold"), {
      status: 409,
      code: "metadata_precondition",
      details: {
        failed: [{ namespace: "orch", key: "phase", current: "spec" }],
      },
    });
    const spy = vi
      .spyOn(api, "writeIssueMetadata")
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ entries: [] });
    mount([entry("orch", "phase", "plan"), entry("orch", "owner", "old")]);
    await openDialog();
    // Delete one key from Browse.
    fireEvent.click(screen.getByRole("button", { name: "Delete orch/phase" }));
    const notice = await screen.findByTestId("metadata-conflict");
    expect(notice.textContent).toContain('changed to "spec"');
    expect(spy).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Write over the new value" }),
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls[1]?.[2]).toEqual({
      entries: [
        // Still a deletion — only the expectation moved to what is there.
        { namespace: "orch", key: "phase", value: null, if_match: "spec" },
      ],
    });
    // Success clears the notice.
    await waitFor(() =>
      expect(screen.queryByTestId("metadata-conflict")).toBeNull(),
    );
  });

  it("words an already-deleted 409, and the retry sends if_match null", async () => {
    // X3's second branch: the key was deleted by someone else while we were
    // deleting it. The server treats `{value: null, if_match: null}` as
    // "expect absent, delete" and answers unchanged — so the retry must
    // send exactly that, and the notice must clear afterwards.
    const conflict = Object.assign(new Error("if_match did not hold"), {
      status: 409,
      code: "metadata_precondition",
      details: {
        failed: [{ namespace: "orch", key: "phase", current: null }],
      },
    });
    const spy = vi
      .spyOn(api, "writeIssueMetadata")
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ entries: [] });
    mount([entry("orch", "phase", "plan")]);
    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: "Delete orch/phase" }));
    const notice = await screen.findByTestId("metadata-conflict");
    expect(notice.textContent).toContain("already deleted");
    expect(spy).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Write over the new value" }),
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls[1]?.[2]).toEqual({
      entries: [
        // Still a deletion; the expectation dropped to null because there
        // is nothing there to match.
        { namespace: "orch", key: "phase", value: null, if_match: null },
      ],
    });
    await waitFor(() =>
      expect(screen.queryByTestId("metadata-conflict")).toBeNull(),
    );
  });

  it("retries a Bulk-saved 409 against the server's current", async () => {
    // Defect-2 regression: the conflict notice used to render from the
    // panel's mutation while the retry button drove the dialog's own state,
    // which had never seen the refused write — clicking the button did
    // nothing. Falsifies by: any regression that decouples the notice from
    // the retry's payload again.
    const conflict = Object.assign(new Error("if_match did not hold"), {
      status: 409,
      code: "metadata_precondition",
      details: {
        failed: [{ namespace: "orch", key: "phase", current: "spec" }],
      },
    });
    const spy = vi
      .spyOn(api, "writeIssueMetadata")
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ entries: [] });
    mount([entry("orch", "phase", "plan")]);
    await openDialog();
    await openTab("Bulk");
    cmSetValue(await editorReady(), "orch/phase = impl");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByTestId("metadata-conflict");
    expect(spy).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Write over the new value" }),
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls[1]?.[2]).toEqual({
      entries: [
        { namespace: "orch", key: "phase", value: "impl", if_match: "spec" },
      ],
    });
  });

  it("shows a non-409 save error on the panel that made it", async () => {
    // Defect-3 regression. Falsifies by: swallowing non-409 errors again —
    // a network failure or 500 would leave the reader staring at a silent
    // editor.
    const spy = vi
      .spyOn(api, "writeIssueMetadata")
      .mockRejectedValue(new Error("the server is on fire"));
    mount([entry("orch", "phase", "plan")]);
    await openDialog();
    await openTab("JSON");
    cmSetValue(await editorReady(), '{\n  "orch": {"phase": "impl"}\n}');
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.getByTestId("metadata-editor-tab").textContent).toContain(
        "the server is on fire",
      ),
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("hides every write affordance from a reader, shows all to a writer", async () => {
    // X4 — the paired absence assertions. Falsifies by: rendering the group
    // header entries for readers too. The reader's three queryBy assertions
    // below are the actual drill surface; the writer half proves the
    // selectors can match, so a broken query cannot fake the absences.
    const { unmount: unmountReader } = mount(
      [entry("orch", "phase", "plan")],
      "reader",
    );
    await openDialog();
    expect(
      screen.queryByRole("button", { name: "Add key in orch" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Delete namespace orch" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Edit orch/phase in Bulk" }),
    ).toBeNull();
    unmountReader();
    mount([entry("orch", "phase", "plan")], "writer");
    await openDialog();
    expect(
      screen.getByRole("button", { name: "Add key in orch" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Delete namespace orch" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Edit orch/phase in Bulk" }),
    ).toBeTruthy();
  });

  it("reports an addition 409 once and never retries by itself", async () => {
    // X5. Falsifies by: auto-retrying the write.
    const conflict = Object.assign(new Error("if_match did not hold"), {
      status: 409,
      code: "metadata_precondition",
      details: {
        failed: [{ namespace: "orch", key: "new", current: "agent-1" }],
      },
    });
    const spy = vi.spyOn(api, "writeIssueMetadata").mockRejectedValue(conflict);
    mount([]);
    await openDialog();
    await openTab("Bulk");
    cmSetValue(await editorReady(), "orch/new = agent-1");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const notice = await screen.findByTestId("metadata-conflict");
    expect(notice.textContent).toContain("now exists");
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    // A beat later: still exactly one attempt.
    await new Promise((r) => setTimeout(r, 50));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
