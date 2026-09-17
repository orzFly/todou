import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { IssueMetadataEntry, MemberRole, Project } from "@todou/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueMetadataQuery } from "../src/api/metadata.ts";
import { api, projectQuery } from "../src/api/queries.ts";
import { MetadataDialog } from "../src/components/issue/metadata-dialog.tsx";
import { MetadataSection } from "../src/components/issue/metadata-section.tsx";
import { hasUnsavedWork } from "../src/lib/unsaved-guard.ts";
import { cmGetValue, cmSetValue } from "./cm.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";

vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  toast: { success: vi.fn(), error: vi.fn() },
}));
const { toast } = await import("sonner");

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

/** Whichever door the section is offering: the summary block on a card with
 *  metadata, the heading's button on an empty one, which since T-403 draws no
 *  summary to click. These tests are about the dialog, not the way in. */
const openDialog = async () => {
  const summary = screen.queryByTestId("metadata-open");
  fireEvent.click(
    summary ?? (await screen.findByRole("button", { name: "Edit metadata" })),
  );
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
    // restoreAllMocks does not clear factory vi.fn()s — without this the
    // previous test's toast calls land on the next test's account.
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  it("opens Bulk with the snapshot serialized into the editor", async () => {
    // S1. Falsifies by: the text starting empty instead of the serialized
    // snapshot.
    mount([entry("ci", "status", "passing"), entry("ci", "note", "hi")]);
    await openDialog();
    await openTab("Bulk");
    expect(cmGetValue(await editorReady())).toBe(
      // docRows renders the document in (ns, key) order — the same order a
      // save round-trip produces.
      "ci/note = hi\nci/status = passing",
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
    // 70 snapshot keys, emptied text: the diff is 70 deletions, over the
    // 64-entry write cap.
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

  it("carries a Bulk draft into JSON", async () => {
    // Replaces T-300's "a switch drops the draft": one document, two
    // spellings. Falsifies by: dropping the session carry — the JSON tab
    // would render the server's "plan", and the two serialized texts are
    // both non-empty and distinct, so toBe cannot pass by accident.
    mount([entry("orch", "phase", "plan")]);
    await openDialog();
    await openTab("Bulk");
    cmSetValue(await editorReady(), "orch/phase = impl");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "JSON" }));
    await editorReady();
    expect(cmGetValue(document.body)).toBe(
      `${JSON.stringify({ orch: { phase: "impl" } }, null, 2)}\n`,
    );
  });

  it("carries a JSON draft back into Bulk", async () => {
    // The reverse pairing — a one-way implementation fails exactly one of
    // the two carries.
    mount([entry("orch", "phase", "plan")]);
    await openDialog();
    await openTab("JSON");
    cmSetValue(
      await editorReady(),
      '{\n  "orch": {\n    "phase": "impl"\n  }\n}',
    );
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Bulk" }));
    await editorReady();
    expect(cmGetValue(document.body)).toBe("orch/phase = impl");
  });

  it("normalises order when it carries", async () => {
    // Falsifies by: carrying raw text instead of re-rendering the document —
    // the namespaces would stay in the typed order.
    mount([entry("orch", "x", "1"), entry("ci", "a", "2")]);
    await openDialog();
    await openTab("Bulk");
    cmSetValue(await editorReady(), "orch/x = 1\nci/a = 2");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "JSON" }));
    await editorReady();
    const text = cmGetValue(document.body);
    expect(text.indexOf('"ci"')).toBeGreaterThan(-1);
    expect(text.indexOf('"ci"')).toBeLessThan(text.indexOf('"orch"'));
  });

  it("refuses to leave a tab whose text does not parse", async () => {
    // The gate's parse half. Falsifies by: removing the gate — the JSON
    // trigger activates and the broken text disappears. The last two steps
    // pin the clearing rule: an edit removes the rejection, and the same
    // switch then goes through.
    mount([entry("orch", "phase", "plan")]);
    await openDialog();
    await openTab("Bulk");
    cmSetValue(await editorReady(), "Bad = line");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "JSON" }));
    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: "JSON" }).getAttribute("aria-selected"),
      ).toBe("false");
    });
    expect(cmGetValue(await editorReady())).toBe("Bad = line");
    await waitFor(() => {
      // The rejection names the problem at its line.
      expect(screen.getByTestId("metadata-editor-tab").textContent).toContain(
        "line 1",
      );
    });
    // An edit clears the stale rejection (design: the reader acted on it),
    // and once the text is legal the gate lets the same switch through.
    cmSetValue(await editorReady(), "orch/phase = impl");
    await waitFor(() => {
      expect(
        screen.getByTestId("metadata-editor-tab").textContent,
      ).not.toContain("Cannot switch tabs");
    });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "JSON" }));
    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: "JSON" }).getAttribute("aria-selected"),
      ).toBe("true");
    });
  });

  it("refuses to leave when a value is over the size limit", async () => {
    // The gate's precheck half — the boundary between "validate" and
    // "parse". Falsifies by: gating on parse only, which accepts the
    // oversized value and lets the switch through.
    mount([entry("orch", "phase", "plan")]);
    await openDialog();
    await openTab("Bulk");
    cmSetValue(await editorReady(), `orch/big = ${"x".repeat(4097)}`);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "JSON" }));
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "JSON" }).getAttribute("aria-selected"),
      ).toBe("false"),
    );
    expect(screen.getByTestId("metadata-editor-tab").textContent).toContain(
      "4097 bytes",
    );
  });

  it("keeps the session snapshot across a tab switch", async () => {
    // T-300's S2 across tabs. Falsifies by: re-capturing the snapshot at
    // mount in the target panel — if_match becomes the refetched "spec"
    // and a save silently overwrites the tool's write.
    const spy = vi
      .spyOn(api, "writeIssueMetadata")
      .mockResolvedValue({ entries: [] });
    const { client } = mount([entry("orch", "phase", "plan")]);
    await openDialog();
    await openTab("Bulk");
    cmSetValue(await editorReady(), "orch/phase = impl");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "JSON" }));
    await editorReady();
    client.setQueryData(issueMetadataQuery(SLUG, NUMBER).queryKey, {
      entries: [entry("orch", "phase", "spec")],
    });
    await waitFor(() =>
      expect(screen.getByTestId("metadata-counts").textContent).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0]?.[2]).toEqual({
      entries: [
        { namespace: "orch", key: "phase", value: "impl", if_match: "plan" },
      ],
    });
  });

  it("refuses Browse while the document differs from the snapshot", async () => {
    // The Browse lock. Falsifies by: removing the dirty check — Browse
    // activates and the panel unmounts, destroying the draft. Every
    // assertion names a concrete value: "false", mounted, message text.
    mount([entry("orch", "phase", "plan")]);
    await openDialog();
    await openTab("Bulk");
    cmSetValue(await editorReady(), "orch/phase = impl");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Browse" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("tab", { name: "Browse" })
          .getAttribute("aria-selected"),
      ).toBe("false"),
    );
    expect(screen.queryByTestId("metadata-editor-tab")).not.toBeNull();
    expect(screen.getByTestId("metadata-editor-tab").textContent).toContain(
      "save or discard",
    );
  });

  it("lets Browse back in once the text equals the snapshot again", async () => {
    // Pairs with the refusal above — without it, an always-refusing gate
    // would pass that test. Falsifies by: using "typed anything" as the
    // dirty test — the key was touched and restored, so the lock would
    // never lift.
    mount([entry("orch", "phase", "plan")]);
    await openDialog();
    await openTab("Bulk");
    cmSetValue(await editorReady(), "orch/phase = impl");
    cmSetValue(await editorReady(), "orch/phase = plan");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Browse" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("tab", { name: "Browse" })
          .getAttribute("aria-selected"),
      ).toBe("true"),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("metadata-editor-tab")).toBeNull(),
    );
  });

  it("Discard restores the server's current values and unlocks Browse", async () => {
    // Falsifies by: not remounting the editor (key unchanged) — CodeEditor
    // reads initialValue only at mount, so the text would stay "impl".
    mount([entry("orch", "phase", "plan")]);
    await openDialog();
    await openTab("Bulk");
    cmSetValue(await editorReady(), "orch/phase = impl");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(async () => {
      expect(await editorReady().then((h) => cmGetValue(h))).toBe(
        "orch/phase = plan",
      );
    });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Browse" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("tab", { name: "Browse" })
          .getAttribute("aria-selected"),
      ).toBe("true"),
    );
  });

  it("Discard on a clean document changes nothing", async () => {
    // Falsifies by: a discard that clears the editor or errors.
    mount([entry("orch", "phase", "plan")]);
    await openDialog();
    await openTab("Bulk");
    await editorReady();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(async () => {
      expect(await editorReady().then((h) => cmGetValue(h))).toBe(
        "orch/phase = plan",
      );
    });
    expect(screen.getByTestId("metadata-editor-tab").textContent).not.toContain(
      "line 1",
    );
  });

  it("shows Discard only to writers", async () => {
    // The absence half alone cannot stand — a broken selector would fake
    // it. The writer pairing proves the selector matches a real button.
    const { unmount } = mount([entry("orch", "phase", "plan")], "reader");
    await openDialog();
    await openTab("JSON");
    await editorReady();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    unmount();
    mount([entry("orch", "phase", "plan")], "writer");
    await openDialog();
    await openTab("JSON");
    expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy();
  });
});

