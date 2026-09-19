import type { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { DEFAULT_REFERENCE_CONFIG, type IssueListItem } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueRefQuery } from "../src/api/issue-refs.ts";
import { api, projectsQuery } from "../src/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { ICONS, renderEvent } from "../src/components/timeline/event-row.tsx";
import { NO_ENTITIES } from "../src/components/timeline/use-event-entities.ts";
import { ConfirmDialog } from "../src/components/ui/confirm-dialog.tsx";
import { TrashView } from "../src/pages/issue-list.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

// The lazily-imported pierre CodeView (T-31) would make the DOM depend on
// when its chunk resolves; MarkdownView pulls it in for fences.
vi.mock("@pierre/diffs/react", () => ({
  CodeView: () => null,
  MultiFileDiff: () => null,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const item = (
  number: number,
  title: string,
  overrides: Partial<IssueListItem> = {},
): IssueListItem => ({
  id: number,
  number,
  title,
  status: {
    id: 1,
    name: "Todo",
    category: "open",
    color: "#6b7280",
    position: 1,
    is_default: false,
  },
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
  created_at: "2026-08-12T00:00:00Z",
  updated_at: "2026-08-12T00:00:00Z",
  body_edited_at: null,
  open_questions: 0,
  spec_version: null,
  spec_review_status: null,
  spec_unresolved_comments: 0,
  deleted_at: null,
  deleted_by: null,
  unread: false,
  unread_comments: 0,
  muted: null,
  blocked_by: [],
  blocks: [],
  moves: [],
  ...overrides,
});

const SECRET = "the artichoke plan";

/** How the resolve pass stored `#5` back when the card was still there. */
const STORED = "Blocked by [#5](/projects/1/issues/5) for now.";

/** The reader's directory, so the stored id resolves back to a slug. */
function withProjects(client: QueryClient): QueryClient {
  client.setQueryData(projectsQuery.queryKey, [
    {
      id: 1,
      slug: "todou",
      name: "todou",
      description: "",
      created_at: "2026-01-01T00:00:00.000Z",
    },
  ]);
  client.setQueryData(
    referenceConfigQuery("todou").queryKey,
    DEFAULT_REFERENCE_CONFIG,
  );
  client.setQueryData(referenceDirectoryQuery.queryKey, null);
  return client;
}

/**
 * Initial resolution of a trashed card keeps the authored text and hides its
 * title. Background invalidation preserves the current display; a full page
 * refresh resolves restoration or deletion with a fresh query cache.
 */
describe("references to a card in the trash", () => {
  const clients: QueryClient[] = [];
  const newClient = () => {
    const client = withProjects(testQueryClient());
    clients.push(client);
    return client;
  };

  afterEach(() => {
    cleanup();
    for (const client of clients.splice(0)) client.clear();
  });

  it("render as the text their author typed, with no title", async () => {
    const client = newClient();
    // null is what the batcher resolves to when the number matches nothing
    // the viewer may see — which a deleted card no longer is.
    client.setQueryData(issueRefQuery("todou", 5).queryKey, null);

    const view = renderWithProviders(
      <MarkdownView slug="todou">{STORED}</MarkdownView>,
      client,
    );

    await waitFor(() => {
      expect(view.container.textContent).toContain("Blocked by #5 for now.");
    });
    expect(view.container.querySelector("a[data-issue-link='5']")).toBeNull();
    expect(view.container.textContent).not.toContain(SECRET);
  });

  it("resolves a restored card after a page refresh, not background invalidation", async () => {
    const listIssues = vi.spyOn(api, "listIssues").mockResolvedValue({
      items: [],
      next_cursor: null,
    });
    const getIssue = vi
      .spyOn(api, "getIssue")
      .mockRejectedValue({ status: 404 });
    const refKey = issueRefQuery("todou", 5).queryKey;
    const client = newClient();
    const view = renderWithProviders(
      <MarkdownView slug="todou">{STORED}</MarkdownView>,
      client,
    );

    // Wait for the list miss and single-issue fallback to finish: the loading
    // state also lacks a rich link, so its appearance alone proves nothing.
    const paragraph = await waitFor(() => {
      expect(client.getQueryData(refKey)).toBeNull();
      const el = view.container.querySelector("p");
      expect(el).not.toBeNull();
      expect(el?.textContent).toBe("Blocked by #5 for now.");
      expect(view.container.querySelector("a[data-issue-link='5']")).toBeNull();
      expect(view.container.textContent).not.toContain(SECRET);
      return el as HTMLParagraphElement;
    });
    const originalNodes = Array.from(paragraph.childNodes);
    expect(listIssues).toHaveBeenCalledTimes(1);
    expect(listIssues).toHaveBeenCalledWith("todou", {
      numbers: [5],
      limit: 1,
    });
    expect(getIssue).toHaveBeenCalledTimes(1);
    expect(getIssue).toHaveBeenCalledWith("todou", 5);

    listIssues.mockResolvedValue({
      items: [item(5, SECRET)],
      next_cursor: null,
    });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["issue-ref", "todou"] });
    });

    // A restore invalidation neither repeats the lookup nor replaces the
    // paragraph, its authored reference, or the surrounding text nodes.
    expect(listIssues).toHaveBeenCalledTimes(1);
    expect(getIssue).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(refKey)).toBeNull();
    expect(view.container.querySelector("p")).toBe(paragraph);
    expect(paragraph.childNodes.length).toBe(originalNodes.length);
    originalNodes.forEach((node, index) => {
      expect(paragraph.childNodes[index]).toBe(node);
    });
    expect(view.container.textContent).toContain("Blocked by #5 for now.");
    expect(view.container.querySelector("a[data-issue-link='5']")).toBeNull();
    expect(view.container.textContent).not.toContain(SECRET);

    // Reloading the page unmounts the display and starts with an empty ref cache.
    view.unmount();
    const refreshedClient = newClient();
    expect(refreshedClient.getQueryData(refKey)).toBeUndefined();
    const refreshedView = renderWithProviders(
      <MarkdownView slug="todou">{STORED}</MarkdownView>,
      refreshedClient,
    );
    const link = await waitFor(() => {
      const el = refreshedView.container.querySelector(
        "a[data-issue-link='5']",
      );
      expect(el).not.toBeNull();
      expect(el?.textContent).toContain(SECRET);
      return el as HTMLAnchorElement;
    });
    expect(link.getAttribute("href")).toBe("/projects/todou/issues/5");
    expect(listIssues).toHaveBeenCalledTimes(2);
    expect(listIssues).toHaveBeenNthCalledWith(2, "todou", {
      numbers: [5],
      limit: 1,
    });
    // The refreshed list resolves the restored card without another fallback.
    expect(getIssue).toHaveBeenCalledTimes(1);
  });

  it("keeps a resolved link through deletion and invalidation until a page refresh", async () => {
    const resolved = item(5, SECRET);
    const listIssues = vi.spyOn(api, "listIssues").mockResolvedValue({
      items: [resolved],
      next_cursor: null,
    });
    const getIssue = vi
      .spyOn(api, "getIssue")
      .mockRejectedValue({ status: 404 });
    const refKey = issueRefQuery("todou", 5).queryKey;
    const client = newClient();
    const view = renderWithProviders(
      <MarkdownView slug="todou">{STORED}</MarkdownView>,
      client,
    );
    const link = await waitFor(() => {
      const el = view.container.querySelector("a[data-issue-link='5']");
      expect(el).not.toBeNull();
      expect(el?.textContent).toContain(SECRET);
      return el as HTMLAnchorElement;
    });
    const originalNodes = Array.from(link.childNodes);
    expect(link.getAttribute("href")).toBe("/projects/todou/issues/5");
    expect(listIssues).toHaveBeenCalledTimes(1);
    expect(listIssues).toHaveBeenCalledWith("todou", {
      numbers: [5],
      limit: 1,
    });
    expect(getIssue).not.toHaveBeenCalled();

    listIssues.mockResolvedValue({ items: [], next_cursor: null });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["issue-ref", "todou"] });
    });

    expect(listIssues).toHaveBeenCalledTimes(1);
    expect(getIssue).not.toHaveBeenCalled();
    expect(client.getQueryData(refKey)).toEqual(resolved);
    expect(view.container.querySelector("a[data-issue-link='5']")).toBe(link);
    expect(link.childNodes.length).toBe(originalNodes.length);
    originalNodes.forEach((node, index) => {
      expect(link.childNodes[index]).toBe(node);
    });
    expect(link.getAttribute("href")).toBe("/projects/todou/issues/5");
    expect(link.textContent).toContain(SECRET);

    view.unmount();
    const refreshedClient = newClient();
    expect(refreshedClient.getQueryData(refKey)).toBeUndefined();
    const refreshedView = renderWithProviders(
      <MarkdownView slug="todou">{STORED}</MarkdownView>,
      refreshedClient,
    );
    await waitFor(() => {
      expect(refreshedClient.getQueryData(refKey)).toBeNull();
      expect(refreshedView.container.textContent).toContain(
        "Blocked by #5 for now.",
      );
      expect(
        refreshedView.container.querySelector("a[data-issue-link='5']"),
      ).toBeNull();
      expect(refreshedView.container.textContent).not.toContain(SECRET);
    });
    expect(listIssues).toHaveBeenCalledTimes(2);
    expect(listIssues).toHaveBeenNthCalledWith(2, "todou", {
      numbers: [5],
      limit: 1,
    });
    expect(getIssue).toHaveBeenCalledTimes(1);
    expect(getIssue).toHaveBeenCalledWith("todou", 5);
  });
});

