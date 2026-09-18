import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
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
  }: {
    oldFile: { contents: string };
    newFile: { contents: string };
  }) => (
    <div data-testid="revision-diff">
      {oldFile.contents} → {newFile.contents}
    </div>
  ),
}));

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
