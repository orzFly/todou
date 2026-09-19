import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RevisionHistory,
  toDiffFiles,
} from "../src/components/shared/revision-history.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";
import { expectVisible } from "./visibility.ts";

vi.mock("@pierre/diffs/react", () => ({
  MultiFileDiff: ({
    oldFile,
    newFile,
    options,
  }: {
    oldFile: { name: string; contents: string };
    newFile: { name: string; contents: string };
    options?: { overflow?: string };
  }) => (
    <div
      data-testid="revision-diff"
      data-overflow={options?.overflow ?? "unset"}
      data-options={JSON.stringify(options)}
      data-old-file={JSON.stringify(oldFile)}
      data-new-file={JSON.stringify(newFile)}
    >
      {oldFile.contents} → {newFile.contents}
    </div>
  ),
}));

const HISTORY_WRAP_KEY = "todou-edit-history-wrap";

beforeEach(() => {
  localStorage.removeItem(HISTORY_WRAP_KEY);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.removeItem(HISTORY_WRAP_KEY);
});

/**
 * Make this key's storage access fail, the only way that actually works here:
 * happy-dom's `localStorage` is a Proxy that binds each method onto the
 * instance the first time anything touches it, so a `Storage.prototype` spy
 * installed by a later test never fires — it records no calls and the real
 * method keeps running. A spy on the instance does fire, but the Proxy
 * refuses the `delete` that restores it, leaving the mock in place for the
 * rest of the file. Swapping the global is reversible and reaches the
 * component, which resolves `localStorage` at call time.
 *
 * Every other key is delegated to the real storage: the theme and the router
 * read it while the dialog mounts.
 */
function denyStorage({ read = false, write = false }) {
  const real = globalThis.localStorage;
  const attemptedWrites: Array<[string, string]> = [];
  vi.stubGlobal("localStorage", {
    getItem(key: string) {
      if (read && key === HISTORY_WRAP_KEY)
        throw new Error("storage read denied");
      return real.getItem(key);
    },
    setItem(key: string, value: string) {
      if (key !== HISTORY_WRAP_KEY) return real.setItem(key, value);
      attemptedWrites.push([key, value]);
      if (write) throw new Error("storage write denied");
      real.setItem(key, value);
    },
    removeItem: (key: string) => real.removeItem(key),
    clear: () => real.clear(),
  });
  return attemptedWrites;
}

const revision = {
  id: 3,
  actor: {
    id: 1,
    login: "user",
    display_name: "User",
    kind: "human" as const,
    avatar_url: null,
    owner: null,
  },
  created_at: "2026-08-12T10:00:00Z",
  body_before: "old text",
  body_after: "new text",
  agent_context: null,
};

const historyEntries = [
  {
    label: "comment",
    filename: "comment.md",
    queryKey: ["revisions", "demo", 1, "comment", 17],
  },
  {
    label: "description",
    filename: "description.md",
    queryKey: ["revisions", "demo", 1, "issue_body"],
  },
];

type HistoryEntry = (typeof historyEntries)[number];

function renderHistory(
  entry: HistoryEntry = historyEntries[0],
  items = [revision],
) {
  const client = testQueryClient();
  const fetchRevisions = vi.fn().mockResolvedValue({ items });
  const view = renderWithProviders(
    <RevisionHistory
      {...entry}
      editedAt={items[0].created_at}
      fetchRevisions={fetchRevisions}
    />,
    client,
  );
  return { ...view, client, fetchRevisions };
}

async function openHistoryDiff(
  entry: HistoryEntry,
  trigger: HTMLElement,
  actor = "User",
) {
  // Read the trigger's real state rather than clicking blind: a click on an
  // already-open list would close it. U4b pins which way round that is.
  if (trigger.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(trigger);
  }
  const popover = await screen.findByRole("dialog", { name: "" });
  const row = await within(popover).findByRole("button", {
    name: new RegExp(actor),
  });
  expect(row.querySelector("button, [role='button']")).toBeNull();
  fireEvent.click(row);
  const dialog = await screen.findByRole("dialog", {
    name: `Edit history — ${entry.label}`,
  });
  await within(dialog).findByTestId("revision-diff");
  return dialog;
}

async function closeHistoryDiff(dialog: HTMLElement, trigger: HTMLElement) {
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(dialog.isConnected).toBe(false));
  if (trigger.getAttribute("aria-expanded") === "true") {
    fireEvent.click(trigger);
  }
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "" })).toBeNull(),
  );
}