describe("ConfirmDialog", () => {
  it("runs the action only when confirmed", async () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    const view = renderWithProviders(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Move this issue to the trash?"
        description="You can restore it later."
        confirmLabel="Move to trash"
        destructive
        onConfirm={onConfirm}
      />,
    );

    const cancel = await view.findByRole("button", { name: "Cancel" });
    fireEvent.click(cancel);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);

    fireEvent.click(view.getByRole("button", { name: "Move to trash" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("locks both buttons while the mutation is in flight", async () => {
    const view = renderWithProviders(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Move this issue to the trash?"
        confirmLabel="Move to trash"
        pending
        onConfirm={() => {}}
      />,
    );
    const confirm = await view.findByRole("button", { name: "Move to trash" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(
      (view.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("the trash view", () => {
  it("lists deleted cards with a restore action", async () => {
    const restored: number[] = [];
    vi.stubGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.includes("/restore")) {
        restored.push(Number(url.match(/issues\/(\d+)\/restore/)?.[1]));
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/references/config")) {
        return new Response(JSON.stringify({ error: {} }), { status: 404 });
      }
      expect(url).toContain("deleted=true");
      return new Response(
        JSON.stringify({
          items: [item(5, SECRET, { deleted_at: "2026-08-13T09:00:00Z" })],
          next_cursor: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch);

    const view = renderWithProviders(
      <TrashView slug="todou" search={{ deleted: true }} />,
    );

    const restore = await view.findByRole("button", { name: "Restore" });
    expect(view.container.textContent).toContain(SECRET);
    fireEvent.click(restore);
    await waitFor(() => expect(restored).toEqual([5]));
  });
});

describe("timeline entries for the trash", () => {
  const sentence = (event_type: "deleted" | "restored") =>
    renderEvent(
      {
        type: "event",
        id: 1,
        event_type,
        actor: {
          id: 1,
          login: "u",
          display_name: "U",
          kind: "human",
          avatar_url: null,
          owner: null,
        },
        payload: {},
        created_at: "2026-08-11T00:00:00Z",
        agent_context: null,
      },
      {
        refConfig: { internalPrefix: null, autolinks: [] },
        slugEntries: [],
        entities: NO_ENTITIES,
      },
    ).text;

  it("says what happened without naming the card", () => {
    expect(sentence("deleted")).toBe("moved this to the trash");
    expect(sentence("restored")).toBe("restored this from the trash");
    expect(ICONS.deleted).toBeTruthy();
    expect(ICONS.restored).toBeTruthy();
  });
});