describe("the metadata dialog shell", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
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
    // The retry is a successful write, so it gets the same receipt.
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Saved 1 entry"),
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

  it("leaves no stale panel error behind after a successful retry", async () => {
    // Nit-1 regression: the 409 used to render twice — once as the panel's
    // technical line, once as the shell's notice — and the panel's copy
    // survived a successful retry, because the retry runs on the shell's
    // mutation, which cannot clear the panel's error. Falsifies by:
    // restoring the panel-side 409 report.
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
    // While the 409 stands, the notice is the only reporter.
    expect(screen.getByTestId("metadata-editor-tab").textContent).not.toContain(
      "if_match did not hold",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Write over the new value" }),
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    // The write landed; no trace of the failure may remain anywhere.
    await waitFor(() =>
      expect(screen.queryByTestId("metadata-conflict")).toBeNull(),
    );
    expect(screen.getByTestId("metadata-editor-tab").textContent).not.toContain(
      "if_match did not hold",
    );
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

  it("still counts as unsaved work after the draft moves to JSON", async () => {
    // The guard must ride the session, not the panel: the JSON editor's
    // baseline IS the carried draft, so a panel-local dirty check would
    // report clean exactly when the work is most exposed. Falsifies by:
    // keeping the old editor-level registration — the middle assertion
    // returns false after the switch. The assertions mix true and false,
    // so a constant predicate cannot pass either.
    mount([entry("orch", "phase", "plan")]);
    await openDialog();
    await openTab("Bulk");
    cmSetValue(await editorReady(), "orch/phase = impl");
    expect(hasUnsavedWork()).toBe(true);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "JSON" }));
    await editorReady();
    expect(hasUnsavedWork()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(hasUnsavedWork()).toBe(false));
  });

  it("a second save expects what the first one wrote", async () => {
    // The snapshot must advance on success. Falsifies by: leaving the
    // snapshot frozen at session open — the second save goes out with the
    // first save's predecessor as its expectation and 409s (measured on
    // the pre-fix tree: comment-4054).
    const spy = vi
      .spyOn(api, "writeIssueMetadata")
      .mockResolvedValue({ entries: [] });
    mount([entry("orch", "phase", "plan")]);
    await openDialog();
    await openTab("Bulk");
    cmSetValue(await editorReady(), "orch/phase = impl");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    cmSetValue(await editorReady(), "orch/phase = ship");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls[1]?.[2]).toEqual({
      entries: [
        { namespace: "orch", key: "phase", value: "ship", if_match: "impl" },
      ],
    });
  });

  it("a save after a successful retry expects what the retry wrote", async () => {
    // The retry path must fold the snapshot too — the same defect in a
    // second place. Falsifies by: folding panel saves but not retries — the
    // last if_match would still be the pre-conflict value.
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
      .mockResolvedValue({ entries: [] });
    mount([entry("orch", "phase", "plan")]);
    await openDialog();
    await openTab("Bulk");
    cmSetValue(await editorReady(), "orch/phase = impl");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByTestId("metadata-conflict");
    fireEvent.click(
      screen.getByRole("button", { name: "Write over the new value" }),
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    cmSetValue(await editorReady(), "orch/phase = ship");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
    expect(spy.mock.calls[2]?.[2]).toEqual({
      entries: [
        // The retry folded "impl" into the snapshot — the value the server
        // now holds, which is exactly what this save must expect.
        { namespace: "orch", key: "phase", value: "ship", if_match: "impl" },
      ],
    });
  });

  it("toasts after a Bulk save", async () => {
    // The toast is the write's receipt. Falsifies by: dropping the toast
    // call — zero invocations. The exact string also fails a plural slip.
    const spy = vi
      .spyOn(api, "writeIssueMetadata")
      .mockResolvedValue({ entries: [] });
    mount([entry("orch", "phase", "plan")]);
    await openDialog();
    await openTab("Bulk");
    cmSetValue(await editorReady(), "orch/phase = impl");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Saved 1 entry"),
    );
  });

  it("toasts after a Browse delete", async () => {
    // Every successful write gets a receipt, Browse deletions included.
    // Falsifies by: toasting only on the panel Save — this path never
    // touches the panel.
    const spy = vi
      .spyOn(api, "writeIssueMetadata")
      .mockResolvedValue({ entries: [] });
    mount([entry("orch", "phase", "plan"), entry("orch", "owner", "old")]);
    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: "Delete orch/phase" }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Saved 1 entry"),
    );
  });

  it("does not toast when the save fails", async () => {
    // The receipt belongs in onSuccess. Falsifies by: toasting in onSettled
    // — a failure would fire it too. The paired success tests prove the
    // spy can fire, so the absence here is not a broken selector.
    vi.spyOn(api, "writeIssueMetadata").mockRejectedValue(
      new Error("the server is on fire"),
    );
    mount([entry("orch", "phase", "plan")]);
    await openDialog();
    await openTab("Bulk");
    cmSetValue(await editorReady(), "orch/phase = impl");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.getByTestId("metadata-editor-tab").textContent).toContain(
        "the server is on fire",
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe("the metadata dialog when /metadata fails (T-376)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /** The sidebar withholds `metadata-open` while the query fails, so the
   * dialog is mounted directly — the same component the trigger opens,
   * and the same query the section observes. */
  function mountOpenDialogFailing() {
    const get = vi
      .spyOn(api, "getIssueMetadata")
      .mockRejectedValue(new Error("metadata unreachable"));
    const client = testQueryClient();
    client.setQueryData(projectQuery(SLUG).queryKey, project("writer"));
    renderWithProviders(
      <MetadataDialog
        slug={SLUG}
        issueNumber={NUMBER}
        open={true}
        onOpenChange={() => {}}
      />,
      client,
    );
    return get;
  }

  it("says nothing it cannot know: no counts, no empty-card sentence, Add stays", async () => {
    mountOpenDialogFailing();
    // A failed read produced no numbers and established no emptiness.
    expect(await screen.findByText("Failed to load metadata.")).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByTestId("metadata-counts")).toBeNull(),
    );
    expect(
      screen.queryByText("Nothing has been written on this card."),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    // Bulk/JSON stay writable: an empty editor is a draft, not a claim,
    // and a blind new-key write is fenced by if_match on the server.
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
  });

  it("turns both assertions back into facts when Retry succeeds", async () => {
    const get = mountOpenDialogFailing();
    await screen.findByText("Failed to load metadata.");
    get.mockResolvedValue({
      entries: [entry("ci", "run", "green"), entry("orch", "phase", "plan")],
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    // Real counts for a real read...
    expect(screen.getByTestId("metadata-counts").textContent).toContain(
      "2 namespaces",
    );
    expect(screen.getByTestId("metadata-counts").textContent).toContain(
      "2 keys",
    );
    // ...and Browse renders the entries instead of either sentence.
    expect(screen.getByTestId("metadata-group-ci").textContent).toContain(
      "green",
    );
    expect(screen.queryByText("Failed to load metadata.")).toBeNull();
  });
});