async function expectHistoryMode(dialog: HTMLElement, wrap: boolean) {
  await waitFor(() => {
    expect(
      within(dialog).getByTestId("revision-diff").getAttribute("data-overflow"),
    ).toBe(wrap ? "wrap" : "scroll");
    expect(
      within(dialog)
        .getByRole("button", { name: "wrap long lines" })
        .getAttribute("aria-pressed"),
    ).toBe(String(wrap));
  });
}

function toggleHistoryWrap(dialog: HTMLElement) {
  fireEvent.click(
    within(dialog).getByRole("button", { name: "wrap long lines" }),
  );
}

function expectHistoryFiles(
  dialog: HTMLElement,
  selected: typeof revision,
  filename: string,
) {
  const diff = within(dialog).getByTestId("revision-diff");
  // JSON transports the exact props through the stub without DOM text
  // whitespace normalization, trimming, or a simulated wrapping algorithm.
  expect(JSON.parse(diff.getAttribute("data-old-file") ?? "null")).toEqual({
    name: filename,
    contents: selected.body_before,
  });
  expect(JSON.parse(diff.getAttribute("data-new-file") ?? "null")).toEqual({
    name: filename,
    contents: selected.body_after,
  });
}

describe("toDiffFiles", () => {
  it("maps a revision's sides onto named diff inputs", () => {
    expect(toDiffFiles(revision, "comment.md")).toEqual({
      oldFile: { name: "comment.md", contents: "old text" },
      newFile: { name: "comment.md", contents: "new text" },
    });
  });

  it("keeps both sides even when one is empty", () => {
    const emptied = { ...revision, body_after: "" };
    const { newFile } = toDiffFiles(emptied, "description.md");
    expect(newFile.contents).toBe("");
  });
});

describe("RevisionHistory · load failure (T-376)", () => {
  it("offers Retry inside the popover and lists revisions on success", async () => {
    const fetchRevisions = vi
      .fn()
      .mockRejectedValueOnce(new Error("history store gone"))
      .mockResolvedValueOnce({ items: [revision] });
    renderWithProviders(
      <RevisionHistory
        label="comment"
        editedAt="2026-08-12T10:00:00Z"
        filename="comment.md"
        queryKey={["revisions", "comment", 1]}
        fetchRevisions={fetchRevisions}
      />,
    );

    fireEvent.click(await screen.findByText("(edited)"));
    expect(
      (await screen.findByText(/Failed to load history/)).closest(
        '[role="status"]',
      )?.className,
    ).toContain("text-xs");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    // The refetch re-issues this section's own fetch — one more call, and
    // the recovered list renders the revision's author.
    await waitFor(() => expect(fetchRevisions).toHaveBeenCalledTimes(2));
    await screen.findByText("User");
    expect(screen.queryByText(/Failed to load history/)).toBeNull();
  });
});

describe("RevisionHistory · warm-cache refresh failure", () => {
  it("keeps the revision row and its diff usable alongside a small Retry notice", async () => {
    const queryKey = ["revisions", "comment", 3];
    const client = testQueryClient();
    const fetchRevisions = vi.fn().mockResolvedValue({ items: [revision] });
    renderWithProviders(
      <RevisionHistory
        label="comment"
        editedAt={revision.created_at}
        filename="comment.md"
        queryKey={queryKey}
        fetchRevisions={fetchRevisions}
      />,
      client,
    );

    fireEvent.click(await screen.findByText("(edited)"));
    const popover = screen.getByRole("dialog");
    const row = await within(popover).findByRole("button", { name: /User/ });
    expect(within(row).getByText("User")).toBeTruthy();
    expect(within(row).getByTitle(revision.created_at).textContent).toBe(
      new Date(revision.created_at).toLocaleString(),
    );
    await waitFor(() =>
      expect(client.getQueryState(queryKey)?.fetchStatus).toBe("idle"),
    );
    expect(fetchRevisions).toHaveBeenCalledTimes(1);

    fetchRevisions.mockRejectedValue(
      Object.assign(new Error("HTTP 500"), { status: 500 }),
    );
    await act(async () => {
      await client.refetchQueries({ queryKey, exact: true });
    });
    await waitFor(() => expect(fetchRevisions).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(client.getQueryState(queryKey)?.fetchStatus).toBe("idle"),
    );

    // Check the actual cached row before the notice: an error-only
    // replacement must fail here even if it offers Retry.
    const retainedRow = within(popover).getByRole("button", { name: /User/ });
    expectVisible(within(retainedRow).getByText("User"));
    expectVisible(within(retainedRow).getByTitle(revision.created_at));
    expect(
      within(retainedRow).getByTitle(revision.created_at).textContent,
    ).toBe(new Date(revision.created_at).toLocaleString());
    const notice = await within(popover).findByText(
      /Couldn't refresh .*history/,
    );
    expect(notice.textContent).toContain("HTTP 500");
    const status = notice.closest('[role="status"]') as HTMLElement;
    expect(status.className).toContain("text-xs");
    expect(within(status).getByRole("button", { name: "Retry" })).toBeTruthy();

    fireEvent.click(retainedRow);
    const diffDialog = await screen.findByRole("dialog", {
      name: "Edit history — comment",
    });
    expect(
      (await within(diffDialog).findByTestId("revision-diff")).textContent,
    ).toContain("old text → new text");
  });
});

