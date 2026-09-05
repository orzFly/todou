import { QueryClient } from "@tanstack/react-query";
import { fireEvent, waitFor } from "@testing-library/react";
import type {
  AgentContext,
  IssueListItem,
  Project,
  ReferenceConfig,
  ReferenceDirectory,
  TimelineEvent,
  UserRef,
} from "@todou/shared";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { issueRefQuery } from "../src/api/issue-refs.ts";
import { projectsQuery } from "../src/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import { EventGroup } from "../src/components/timeline/event-group.tsx";
import { renderWithProviders } from "./render.tsx";

const bot: UserRef = {
  id: 2,
  login: "bot-one",
  display_name: "Bot One",
  kind: "machine",
  avatar_url: null,
  owner: { id: 1, login: "alice" },
};

const session: AgentContext = {
  agent: "claude-code",
  model: "model-alpha",
  session_id: "session-a",
};

let nextId = 100;
function event(overrides: Partial<TimelineEvent>): TimelineEvent {
  return {
    type: "event",
    id: nextId++,
    event_type: "label_added",
    actor: bot,
    payload: { label: { id: 1, name: "bug", color: "#f00" } },
    created_at: "2026-08-13T12:00:00.000Z",
    agent_context: session,
    ...overrides,
  };
}

let nextLabelId = 1;
const label = (name: string, type: "label_added" | "label_removed") =>
  event({
    event_type: type,
    payload: { label: { id: nextLabelId++, name, color: "#0f0" } },
  });

const move = (from: [number, string], to: [number, string], at: string) =>
  event({
    event_type: "status_changed",
    payload: {
      from: { id: from[0], name: from[1] },
      to: { id: to[0], name: to[1] },
    },
    created_at: at,
  });

const refItem = (number: number, title: string): IssueListItem => ({
  id: number,
  number,
  title,
  status: {
    id: 1,
    name: "In Progress",
    category: "open",
    color: "#bf8700",
    position: 2,
    is_default: false,
  },
  author: {
    id: 1,
    login: "alice",
    display_name: "Alice",
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
});

const SINCE = "2026-08-01T00:00:00.000Z";

const configOf = (prefix: string): ReferenceConfig => ({
  format: { prefix, history: [{ prefix, effective_from: SINCE }] },
  autolinks: [],
});

const directory: ReferenceDirectory = {
  since: SINCE,
  entries: [{ prefix: "M", slug: "mirror", from: SINCE, to: null }],
  contested: [],
};

const project = (id: number, slug: string): Project => ({
  id,
  slug,
  name: slug,
  description: "",
  created_at: SINCE,
});

/**
 * A viewer on `todou` who may also read `mirror` (project id 2, the
 * by_project_id the payloads carry), with `targets` seeding the batched
 * lookups each IssueLink makes.
 */
function crossClient(
  targets: Array<[string, IssueListItem]> = [],
): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(referenceConfigQuery("todou").queryKey, configOf("T"));
  client.setQueryData(referenceConfigQuery("mirror").queryKey, configOf("M"));
  client.setQueryData(referenceDirectoryQuery.queryKey, directory);
  client.setQueryData(projectsQuery.queryKey, [
    project(1, "todou"),
    project(2, "mirror"),
  ]);
  for (const [slug, item] of targets) {
    client.setQueryData(issueRefQuery(slug, item.number).queryKey, item);
  }
  return client;
}

