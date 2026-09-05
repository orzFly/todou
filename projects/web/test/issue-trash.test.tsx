import type { QueryClient } from "@tanstack/react-query";
import { fireEvent, waitFor } from "@testing-library/react";
import type { IssueListItem } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueRefQuery } from "../src/api/issue-refs.ts";
import { projectsQuery } from "../src/api/queries.ts";
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
  return client;
}

/**
 * The whole reason the design chose plain-text degradation over a dead link:
 * once a card is in the trash its title must not surface anywhere, and every
 * reference to it must come back by itself when it is restored.
 */
describe("references to a card in the trash", () => {
  it("render as the text their author typed, with no title", async () => {
    const client = testQueryClient();
    // null is what the batcher resolves to when the number matches nothing
    // the viewer may see — which a deleted card no longer is.
    client.setQueryData(issueRefQuery("todou", 5).queryKey, null);

    const view = renderWithProviders(
      <MarkdownView slug="todou">{STORED}</MarkdownView>,
      withProjects(client),
    );

    await waitFor(() => {
      expect(view.container.textContent).toContain("Blocked by #5 for now.");
    });
    expect(view.container.querySelector("a[data-issue-link='5']")).toBeNull();
    expect(view.container.textContent).not.toContain(SECRET);
  });

  it("become links again the moment the card is restored", async () => {
    let deleted = true;
    vi.stubGlobal("fetch", (async (input: unknown) => {
      expect(String(input)).toContain("numbers=5");
      return new Response(
        JSON.stringify({
          items: deleted ? [] : [item(5, SECRET)],
          next_cursor: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch);

    const client: QueryClient = withProjects(testQueryClient());
    const view = renderWithProviders(
      <MarkdownView slug="todou">{STORED}</MarkdownView>,
      client,
    );

    // While the lookup is in flight the ref is a bare link (no title); the
    // degradation is what lands when it comes back empty.
    await waitFor(() => {
      expect(view.container.querySelector("a[data-issue-link='5']")).toBeNull();
    });
    expect(view.container.textContent).toContain("Blocked by #5 for now.");

    // What the restore mutation does: drop the cached ref lookups for this
    // project. Nothing else in the rendered tree changes.
    deleted = false;
    await client.invalidateQueries({ queryKey: ["issue-ref", "todou"] });

    const link = await waitFor(() => {
      const el = view.container.querySelector("a[data-issue-link='5']");
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    expect(link.getAttribute("href")).toBe("/projects/todou/issues/5");
    expect(link.textContent).toContain(SECRET);
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