describe("RevisionHistory · refresh edge cases", () => {
  it("keeps an empty successful history and its explanation under a 500 refresh notice", async () => {
    const queryKey = ["revisions", "comment", 4];
    const client = testQueryClient();
    const fetchRevisions = vi.fn().mockResolvedValue({ items: [] });
    renderWithProviders(
      <RevisionHistory
        label="comment"
        editedAt={revision.created_at}
        filename="comment.md"
        queryKey={queryKey}
        fetchRevisions={fetchRevisions}
      />,
      client,
    );

    fireEvent.click(await screen.findByText("(edited)"));
    const popover = screen.getByRole("dialog");
    await within(popover).findByText("This edit history predates tracking.");
    await waitFor(() =>
      expect(client.getQueryState(queryKey)?.fetchStatus).toBe("idle"),
    );
    expect(client.getQueryData(queryKey)).toEqual({ items: [] });

    fetchRevisions.mockRejectedValue(
      Object.assign(new Error("HTTP 500"), { status: 500 }),
    );
    await act(async () => {
      await client.refetchQueries({ queryKey, exact: true });
    });
    await waitFor(() =>
      expect(client.getQueryState(queryKey)?.fetchStatus).toBe("idle"),
    );

    expect(
      within(popover).getByText("This edit history predates tracking."),
    ).toBeTruthy();
    expect(within(popover).queryByText(/Failed to load history/)).toBeNull();
    const status = within(popover).getByRole("status");
    expect(status.textContent).toContain("Couldn't refresh");
    expect(status.textContent).toContain("HTTP 500");
    expect(status.className).toContain("text-xs");
    expect(within(status).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(client.getQueryData(queryKey)).toEqual({ items: [] });
  });

  it.each([403, 404])("hides a warm actor after a %i refresh", async (code) => {
    const queryKey = ["revisions", "comment", code];
    const client = testQueryClient();
    const fetchRevisions = vi.fn().mockResolvedValue({ items: [revision] });
    renderWithProviders(
      <RevisionHistory
        label="comment"
        editedAt={revision.created_at}
        filename="comment.md"
        queryKey={queryKey}
        fetchRevisions={fetchRevisions}
      />,
      client,
    );

    fireEvent.click(await screen.findByText("(edited)"));
    const popover = screen.getByRole("dialog");
    await within(popover).findByRole("button", { name: /User/ });
    await waitFor(() =>
      expect(client.getQueryState(queryKey)?.fetchStatus).toBe("idle"),
    );

    fetchRevisions.mockRejectedValue(
      Object.assign(new Error(`HTTP ${code}`), { status: code }),
    );
    await act(async () => {
      await client.refetchQueries({ queryKey, exact: true });
    });
    const failure = await within(popover).findByText(
      `Failed to load history: HTTP ${code}`,
    );
    expect(within(popover).queryByRole("button", { name: /User/ })).toBeNull();
    expect(within(popover).queryByText(/Couldn't refresh/)).toBeNull();
    const status = failure.closest('[role="status"]') as HTMLElement;
    expect(status.className).toContain("text-xs");
    expect(within(status).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(fetchRevisions).toHaveBeenCalledTimes(2);
  });

  it("keeps a warm actor without a notice after a 401 refresh", async () => {
    const queryKey = ["revisions", "comment", 401];
    const client = testQueryClient();
    const fetchRevisions = vi.fn().mockResolvedValue({ items: [revision] });
    renderWithProviders(
      <RevisionHistory
        label="comment"
        editedAt={revision.created_at}
        filename="comment.md"
        queryKey={queryKey}
        fetchRevisions={fetchRevisions}
      />,
      client,
    );

    fireEvent.click(await screen.findByText("(edited)"));
    const popover = screen.getByRole("dialog");
    await within(popover).findByRole("button", { name: /User/ });
    await waitFor(() =>
      expect(client.getQueryState(queryKey)?.fetchStatus).toBe("idle"),
    );

    fetchRevisions.mockRejectedValue(
      Object.assign(new Error("HTTP 401"), { status: 401 }),
    );
    await act(async () => {
      await client.refetchQueries({ queryKey, exact: true });
    });
    await waitFor(() =>
      expect(client.getQueryState(queryKey)?.fetchStatus).toBe("idle"),
    );
    expect(fetchRevisions).toHaveBeenCalledTimes(2);
    expect(within(popover).getByRole("button", { name: /User/ })).toBeTruthy();
    expect(within(popover).queryByRole("status")).toBeNull();
    expect(within(popover).queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("disables a warm Retry in flight, then replaces the revision and clears the notice", async () => {
    const queryKey = ["revisions", "comment", 5];
    const client = testQueryClient();
    const fetchRevisions = vi.fn().mockResolvedValue({ items: [revision] });
    const updated = {
      ...revision,
      id: 4,
      actor: {
        ...revision.actor,
        id: 2,
        login: "editor",
        display_name: "Editor",
      },
      created_at: "2026-08-13T10:00:00Z",
      body_before: "new text",
      body_after: "newer text",
    };
    renderWithProviders(
      <RevisionHistory
        label="comment"
        editedAt={revision.created_at}
        filename="comment.md"
        queryKey={queryKey}
        fetchRevisions={fetchRevisions}
      />,
      client,
    );

    fireEvent.click(await screen.findByText("(edited)"));
    const popover = screen.getByRole("dialog");
    await within(popover).findByRole("button", { name: /User/ });
    await waitFor(() =>
      expect(client.getQueryState(queryKey)?.fetchStatus).toBe("idle"),
    );

    fetchRevisions.mockRejectedValueOnce(
      Object.assign(new Error("HTTP 500"), { status: 500 }),
    );
    await act(async () => {
      await client.refetchQueries({ queryKey, exact: true });
    });
    const notice = await within(popover).findByRole("status");
    expect(notice.textContent).toContain("Couldn't refresh");
    expect(within(popover).getByRole("button", { name: /User/ })).toBeTruthy();

    let resolveRetry!: (page: { items: (typeof revision)[] }) => void;
    const pending = new Promise<{ items: (typeof revision)[] }>((resolve) => {
      resolveRetry = resolve;
    });
    fetchRevisions.mockReturnValueOnce(pending);
    fireEvent.click(within(notice).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchRevisions).toHaveBeenCalledTimes(3));
    expect(
      within(notice).getByRole("button", { name: "Retry" }),
    ).toHaveProperty("disabled", true);
    expect(within(popover).getByRole("button", { name: /User/ })).toBeTruthy();
    expect(
      within(popover).queryByRole("button", { name: /Editor/ }),
    ).toBeNull();
    expect(notice.textContent).toContain("HTTP 500");

    await act(async () => {
      resolveRetry({ items: [updated] });
      await pending;
    });
    const updatedRow = await within(popover).findByRole("button", {
      name: /Editor/,
    });
    expect(within(popover).queryByRole("button", { name: /User/ })).toBeNull();
    expect(within(popover).queryByRole("status")).toBeNull();
    expect(client.getQueryData(queryKey)).toEqual({ items: [updated] });

    fireEvent.click(updatedRow);
    const diffDialog = await screen.findByRole("dialog", {
      name: "Edit history — comment",
    });
    expect(
      (await within(diffDialog).findByTestId("revision-diff")).textContent,
    ).toContain("new text → newer text");
  });
});

describe("RevisionHistory · query-key isolation", () => {
  it("drops the previous selection and list when a new key fails cold", async () => {
    const firstKey = ["revisions", "comment", 11];
    const secondKey = ["revisions", "comment", 12];
    const client = testQueryClient();
    const firstFetch = vi.fn().mockResolvedValue({ items: [revision] });
    let rejectSecond!: (error: Error) => void;
    const pendingSecond = new Promise<{ items: (typeof revision)[] }>(
      (_, reject) => {
        rejectSecond = reject;
      },
    );
    const secondFetch = vi.fn().mockReturnValue(pendingSecond);

    function SwitchingHistory() {
      const [second, setSecond] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setSecond(true)}>
            Change comment
          </button>
          <RevisionHistory
            label="comment"
            editedAt={revision.created_at}
            filename="comment.md"
            queryKey={second ? secondKey : firstKey}
            fetchRevisions={second ? secondFetch : firstFetch}
          />
        </>
      );
    }

    renderWithProviders(<SwitchingHistory />, client);
    fireEvent.click(await screen.findByText("(edited)"));
    const firstPopover = screen.getByRole("dialog");
    const row = await within(firstPopover).findByRole("button", {
      name: /User/,
    });
    await waitFor(() =>
      expect(client.getQueryState(firstKey)?.fetchStatus).toBe("idle"),
    );
    fireEvent.click(row);
    const selectedDialog = await screen.findByRole("dialog", {
      name: "Edit history — comment",
    });
    expect(
      (await within(selectedDialog).findByTestId("revision-diff")).textContent,
    ).toContain("old text → new text");

    fireEvent.click(screen.getByText("Change comment"));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Edit history — comment" }),
      ).toBeNull(),
    );
    // The selected diff may have closed the popover; open the new key only
    // if it is not already open after the parent changes props.
    if (!screen.queryByRole("dialog")) {
      fireEvent.click(screen.getByText("(edited)"));
    }
    const secondPopover = screen.getByRole("dialog");
    await waitFor(() => expect(secondFetch).toHaveBeenCalledTimes(1));
    expect(within(secondPopover).getByText("Loading history…")).toBeTruthy();
    expect(
      within(secondPopover).queryByRole("button", { name: /User/ }),
    ).toBeNull();
    expect(within(secondPopover).queryByText(/Couldn't refresh/)).toBeNull();
    expect(client.getQueryData(firstKey)).toEqual({ items: [revision] });
    expect(client.getQueryData(secondKey)).toBeUndefined();

    await act(async () => {
      rejectSecond(new Error("new history offline"));
      await pendingSecond.catch(() => {});
    });
    const failure = await within(secondPopover).findByText(
      "Failed to load history: new history offline",
    );
    expect(
      within(secondPopover).queryByRole("button", { name: /User/ }),
    ).toBeNull();
    expect(within(secondPopover).queryByText(/Couldn't refresh/)).toBeNull();
    const status = failure.closest('[role="status"]') as HTMLElement;
    expect(status.className).toContain("text-xs");
    expect(within(status).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(client.getQueryData(firstKey)).toEqual({ items: [revision] });
    expect(client.getQueryState(secondKey)?.status).toBe("error");
    expect(firstFetch).toHaveBeenCalledTimes(1);
    expect(secondFetch).toHaveBeenCalledTimes(1);
  });
});

describe("the revision list's actor chip stays unlinked (T-391)", () => {
  it("leaves no anchor inside the row's button", async () => {
    renderWithProviders(
      <RevisionHistory
        label="comment"
        editedAt="2026-08-12T10:00:00Z"
        filename="comment.md"
        queryKey={["revisions", "comment", 2]}
        fetchRevisions={vi.fn().mockResolvedValue({ items: [revision] })}
      />,
    );
    fireEvent.click(await screen.findByText("(edited)"));

    // Each row is a button that opens that revision's diff. An anchor inside
    // it would take the click somewhere else entirely.
    const row = (await screen.findByText("User")).closest(
      "button",
    ) as HTMLElement;
    expect(row.querySelectorAll('a[href^="/users/"]')).toHaveLength(0);
    // The name is the other half: a row that rendered no chip would satisfy
    // the line above on its own.
    expect(row.textContent).toContain("User");
  });
});

describe("RevisionHistory · wrap lifecycle (T-425)", () => {
  it.each(historyEntries)(
    "U1: $label defaults to wrap and toggles the actual Pierre option twice",
    async (entry) => {
      renderHistory(entry);
      const trigger = await screen.findByRole("button", { name: "(edited)" });
      const dialog = await openHistoryDiff(entry, trigger);
      await expectHistoryMode(dialog, true);
      const toggle = within(dialog).getByRole("button", {
        name: "wrap long lines",
      });
      expect(toggle.getAttribute("type")).toBe("button");
      expect(toggle.getAttribute("title")).toBe(
        "Wrap long lines instead of scrolling horizontally",
      );
      const diff = within(dialog).getByTestId("revision-diff");
      const scrollArea = diff.closest(".overflow-auto");
      expect(scrollArea).not.toBeNull();
      expect(scrollArea?.classList.contains("max-h-[70vh]")).toBe(true);
      expect(scrollArea?.contains(toggle)).toBe(false);
      const options = JSON.parse(diff.getAttribute("data-options") ?? "null");
      expect(options).toMatchObject({
        diffStyle: "unified",
        themeType: "system",
        preferredHighlighter: "shiki-wasm",
        theme: { light: expect.any(String), dark: expect.any(String) },
      });

      toggleHistoryWrap(dialog);
      await expectHistoryMode(dialog, false);
      expect(localStorage.getItem(HISTORY_WRAP_KEY)).toBe("off");
      toggleHistoryWrap(dialog);
      await expectHistoryMode(dialog, true);
      expect(localStorage.getItem(HISTORY_WRAP_KEY)).toBe("on");
    },
  );

  it.each([
    { stored: null, wrap: true },
    { stored: "off", wrap: false },
    { stored: "on", wrap: true },
    { stored: "corrupt", wrap: true },
    { stored: "", wrap: true },
    { stored: "false", wrap: true },
  ])("U2: stored $stored initializes wrap=$wrap", async ({ stored, wrap }) => {
    if (stored !== null) localStorage.setItem(HISTORY_WRAP_KEY, stored);
    const entry = historyEntries[0];
    renderHistory(entry);
    const trigger = await screen.findByRole("button", { name: "(edited)" });
    await expectHistoryMode(await openHistoryDiff(entry, trigger), wrap);
  });

  it.each([false, true])(
    "U2: choice wrap=%s survives Close/reopen and unmount/remount",
    async (wrap) => {
      localStorage.setItem(HISTORY_WRAP_KEY, wrap ? "off" : "on");
      const entry = historyEntries[0];
      const view = renderHistory(entry);
      const trigger = await screen.findByRole("button", { name: "(edited)" });
      let dialog = await openHistoryDiff(entry, trigger);
      await expectHistoryMode(dialog, !wrap);
      toggleHistoryWrap(dialog);
      await expectHistoryMode(dialog, wrap);
      expect(localStorage.getItem(HISTORY_WRAP_KEY)).toBe(wrap ? "on" : "off");
      await closeHistoryDiff(dialog, trigger);
      dialog = await openHistoryDiff(entry, trigger);
      await expectHistoryMode(dialog, wrap);
      await closeHistoryDiff(dialog, trigger);

      view.unmount();
      renderHistory(entry);
      const remounted = await screen.findByRole("button", { name: "(edited)" });
      await expectHistoryMode(await openHistoryDiff(entry, remounted), wrap);
    },
  );

  it.each([
    { destination: "description on the same card", number: 1 },
    { destination: "description on another card", number: 2 },
  ])(
    "U3: mounted comment → $destination → same comment rereads each opening",
    async ({ number }) => {
      const comment = historyEntries[0];
      const description = {
        ...historyEntries[1],
        queryKey: ["revisions", "demo", number, "issue_body"],
      };
      const fetchComment = vi.fn().mockResolvedValue({ items: [revision] });
      const descriptionRevision = {
        ...revision,
        id: 4,
        body_before: "old description",
        body_after: "new description",
      };
      const fetchDescription = vi
        .fn()
        .mockResolvedValue({ items: [descriptionRevision] });
      renderWithProviders(
        <>
          <section aria-label="Comment history">
            <RevisionHistory
              {...comment}
              editedAt={revision.created_at}
              fetchRevisions={fetchComment}
            />
          </section>
          <section aria-label="Description history">
            <RevisionHistory
              {...description}
              editedAt={descriptionRevision.created_at}
              fetchRevisions={fetchDescription}
            />
          </section>
        </>,
      );
      const commentRegion = await screen.findByRole("region", {
        name: "Comment history",
      });
      const descriptionRegion = screen.getByRole("region", {
        name: "Description history",
      });
      const a = within(commentRegion).getByRole("button", { name: "(edited)" });
      const b = within(descriptionRegion).getByRole("button", {
        name: "(edited)",
      });
      expect(fetchComment).not.toHaveBeenCalled();
      expect(fetchDescription).not.toHaveBeenCalled();
      let dialog = await openHistoryDiff(comment, a);
      await expectHistoryMode(dialog, true);
      toggleHistoryWrap(dialog);
      await expectHistoryMode(dialog, false);
      await closeHistoryDiff(dialog, a);

      dialog = await openHistoryDiff(description, b);
      await expectHistoryMode(dialog, false);
      expectHistoryFiles(dialog, descriptionRevision, description.filename);
      toggleHistoryWrap(dialog);
      await expectHistoryMode(dialog, true);
      await closeHistoryDiff(dialog, b);

      // A's outer component, DOM trigger and queryKey stay mounted throughout.
      expect(a.isConnected).toBe(true);
      expect(
        within(commentRegion).getByRole("button", { name: "(edited)" }),
      ).toBe(a);
      dialog = await openHistoryDiff(comment, a);
      await expectHistoryMode(dialog, true);
      expectHistoryFiles(dialog, revision, comment.filename);
    },
  );

  it.each(["same revision", "another revision"])(
    "U4: storage changes while closed are read when opening %s",
    async (selection) => {
      const entry = historyEntries[0];
      const later = {
        ...revision,
        id: 4,
        actor: {
          ...revision.actor,
          id: 2,
          login: "editor",
          display_name: "Editor",
        },
        created_at: "2026-08-13T10:00:00Z",
        body_before: "new text",
        body_after: "newest text",
      };
      renderHistory(entry, [revision, later]);
      const trigger = await screen.findByRole("button", { name: "(edited)" });
      let dialog = await openHistoryDiff(entry, trigger);
      await expectHistoryMode(dialog, true);
      await closeHistoryDiff(dialog, trigger);

      // Simulate another tab writing while this diff is closed. Live storage
      // event synchronization is deliberately not required by the design.
      localStorage.setItem(HISTORY_WRAP_KEY, "off");
      const selected = selection === "same revision" ? revision : later;
      dialog = await openHistoryDiff(
        entry,
        trigger,
        selected.actor.display_name,
      );
      await expectHistoryMode(dialog, false);
      expectHistoryFiles(dialog, selected, entry.filename);
      await closeHistoryDiff(dialog, trigger);

      localStorage.setItem(HISTORY_WRAP_KEY, "on");
      dialog = await openHistoryDiff(entry, trigger);
      await expectHistoryMode(dialog, true);
      expectHistoryFiles(dialog, revision, entry.filename);
    },
  );

  it("U4b: choosing a revision closes the list, so every diff opens fresh", async () => {
    // This one is expected to stay green, and it is here to say why another
    // case is missing. `RevisionDialog` carries `key={selected.id}` so that
    // replacing one revision with another rereads the saved choice — but
    // opening a diff dismisses the revision list, so `selected` can only go
    // revision → null → revision and the key has nothing left to do. The
    // close-and-reopen rereads are U2 and U4. If this assertion ever fails,
    // the swap-in-place path is reachable again and wants its own case.
    const entry = historyEntries[0];
    const later = {
      ...revision,
      id: 4,
      actor: {
        ...revision.actor,
        id: 2,
        login: "editor",
        display_name: "Editor",
      },
      created_at: "2026-08-13T10:00:00Z",
    };
    renderHistory(entry, [revision, later]);
    const trigger = await screen.findByRole("button", { name: "(edited)" });
    fireEvent.click(trigger);
    const list = await screen.findByRole("dialog", { name: "" });
    await within(list).findByRole("button", { name: /Editor/ });
    fireEvent.click(within(list).getByRole("button", { name: /User/ }));
    await screen.findByRole("dialog", {
      name: `Edit history — ${entry.label}`,
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "" })).toBeNull();
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(list.isConnected).toBe(false);
  });

  it("U5: a throwing storage read defaults to wrap and still allows toggling", async () => {
    // "off" is on disk, so a read that reached storage would open in scroll
    // mode. Only the throw can produce wrap here — no spy call count needed.
    localStorage.setItem(HISTORY_WRAP_KEY, "off");
    denyStorage({ read: true });
    const entry = historyEntries[0];
    renderHistory(entry);
    const trigger = await screen.findByRole("button", { name: "(edited)" });
    const dialog = await openHistoryDiff(entry, trigger);
    await expectHistoryMode(dialog, true);
    toggleHistoryWrap(dialog);
    await expectHistoryMode(dialog, false);
    toggleHistoryWrap(dialog);
    await expectHistoryMode(dialog, true);
    await closeHistoryDiff(dialog, trigger);
    await expectHistoryMode(await openHistoryDiff(entry, trigger), true);
  });

  it.each([false, true])(
    "U5: throwing writes keep the current toggle usable and reopen saved wrap=%s",
    async (savedWrap) => {
      localStorage.setItem(HISTORY_WRAP_KEY, savedWrap ? "on" : "off");
      const writes = denyStorage({ write: true });
      const entry = historyEntries[0];
      renderHistory(entry);
      const trigger = await screen.findByRole("button", { name: "(edited)" });
      let dialog = await openHistoryDiff(entry, trigger);
      await expectHistoryMode(dialog, savedWrap);
      const expectedWrites: Array<[string, string]> = [];
      for (const wrap of [!savedWrap, savedWrap, !savedWrap]) {
        toggleHistoryWrap(dialog);
        await expectHistoryMode(dialog, wrap);
        // The write was attempted and threw — not quietly skipped, which
        // would satisfy "storage unchanged" for the wrong reason.
        expectedWrites.push([HISTORY_WRAP_KEY, wrap ? "on" : "off"]);
        expect(writes).toEqual(expectedWrites);
        expectHistoryFiles(dialog, revision, entry.filename);
        expect(
          screen.getByRole("dialog", { name: `Edit history — ${entry.label}` }),
        ).toBe(dialog);
      }
      expect(localStorage.getItem(HISTORY_WRAP_KEY)).toBe(
        savedWrap ? "on" : "off",
      );
      await closeHistoryDiff(dialog, trigger);
      dialog = await openHistoryDiff(entry, trigger);
      await expectHistoryMode(dialog, savedWrap);
    },
  );

  it.each(historyEntries)(
    "U6: $label preserves both source strings character-for-character through toggles",
    async (entry) => {
      const original = {
        ...revision,
        body_before: `  旧文  连续空格\n\n\thttps://example.test/${"old".repeat(100)}\n${"中文长行".repeat(60)}\n  旧文末尾  `,
        body_after: `    新文   连续空格\n\n\thttps://example.test/${"new".repeat(100)}\n${"新的中文长行".repeat(60)}\n\t新文末尾   `,
      };
      renderHistory(entry, [original]);
      const trigger = await screen.findByRole("button", { name: "(edited)" });
      const dialog = await openHistoryDiff(entry, trigger);
      expectHistoryFiles(dialog, original, entry.filename);
      await expectHistoryMode(dialog, true);
      toggleHistoryWrap(dialog);
      await expectHistoryMode(dialog, false);
      expectHistoryFiles(dialog, original, entry.filename);
      toggleHistoryWrap(dialog);
      await expectHistoryMode(dialog, true);
      expectHistoryFiles(dialog, original, entry.filename);
    },
  );

  it("U7: fetches only after opening history and keeps selection and request count on wrap", async () => {
    const entry = historyEntries[0];
    const client = testQueryClient();
    let resolveHistory!: (page: { items: (typeof revision)[] }) => void;
    const pending = new Promise<{ items: (typeof revision)[] }>((resolve) => {
      resolveHistory = resolve;
    });
    const fetchRevisions = vi.fn().mockReturnValue(pending);
    renderWithProviders(
      <RevisionHistory
        {...entry}
        editedAt={revision.created_at}
        fetchRevisions={fetchRevisions}
      />,
      client,
    );
    const trigger = await screen.findByRole("button", { name: "(edited)" });
    expect(fetchRevisions).not.toHaveBeenCalled();
    expect(screen.queryByTestId("revision-diff")).toBeNull();
    fireEvent.click(trigger);
    const popover = await screen.findByRole("dialog", { name: "" });
    expect(await within(popover).findByText("Loading history…")).toBeTruthy();
    expect(screen.queryByTestId("revision-diff")).toBeNull();
    await act(async () => {
      resolveHistory({ items: [revision] });
      await pending;
    });
    await within(popover).findByRole("button", { name: /User/ });
    await waitFor(() =>
      expect(client.getQueryState(entry.queryKey)?.fetchStatus).toBe("idle"),
    );
    expect(fetchRevisions).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("revision-diff")).toBeNull();
    const dialog = await openHistoryDiff(entry, trigger);
    await expectHistoryMode(dialog, true);
    for (const wrap of [false, true]) {
      toggleHistoryWrap(dialog);
      await expectHistoryMode(dialog, wrap);
      expectHistoryFiles(dialog, revision, entry.filename);
      expect(fetchRevisions).toHaveBeenCalledTimes(1);
      expect(client.getQueryState(entry.queryKey)?.fetchStatus).toBe("idle");
      expect(client.getQueryData(entry.queryKey)).toEqual({
        items: [revision],
      });
    }
  });
});