describe("EventGroup", () => {
  it("summarizes a mixed labels run GitHub-style", async () => {
    const { findByTestId, getByTitle, getAllByTitle } = renderWithProviders(
      <EventGroup
        family="labels"
        events={[
          label("area:infra", "label_added"),
          label("area:docs", "label_added"),
          label("kind:legacy", "label_removed"),
        ]}
        slug="p"
        issueNumber={1}
      />,
    );
    const group = await findByTestId("event-group");
    expect(group.textContent).toContain("3 items");
    // The summary itself is chips now; its plain-text mirror still spells
    // the names out for the truncation tooltip.
    expect(
      getByTitle(
        "added labels area:infra, area:docs · removed label kind:legacy",
      ),
    ).toBeTruthy();
    // Same prefix grouping as the list: one muted "area:" over value chips.
    for (const name of ["area:infra", "area:docs", "kind:legacy"]) {
      expect(getAllByTitle(name).length).toBeGreaterThan(0);
    }
    expect(getByTitle("area:infra").textContent).toBe("infra");
  });

  it("pills every hop of a status summary (T-171)", async () => {
    const { findByTitle } = renderWithProviders(
      <EventGroup
        family="status"
        events={[
          move([1, "Todo"], [2, "Next"], "2026-08-13T12:00:11.000Z"),
          move([2, "Next"], [3, "In Progress"], "2026-08-13T12:02:47.000Z"),
        ]}
        slug="p"
        issueNumber={1}
      />,
    );
    const summary = await findByTitle("moved Todo → In Progress");
    // One dot per pill; the arrow between them is plain text.
    expect(summary.querySelectorAll("span[aria-hidden]")).toHaveLength(2);
  });

  it("collapses a status chain to its net transition", async () => {
    const { findByTestId, getByTitle } = renderWithProviders(
      <EventGroup
        family="status"
        events={[
          move([1, "Todo"], [2, "Next"], "2026-08-13T12:00:11.000Z"),
          move([2, "Next"], [3, "In Progress"], "2026-08-13T12:02:47.000Z"),
        ]}
        slug="p"
        issueNumber={1}
      />,
    );
    await findByTestId("event-group");
    const summary = getByTitle("moved Todo → In Progress");
    expect(summary.className).not.toContain("text-muted-foreground/60");
  });

  it("prints a noop chain in full, dimmed", async () => {
    const { findByTestId, getByTitle } = renderWithProviders(
      <EventGroup
        family="status"
        events={[
          move(
            [3, "In Progress"],
            [4, "Ready to Ship"],
            "2026-08-13T12:00:00.000Z",
          ),
          move(
            [4, "Ready to Ship"],
            [3, "In Progress"],
            "2026-08-13T12:01:00.000Z",
          ),
        ]}
        slug="p"
        issueNumber={1}
      />,
    );
    await findByTestId("event-group");
    const summary = getByTitle(
      "moved In Progress → Ready to Ship → In Progress",
    );
    expect(summary.className).toContain("text-muted-foreground/60");
  });

  // A sub-row is now a sentence around a chip, so its plain-text mirror
  // (the truncation tooltip) is what identifies it, not a single text node.
  it("expands to raw rows without repeating the actor", async () => {
    const { findByTestId, getByTestId, getAllByText, queryByTitle } =
      renderWithProviders(
        <EventGroup
          family="labels"
          events={[
            label("area:infra", "label_added"),
            label("area:docs", "label_added"),
          ]}
          slug="p"
          issueNumber={1}
        />,
      );
    await findByTestId("event-group");
    expect(queryByTitle("added label area:infra")).toBeNull();

    const toggle = getByTestId("event-group-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    await waitFor(() => {
      expect(queryByTitle("added label area:infra")).toBeTruthy();
      expect(queryByTitle("added label area:docs")).toBeTruthy();
    });
    // The header names the actor once; expanded sub-rows must not repeat it.
    expect(getAllByText("Bot One")).toHaveLength(1);

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(queryByTitle("added label area:infra")).toBeNull(),
    );
  });

  it("mounts expanded when the anchored event is inside", async () => {
    const events = [
      label("area:infra", "label_added"),
      label("area:docs", "label_added"),
    ];
    const { findByTitle } = renderWithProviders(
      <EventGroup
        family="labels"
        events={events}
        slug="p"
        issueNumber={1}
        anchorEventId={events[1]?.id}
      />,
    );
    await findByTitle("added label area:docs");
  });

  it("expands when the hash target arrives after mount", async () => {
    const events = [
      label("area:infra", "label_added"),
      label("area:docs", "label_added"),
    ];
    // In the app the hash flips via router state; a local harness stands in
    // for that so the test exercises the same prop transition.
    function Harness() {
      const [anchor, setAnchor] = useState<number | undefined>(undefined);
      return (
        <>
          <button
            type="button"
            data-testid="set-anchor"
            onClick={() => setAnchor(events[1]?.id)}
          >
            go
          </button>
          <EventGroup
            family="labels"
            events={events}
            slug="p"
            issueNumber={1}
            anchorEventId={anchor}
          />
        </>
      );
    }
    const { findByTestId, getByTestId, queryByTitle } = renderWithProviders(
      <Harness />,
    );
    await findByTestId("event-group");
    expect(queryByTitle("added label area:docs")).toBeNull();

    fireEvent.click(getByTestId("set-anchor"));
    await waitFor(() =>
      expect(queryByTitle("added label area:docs")).toBeTruthy(),
    );
  });

  it("stamps the header with the first event's time and permalink", async () => {
    const first = move([1, "Todo"], [2, "Next"], "2026-08-13T12:00:11.000Z");
    const last = move(
      [2, "Next"],
      [3, "In Progress"],
      "2026-08-13T12:02:47.000Z",
    );
    const { findByTestId, container } = renderWithProviders(
      <EventGroup
        family="status"
        events={[first, last]}
        slug="p"
        issueNumber={1}
      />,
    );
    await findByTestId("event-group");
    const stamp = container.querySelector(
      `a[href*="event-${first.id}"]`,
    ) as HTMLAnchorElement | null;
    expect(stamp).toBeTruthy();
    expect(stamp?.title).toBe(`${first.created_at} – ${last.created_at}`);
    expect(stamp?.textContent).toBe(
      new Date(first.created_at).toLocaleString(),
    );
  });

  it("renders references as a resident block list, no expander (T-99)", async () => {
    const first = event({
      event_type: "referenced",
      payload: { by_issue: 7, by_comment: 42 },
      created_at: "2026-08-13T08:00:00.000Z",
    });
    const last = event({
      event_type: "referenced",
      payload: { by_issue: 9 },
      created_at: "2026-08-13T14:30:00.000Z",
    });
    const { findByTestId, queryByTestId, container } = renderWithProviders(
      <EventGroup
        family="referenced"
        events={[first, last]}
        slug="p"
        issueNumber={1}
      />,
    );
    const group = await findByTestId("event-group");
    expect(group.textContent).toContain("referenced 2 times");
    expect(queryByTestId("event-group-toggle")).toBeNull();

    // Anchors sit on the resident list rows — `#event-N` deep links land
    // without any expansion — and each row's created_at is its tooltip.
    for (const e of [first, last]) {
      const row = container.querySelector(`li[id="event-${e.id}"]`);
      expect(row).toBeTruthy();
      expect(row?.getAttribute("title")).toBe(e.created_at);
    }
    await waitFor(() => {
      expect(container.querySelector('[data-issue-link="7"]')).toBeTruthy();
      expect(container.querySelector('[data-issue-link="9"]')).toBeTruthy();
    });
    // The by_comment deep link survives the move into the list.
    await waitFor(() =>
      expect(container.querySelector('[data-comment-link="42"]')).toBeTruthy(),
    );

    // Header stamp: first event's permalink, range tooltip.
    const stamp = container.querySelector(
      `a[href*="event-${first.id}"]`,
    ) as HTMLAnchorElement | null;
    expect(stamp?.title).toBe(`${first.created_at} – ${last.created_at}`);
  });

  it("renders a lone reference through the same block list (T-99)", async () => {
    const only = event({
      event_type: "referenced",
      payload: { by_issue: 7, by_comment: 42 },
      created_at: "2026-08-13T08:00:00.000Z",
    });
    const { findByTestId, queryByTestId, container } = renderWithProviders(
      <EventGroup
        family="referenced"
        events={[only]}
        slug="p"
        issueNumber={1}
      />,
    );
    const group = await findByTestId("event-group");
    expect(group.textContent).toContain("referenced 1 time");
    expect(group.textContent).not.toContain("1 times");
    expect(queryByTestId("event-group-toggle")).toBeNull();
    expect(container.querySelector(`li[id="event-${only.id}"]`)).toBeTruthy();
    // A single event needs no range — the stamp tooltip is its timestamp.
    const stamp = container.querySelector(
      `a[href*="event-${only.id}"]`,
    ) as HTMLAnchorElement | null;
    expect(stamp?.title).toBe(only.created_at);
  });

  it("points each source at its own project (T-256)", async () => {
    const local = event({
      event_type: "referenced",
      payload: { by_issue: 7 },
    });
    const cross = event({
      event_type: "cross_referenced",
      payload: { by_project: "mirror", by_project_id: 2, by_issue: 3 },
    });
    const { findByTestId, container } = renderWithProviders(
      <EventGroup
        family="referenced"
        events={[local, cross]}
        slug="todou"
        issueNumber={1}
      />,
      crossClient([
        ["todou", refItem(7, "Local source")],
        ["mirror", refItem(3, "Mirror source")],
      ]),
    );
    const group = await findByTestId("event-group");
    expect(group.textContent).toContain("referenced 2 times");

    const localLink = await waitFor(() => {
      const el = container.querySelector('a[data-issue-link="7"]');
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    expect(localLink.getAttribute("href")).toBe("/projects/todou/issues/7");

    // The guard on the list row's own resolution: spelling by_issue in this
    // project's terms lands on todou#3, a real card and therefore a wrong
    // link nothing later can catch.
    const crossLink = await waitFor(() => {
      const el = container.querySelector('a[data-issue-project="mirror"]');
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    expect(crossLink.getAttribute("href")).toBe("/projects/mirror/issues/3");
    expect(crossLink.textContent).toContain("Mirror source");
  });

  it("keeps a blanked source in the list, unlinked (T-256)", async () => {
    // Only a reader who cannot see the source project gets the blanked
    // payload, and the local stack's single-mode login can read every
    // project — so this row exists nowhere but here.
    const moved = event({
      event_type: "cross_referenced",
      payload: { by_project: null, by_issue: 3, by_moved: true },
    });
    const { findByTestId, container } = renderWithProviders(
      <EventGroup
        family="referenced"
        events={[moved]}
        slug="todou"
        issueNumber={1}
      />,
      crossClient(),
    );
    await findByTestId("event-group");
    const row = container.querySelector(`li[id="event-${moved.id}"]`);
    expect(row).toBeTruthy();
    expect(row?.textContent).toBe("a card that has since moved");
    expect(row?.querySelector("a")).toBeNull();
  });

  it("deep-links a cross-project source to its comment (T-256)", async () => {
    const cross = event({
      event_type: "cross_referenced",
      payload: {
        by_project: "mirror",
        by_project_id: 2,
        by_issue: 3,
        by_comment: 42,
      },
    });
    const { container } = renderWithProviders(
      <EventGroup
        family="referenced"
        events={[cross]}
        slug="todou"
        issueNumber={1}
      />,
      crossClient([["mirror", refItem(3, "Mirror source")]]),
    );
    const link = await waitFor(() => {
      const el = container.querySelector('a[data-comment-link="42"]');
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    expect(link.getAttribute("href")).toBe(
      "/projects/mirror/issues/3#comment-42",
    );
  });

  it("links every attached file", async () => {
    const fileEvents = [
      event({
        event_type: "attachment_added",
        payload: { attachment: { id: 5, filename: "before.png" } },
      }),
      event({
        event_type: "attachment_added",
        payload: { attachment: { id: 6, filename: "after.png" } },
      }),
    ];
    const { findByTestId } = renderWithProviders(
      <EventGroup
        family="attachments"
        events={fileEvents}
        slug="p"
        issueNumber={1}
      />,
    );
    const group = await findByTestId("event-group");
    expect(group.textContent).toContain("attached");
    expect(group.textContent).toContain("before.png");
    expect(group.textContent).toContain("after.png");
  });
});
