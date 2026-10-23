import type { QueryClient } from "@tanstack/react-query";
import { act, cleanup, waitFor } from "@testing-library/react";
import {
  type IssueListItem,
  MePrefs,
  MovedError,
  type Status,
} from "@todou/shared";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueRefQuery } from "../src/api/issue-refs.ts";
import { prefsQuery } from "../src/api/prefs.ts";
import { api, projectsQuery } from "../src/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import { useUserEvents } from "../src/api/useUserEvents.ts";
import { IssueLink } from "../src/components/shared/issue-link.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

/**
 * T-549: a rich reference must follow the card it names while the page that
 * holds it stays open, driven by the real SSE handler rather than by calling
 * the invalidation helpers directly.
 */

type Listener = (e: MessageEvent) => void;

class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: MockEventSource[] = [];
  readyState = MockEventSource.CONNECTING;
  listeners = new Map<string, Listener[]>();
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(_url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, data: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent);
    }
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }
}

const SLUG = "demo";
const TODO: Status = {
  id: 2,
  name: "Todo",
  category: "open",
  color: "#6b7280",
  position: 1,
  is_default: true,
};
const DONE: Status = {
  id: 7,
  name: "Done",
  category: "closed",
  color: "#22c55e",
  position: 6,
  is_default: false,
};
const alice = {
  id: 1,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

/** What the server currently holds for each card, by number. */
let server: Map<number, IssueListItem>;

const card = (number: number, title: string, status: Status) => ({
  id: 100 + number,
  number,
  title,
  status,
  author: alice,
  assignees: [],
  labels: [],
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
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
});

function seeded(): QueryClient {
  const client = testQueryClient();
  client.setQueryData(prefsQuery.queryKey, MePrefs.parse({}));
  client.setQueryData(referenceDirectoryQuery.queryKey, null);
  client.setQueryData(projectsQuery.queryKey, [
    {
      id: 1,
      slug: SLUG,
      name: SLUG,
      description: "",
      created_at: "2026-10-01T00:00:00Z",
    },
  ]);
  client.setQueryData(referenceConfigQuery(SLUG).queryKey, {
    format: { prefix: null, history: [] },
    autolinks: [],
  });
  // Keep these out of the request counts below.
  for (const key of [
    prefsQuery.queryKey,
    referenceDirectoryQuery.queryKey,
    projectsQuery.queryKey,
    referenceConfigQuery(SLUG).queryKey,
  ]) {
    client.setQueryDefaults(key, { staleTime: Infinity, gcTime: Infinity });
  }
  return client;
}

/** Leaves and re-enters the page without remounting the providers. */
let showChips: (shown: boolean) => void = () => {};

function Page() {
  useUserEvents(1);
  const [chips, setChips] = useState(true);
  showChips = setChips;
  if (!chips) return null;
  return (
    <div>
      <p data-testid="by-slug">
        <IssueLink slug={SLUG} number={1} pageSlug={SLUG} inBody />
      </p>
      {/* A stored reference is written with the project's id (T-266). */}
      <p data-testid="by-id">
        <IssueLink slug="1" number={1} pageSlug={SLUG} />
      </p>
      <p data-testid="other">
        <IssueLink slug={SLUG} number={2} pageSlug={SLUG} />
      </p>
    </div>
  );
}

function chip(container: HTMLElement, testId: string) {
  const anchor = container.querySelector(
    `[data-testid='${testId}'] a[data-issue-link]`,
  );
  return {
    anchor,
    title: anchor?.getAttribute("title") ?? null,
    icon:
      anchor
        ?.querySelector("svg")
        ?.getAttribute("class")
        ?.match(/lucide-circle[a-z-]*/)?.[0] ?? null,
  };
}

function stream() {
  const source = MockEventSource.instances.at(-1);
  if (!source) throw new Error("no event stream opened");
  return source;
}

const closeOne = () => {
  server.set(1, card(1, "Target B (renamed)", DONE));
  stream().emit("change", {
    entity: "issue",
    id: 101,
    action: "updated",
    issue_number: 1,
    project: SLUG,
    list_row: { kind: "fields", status_id: DONE.id },
  });
};

let list: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubGlobal("EventSource", MockEventSource);
  server = new Map([
    [1, card(1, "Target B", TODO)],
    [2, card(2, "Unrelated", TODO)],
  ]);
  list = vi.spyOn(api, "listIssues").mockImplementation(async (slug, q) => {
    // A numeric address is resolved through the single-issue redirect.
    if (slug !== SLUG) throw { status: 404 };
    return {
      items: ((q?.numbers ?? []) as number[]).flatMap((n) => {
        const item = server.get(n);
        return item ? [item] : [];
      }),
      next_cursor: null,
    };
  });
  vi.spyOn(api, "getIssue").mockImplementation(async (slug, number) => {
    if (slug === "1") throw new MovedError({ slug: SLUG, number });
    const item = server.get(number);
    if (!item) throw { status: 404 };
    return { ...item, body: "" };
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  MockEventSource.instances = [];
});

async function mounted(client: QueryClient) {
  const view = renderWithProviders(<Page />, client);
  await waitFor(() => {
    for (const id of ["by-slug", "by-id", "other"]) {
      expect(chip(view.container, id).anchor).not.toBeNull();
    }
  });
  return view;
}

describe("rich references follow the card they name (T-549)", () => {
  it("updates every open chip of a card closed elsewhere, in place", async () => {
    const client = seeded();
    const view = await mounted(client);
    expect(chip(view.container, "by-slug")).toMatchObject({
      title: "#1 Target B (Todo)",
      icon: "lucide-circle-dot",
    });
    const anchors = ["by-slug", "by-id", "other"].map(
      (id) => chip(view.container, id).anchor,
    );
    const otherTitle = chip(view.container, "other").title;
    const listCalls = list.mock.calls.length;

    act(() => closeOne());

    await waitFor(() => {
      for (const id of ["by-slug", "by-id"]) {
        expect(chip(view.container, id)).toMatchObject({
          title: expect.stringContaining("Target B (renamed)"),
          icon: "lucide-circle-slash",
        });
        expect(chip(view.container, id).title).toContain("(Done)");
      }
    });
    // Updated, not replaced: the anchor never fell back to a plain link.
    expect(
      ["by-slug", "by-id", "other"].map(
        (id) => chip(view.container, id).anchor,
      ),
    ).toEqual(anchors);
    expect(chip(view.container, "other").title).toBe(otherTitle);
    // One batched read per address the card is written with (the numeric
    // one resolves through its redirect), and only for the changed card.
    expect(list.mock.calls.slice(listCalls)).toEqual([
      [SLUG, { numbers: [1], limit: 1 }],
      ["1", { numbers: [1], limit: 1 }],
    ]);
  });

  it("asks nothing for an event about a card no chip names", async () => {
    const client = seeded();
    await mounted(client);
    const listCalls = list.mock.calls.length;
    stream().emit("change", {
      entity: "issue",
      id: 999,
      action: "updated",
      issue_number: 99,
      project: SLUG,
      list_row: { kind: "fields", status_id: DONE.id },
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)));
    expect(list.mock.calls.length).toBe(listCalls);
  });

  it("shows the new state on returning to a page left while the card closed", async () => {
    const client = seeded();
    const view = await mounted(client);
    act(() => showChips(false));
    await waitFor(() =>
      expect(view.container.querySelector("a[data-issue-link]")).toBeNull(),
    );

    act(() => closeOne());
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)));
    // Nobody is looking: nothing is fetched until the page comes back.
    expect(client.getQueryData(issueRefQuery(SLUG, 1).queryKey)).toMatchObject({
      status: TODO,
    });

    act(() => showChips(true));
    await waitFor(() =>
      expect(chip(view.container, "by-slug")).toMatchObject({
        title: "#1 Target B (renamed) (Done)",
        icon: "lucide-circle-slash",
      }),
    );
  });

  it("keeps the confirmed chip when its refresh fails", async () => {
    const client = seeded();
    const view = await mounted(client);
    const anchor = chip(view.container, "by-slug").anchor;
    list.mockRejectedValue(new Error("offline"));
    vi.mocked(api.getIssue).mockRejectedValue(new Error("offline"));
    act(() => closeOne());
    await waitFor(() =>
      expect(
        client.getQueryState(issueRefQuery(SLUG, 1).queryKey)?.status,
      ).toBe("error"),
    );
    // The same node, still decorated: no fallback to a plain link.
    expect(chip(view.container, "by-slug").anchor).toBe(anchor);
    expect(chip(view.container, "by-slug").title).toBe("#1 Target B (Todo)");
  });

  it("repaints the chip when its status is renamed", async () => {
    const client = seeded();
    const view = await mounted(client);
    const renamed = { ...TODO, name: "Queued" };
    server.set(1, card(1, "Target B", renamed));
    server.set(2, card(2, "Unrelated", renamed));
    stream().emit("change", {
      entity: "status",
      id: TODO.id,
      action: "updated",
      project: SLUG,
    });
    await waitFor(() => {
      expect(chip(view.container, "by-slug").title).toBe(
        "#1 Target B (Queued)",
      );
      expect(chip(view.container, "other").title).toBe("#2 Unrelated (Queued)");
    });
  });
});
