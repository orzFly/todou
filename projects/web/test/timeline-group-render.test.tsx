import { QueryClient } from "@tanstack/react-query";
import { fireEvent, waitFor } from "@testing-library/react";
import type {
  AgentContext,
  Issue,
  IssueListItem,
  Project,
  ReferenceConfig,
  ReferenceDirectory,
  SpecCommentItem,
  TimelineEvent,
  UserRef,
} from "@todou/shared";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { issueRefQuery } from "../src/api/issue-refs.ts";
import { issueQuery } from "../src/api/issues.ts";
import { membersQuery, projectsQuery } from "../src/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import { specCommentsQuery } from "../src/api/spec.ts";
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

const alice: UserRef = {
  id: 1,
  login: "alice",
  display_name: "Alice",
  kind: "human",
  avatar_url: null,
  owner: null,
};

const agent: UserRef = {
  id: 3,
  login: "claude-agent",
  display_name: "Claude Agent",
  kind: "machine",
  avatar_url: null,
  owner: { id: 1, login: "alice" },
};

const newcomer: UserRef = {
  id: 4,
  login: "newcomer",
  display_name: "Newcomer",
  kind: "human",
  avatar_url: null,
  owner: null,
};

/** Assignment payloads carry `{id, login}`, so the display name on screen
    can only come from the member list. */
const assign = (type: "assigned" | "unassigned", user: UserRef, at: string) =>
  event({
    event_type: type,
    payload: { user: { id: user.id, login: user.login } },
    created_at: at,
  });

/** The gesture the card reported: the middle assignee is picked and taken
    back off, leaving one person out and one person in. */
const handOff = () => [
  assign("unassigned", alice, "2026-08-13T12:00:32.000Z"),
  assign("assigned", agent, "2026-08-13T12:00:32.500Z"),
  assign("unassigned", agent, "2026-08-13T12:00:33.000Z"),
  assign("assigned", newcomer, "2026-08-13T12:00:34.000Z"),
];

const move = (from: [number, string], to: [number, string], at: string) =>
  event({
    event_type: "status_changed",
    payload: {
      from: { id: from[0], name: from[1] },
      to: { id: to[0], name: to[1] },
    },
    created_at: at,
  });

let nextFileId = 50;
const file = (filename: string) =>
  event({
    event_type: "attachment_added",
    payload: { attachment: { id: nextFileId++, filename } },
  });

/**
 * lucide puts the icon's identity in its own `lucide-*` class and everything
 * else we asked for beside it, so one split separates "which icon" from
 * "where it sits". Read off `classList`, never off the joined string:
 * `lucide-file-text` contains `lucide-file`, and a substring test would let
 * the fallback icon's assertion pass on a text file.
 */
const identityOf = (icon: Element | null | undefined) =>
  [...(icon?.classList ?? [])].find((c) => c.startsWith("lucide-")) ?? null;

const geometryOf = (icon: Element) =>
  [...icon.classList].filter((c) => !c.startsWith("lucide")).sort();

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
  muted: null,
  blocked_by: [],
  blocks: [],
  moves: [],
});

const SINCE = "2026-08-01T00:00:00.000Z";

const configOf = (prefix: string): ReferenceConfig => ({
  format: { prefix, history: [{ prefix, effective_from: SINCE }] },
  autolinks: [],
});

const directory: ReferenceDirectory = {
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

let nextAnnotationId = 4600;
const annotation = (
  over: Partial<SpecCommentItem> & { path?: string; line?: number } = {},
): SpecCommentItem => {
  const { path = "design.md", line = 42, ...rest } = over;
  return {
    comment_id: nextAnnotationId++,
    author: alice,
    created_at: "2026-08-13T11:00:00.000Z",
    body: "why not a column?",
    hidden_at: null,
    anchor: {
      path,
      version: 2,
      line_start: line,
      line_end: line,
      col_start: null,
      col_end: null,
      quote: "one read-time count",
    },
    resolved: null,
    outdated: false,
    current_line_start: line,
    current_line_end: line,
    ...rest,
  };
};

/** One resolve call, settling the annotations it is given. */
const resolveEvent = (items: SpecCommentItem[]) =>
  event({
    event_type: "spec_comments_resolved",
    payload: {
      comment_ids: items.map((i) => i.comment_id),
      paths: items.map((i) => i.anchor.path),
    },
  });

/** An issue whose spec listing the annotation rows can read. */
function specClient(items: SpecCommentItem[]): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(issueQuery("p", 1).queryKey, {
    spec_version: 2,
  } as Issue);
  client.setQueryData(specCommentsQuery("p", 1).queryKey, {
    current_version: 2,
    items,
  });
  return client;
}

/** A project whose assignees the member list can put a name to. */
function memberClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(
    membersQuery("p").queryKey,
    [alice, agent, newcomer].map((user) => ({
      user,
      role: "writer",
      created_at: SINCE,
    })),
  );
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

  it("keeps a source it cannot name in the list, unlinked", async () => {
    // A row whose project the reader's directory does not answer for. The
    // SQL predicate normally keeps such a row out entirely; what is left
    // here is the window while the directory is still loading, and the row
    // must render as something rather than crash the group.
    const unnamed = event({
      event_type: "referenced",
      payload: { by_project_id: 987654, by_issue: 3 },
    });
    const { findByTestId, container } = renderWithProviders(
      <EventGroup
        family="referenced"
        events={[unnamed]}
        slug="todou"
        issueNumber={1}
      />,
      crossClient(),
    );
    await findByTestId("event-group");
    const row = container.querySelector(`li[id="event-${unnamed.id}"]`);
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain("#3");
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

  it("gives every attached file a row and a permalink of its own", async () => {
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
    const { findByTestId, queryByTestId } = renderWithProviders(
      <EventGroup
        family="attachments"
        events={fileEvents}
        slug="p"
        issueNumber={1}
      />,
    );
    const group = await findByTestId("event-group");
    expect(group.textContent).toContain("attached 2 files");

    const rows = [...group.querySelectorAll("li")];
    expect(rows.map((li) => li.textContent)).toEqual([
      "before.png",
      "after.png",
    ]);
    // The `#event-N` targets sit on the rows, so a permalink lands on the
    // file itself with nothing left to expand — and nothing to expand with.
    expect(rows.map((li) => li.id)).toEqual(
      fileEvents.map((e) => `event-${e.id}`),
    );
    expect(queryByTestId("event-group-toggle")).toBeNull();
  });

  it("renders a lone attachment exactly like several", async () => {
    const lone = event({
      event_type: "attachment_added",
      payload: { attachment: { id: 7, filename: "only.png" } },
    });
    const { findByTestId } = renderWithProviders(
      <EventGroup
        family="attachments"
        events={[lone]}
        slug="p"
        issueNumber={1}
      />,
    );
    const group = await findByTestId("event-group");
    expect(group.textContent).toContain("attached 1 file");
    const rows = [...group.querySelectorAll("li")];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toBe("only.png");
    expect(rows[0]?.id).toBe(`event-${lone.id}`);
  });

  it("reads a hand-off as an arrow between the two who net out", async () => {
    const { findByTestId, getByTestId, getByTitle, queryByTitle } =
      renderWithProviders(
        <EventGroup
          family="assignees"
          events={handOff()}
          slug="p"
          issueNumber={1}
        />,
        memberClient(),
      );
    const group = await findByTestId("event-group");
    expect(getByTitle("reassigned Alice → Newcomer")).toBeTruthy();
    // The assignee who was picked and dropped is cancelled from the summary,
    // and the expander is where it stays readable.
    expect(group.textContent).not.toContain("Claude Agent");

    fireEvent.click(getByTestId("event-group-toggle"));
    await waitFor(() => {
      expect(queryByTitle("assigned Claude Agent")).toBeTruthy();
      expect(queryByTitle("unassigned Claude Agent")).toBeTruthy();
    });
  });

  it("spells both halves out when the net is not one for one", async () => {
    const { findByTitle } = renderWithProviders(
      <EventGroup
        family="assignees"
        events={[
          assign("unassigned", alice, "2026-08-13T12:00:32.000Z"),
          assign("assigned", agent, "2026-08-13T12:00:33.000Z"),
          assign("assigned", newcomer, "2026-08-13T12:00:34.000Z"),
        ]}
        slug="p"
        issueNumber={1}
      />,
      memberClient(),
    );
    await findByTitle("assigned Claude Agent, Newcomer · unassigned Alice");
  });

  it("leaves out the half with nobody in it", async () => {
    const { findByTestId, getByTitle } = renderWithProviders(
      <EventGroup
        family="assignees"
        events={[
          assign("assigned", agent, "2026-08-13T12:00:33.000Z"),
          assign("assigned", newcomer, "2026-08-13T12:00:34.000Z"),
        ]}
        slug="p"
        issueNumber={1}
      />,
      memberClient(),
    );
    await findByTestId("event-group");
    const summary = getByTitle("assigned Claude Agent, Newcomer");
    expect(summary.textContent).not.toContain("·");
    expect(summary.textContent).not.toContain("unassigned");
  });

  it("prints a run that cancels out in full, dimmed", async () => {
    const { findByTestId, getByTitle } = renderWithProviders(
      <EventGroup
        family="assignees"
        events={[
          assign("assigned", agent, "2026-08-13T12:00:33.000Z"),
          assign("unassigned", agent, "2026-08-13T12:00:34.000Z"),
        ]}
        slug="p"
        issueNumber={1}
      />,
      memberClient(),
    );
    await findByTestId("event-group");
    const summary = getByTitle(
      "assigned Claude Agent · unassigned Claude Agent",
    );
    expect(summary.className).toContain("text-muted-foreground/60");
  });

  it("takes the header icon from the summary, not the first event", async () => {
    // The hand-off opens with an unassigned event, so the first event's icon
    // would contradict the sentence beside it.
    const { findByTestId, container } = renderWithProviders(
      <EventGroup
        family="assignees"
        events={handOff()}
        slug="p"
        issueNumber={1}
      />,
      memberClient(),
    );
    await findByTestId("event-group");
    expect(container.querySelectorAll("svg.lucide-user-plus")).toHaveLength(1);
    expect(container.querySelector("svg.lucide-user-minus")).toBeNull();
  });

  it("keeps the leaving icon when the net only lets people go", async () => {
    const { findByTestId, container } = renderWithProviders(
      <EventGroup
        family="assignees"
        events={[
          assign("unassigned", alice, "2026-08-13T12:00:33.000Z"),
          assign("unassigned", newcomer, "2026-08-13T12:00:34.000Z"),
        ]}
        slug="p"
        issueNumber={1}
      />,
      memberClient(),
    );
    await findByTestId("event-group");
    expect(container.querySelectorAll("svg.lucide-user-minus")).toHaveLength(1);
    expect(container.querySelector("svg.lucide-user-plus")).toBeNull();
  });

  it("gives every attached row one icon, inside its link (T-401)", async () => {
    const { findByTestId } = renderWithProviders(
      <EventGroup
        family="attachments"
        events={[file("before.png"), file("notes.md")]}
        slug="p"
        issueNumber={1}
      />,
    );
    const group = await findByTestId("event-group");
    const rows = [...group.querySelectorAll("li")];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // Inside the anchor, so the icon is part of the click target and of
      // what a copied link visually belongs to.
      const icons = [...row.querySelectorAll("a svg")];
      expect(icons).toHaveLength(1);
      expect(geometryOf(icons[0] as Element)).toEqual([
        "align-middle",
        "inline",
        "mr-0.5",
        "size-3.5",
      ]);
    }
  });

  it("draws each attached row from its own file type (T-401)", async () => {
    const { findByTestId } = renderWithProviders(
      <EventGroup
        family="attachments"
        events={[
          file("shot.png"),
          file("notes.md"),
          file("bundle.zip"),
          // The older tiers get the first look: `.ts` is TypeScript here,
          // not the MPEG transport stream the video tier would claim.
          file("index.ts"),
        ]}
        slug="p"
        issueNumber={1}
      />,
    );
    const group = await findByTestId("event-group");
    const rows = [...group.querySelectorAll("li")];
    expect(rows.map((row) => identityOf(row.querySelector("a svg")))).toEqual([
      "lucide-image",
      "lucide-file-text",
      "lucide-file-archive",
      "lucide-file-text",
    ]);
  });

  it("leaves the paperclip on the attached group's header (T-401)", async () => {
    const { findByTestId } = renderWithProviders(
      <EventGroup
        family="attachments"
        events={[file("shot.png"), file("bundle.zip")]}
        slug="p"
        issueNumber={1}
      />,
    );
    const group = await findByTestId("event-group");
    // The header's own icon slot, ahead of the actor chip and the harness
    // badge — both of which also draw an svg up there.
    const headerIcon = group.firstElementChild?.firstElementChild;
    expect(identityOf(headerIcon?.querySelector("svg"))).toBe(
      "lucide-paperclip",
    );
    // The division of labour: the header says "an attachment event", the
    // rows say which file. Neither one repeats the other.
    expect([...group.querySelectorAll("ul li a svg")].map(identityOf)).toEqual([
      "lucide-image",
      "lucide-file-archive",
    ]);
  });

  it("sits an attached row's icon where a referenced row's sits (T-401)", async () => {
    const referenced = event({
      event_type: "referenced",
      payload: { by_issue: 7 },
    });
    const { container } = renderWithProviders(
      <>
        <EventGroup
          family="referenced"
          events={[referenced]}
          slug="todou"
          issueNumber={1}
        />
        <EventGroup
          family="attachments"
          events={[file("shot.png")]}
          slug="todou"
          issueNumber={1}
        />
      </>,
      crossClient([["todou", refItem(7, "Local source")]]),
    );
    const rowIconOf = (groupIndex: number) =>
      waitFor(() => {
        const groups = container.querySelectorAll(
          '[data-testid="event-group"]',
        );
        expect(groups).toHaveLength(2);
        const icon = groups[groupIndex]?.querySelector("ul li a svg");
        expect(icon).not.toBeNull();
        return geometryOf(icon as Element);
      });
    const onReferences = await rowIconOf(0);
    const onAttachments = await rowIconOf(1);
    // Two icons carrying no geometry at all would also be "equal", and the
    // absolute values are pinned one test above.
    expect(onReferences).not.toHaveLength(0);
    expect(onAttachments).toEqual(onReferences);
  });

  it("gives every resolved annotation a row, counting annotations", async () => {
    const a = annotation({ line: 42, body: "why not a column?" });
    const b = annotation({ line: 91, body: "this reads two ways" });
    const c = annotation({ path: "plan.md", line: 7, body: "no verification" });
    const events = [resolveEvent([a, b]), resolveEvent([c])];
    const { findByTestId } = renderWithProviders(
      <EventGroup
        family="spec_resolved"
        events={events}
        slug="p"
        issueNumber={1}
      />,
      specClient([a, b, c]),
    );
    const group = await findByTestId("event-group");
    // Two events, three annotations: the header counts what the rows are.
    expect(group.textContent).toContain("resolved 3 spec comments");
    const rows = [...group.querySelectorAll("li")];
    expect(rows.map((li) => li.textContent)).toEqual([
      "design.md L42“why not a column?”",
      "design.md L91“this reads two ways”",
      "plan.md L7“no verification”",
    ]);
  });

  it("puts each event's anchor on the first row it produced", async () => {
    const a = annotation({ line: 42 });
    const b = annotation({ line: 91 });
    const c = annotation({ path: "plan.md", line: 7 });
    const [first, second] = [resolveEvent([a, b]), resolveEvent([c])];
    if (!first || !second) throw new Error("no events");
    const { findByTestId } = renderWithProviders(
      <EventGroup
        family="spec_resolved"
        events={[first, second]}
        slug="p"
        issueNumber={1}
      />,
      specClient([a, b, c]),
    );
    const group = await findByTestId("event-group");
    const ids = [...group.querySelectorAll("li")].map((li) =>
      li.getAttribute("id"),
    );
    expect(ids).toEqual([`event-${first.id}`, null, `event-${second.id}`]);
  });

  it("folds hidden annotations into a closed block", async () => {
    const shown = [annotation({ line: 42 }), annotation({ line: 91 })];
    const buried = [7, 8, 9].map((line) =>
      annotation({ line, hidden_at: "2026-08-13T12:30:00.000Z" }),
    );
    const all = [...shown, ...buried];
    const { findByTestId, queryByText } = renderWithProviders(
      <EventGroup
        family="spec_resolved"
        events={[resolveEvent(all)]}
        slug="p"
        issueNumber={1}
      />,
      specClient(all),
    );
    const group = await findByTestId("event-group");
    expect(group.textContent).toContain("resolved 5 spec comments");
    const rowsOf = () =>
      [...group.querySelectorAll("li")].map((li) => li.textContent);
    expect(rowsOf()).toEqual([
      "design.md L42“why not a column?”",
      "design.md L91“why not a column?”",
      "3 hidden comments",
    ]);
    // Closed means absent, not merely unstyled: a hidden annotation's anchor
    // must not be readable off the DOM before the reader asks for it.
    expect(queryByText("design.md L7")).toBeNull();

    fireEvent.click(await findByTestId("spec-hidden-toggle"));
    await waitFor(() => {
      expect(rowsOf()).toEqual([
        "design.md L42“why not a column?”",
        "design.md L91“why not a column?”",
        "3 hidden comments",
        "design.md L7",
        "design.md L8",
        "design.md L9",
      ]);
    });
    // Revealed as anchors only — the body the hide took away stays away.
    const revealed = [...group.querySelectorAll("li")].slice(3);
    for (const li of revealed) {
      expect(li.textContent).not.toContain("why not a column?");
      expect(li.querySelector("a")).not.toBeNull();
    }
  });

  it("names an annotation by id when the event predates paths", async () => {
    // The group is the only face this family draws, so the degrade has to be
    // asserted here: renderEvent's own fallback is never what the app shows.
    const old = event({
      event_type: "spec_comments_resolved",
      payload: { comment_ids: [4601] },
    });
    const { findByTestId } = renderWithProviders(
      <EventGroup
        family="spec_resolved"
        events={[old]}
        slug="p"
        issueNumber={1}
      />,
      specClient([]),
    );
    const group = await findByTestId("event-group");
    const rows = [...group.querySelectorAll("li")];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("spec comment #4601");
    // The permalink is what a rejected payload used to lose outright.
    expect(rows[0]?.getAttribute("id")).toBe(`event-${old.id}`);
  });

  it("keeps drawing a payload that carries a key the schema has no name for", async () => {
    // `paths` is present, so this case turns on strictness alone: the sibling
    // case above turns on `paths` being optional, and a mutation that changes
    // both at once would look like either one had been guarded.
    const odd = event({
      event_type: "spec_comments_resolved",
      payload: {
        comment_ids: [4601],
        paths: ["design.md"],
        settled_by: "cleanup",
      },
    });
    const { findByTestId } = renderWithProviders(
      <EventGroup
        family="spec_resolved"
        events={[odd]}
        slug="p"
        issueNumber={1}
      />,
      specClient([]),
    );
    const group = await findByTestId("event-group");
    const rows = [...group.querySelectorAll("li")];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("design.md");
    expect(rows[0]?.getAttribute("id")).toBe(`event-${odd.id}`);
  });

  it("opens the hidden block for an #event-N anchor inside it", async () => {
    const buried = annotation({
      line: 7,
      hidden_at: "2026-08-13T12:30:00.000Z",
    });
    const only = resolveEvent([buried]);
    const { findByTestId } = renderWithProviders(
      <EventGroup
        family="spec_resolved"
        events={[only]}
        slug="p"
        issueNumber={1}
        anchorEventId={only.id}
      />,
      specClient([buried]),
    );
    const group = await findByTestId("event-group");
    await waitFor(() => {
      const rows = [...group.querySelectorAll("li")];
      // Singular, and the anchored row is out where the hash can reach it.
      expect(rows.map((li) => li.textContent)).toEqual([
        "1 hidden comment",
        "design.md L7",
      ]);
      expect(rows[1]?.getAttribute("id")).toBe(`event-${only.id}`);
    });
  });
});

describe("a group header's actor links to their page (T-391)", () => {
  // The header only — the expanded rows and the resident block list are
  // siblings of it, so a chip down there cannot answer for the header's.
  const headerLinksIn = (group: HTMLElement) =>
    [
      ...(group.firstElementChild as HTMLElement).querySelectorAll(
        'a[href^="/users/"]',
      ),
    ].map((a) => a.getAttribute("href"));

  it("links it on a summarized run", async () => {
    const { findByTestId } = renderWithProviders(
      <EventGroup
        family="labels"
        events={[
          label("area:infra", "label_added"),
          label("kind:legacy", "label_removed"),
        ]}
        slug="p"
        issueNumber={1}
      />,
    );
    const group = await findByTestId("event-group");
    expect(headerLinksIn(group)).toEqual(["/users/bot-one"]);
  });

  it("links it on a resident block list", async () => {
    const { findByTestId } = renderWithProviders(
      <EventGroup
        family="referenced"
        events={[
          event({ event_type: "referenced", payload: { by_issue: 7 } }),
          event({ event_type: "referenced", payload: { by_issue: 9 } }),
        ]}
        slug="p"
        issueNumber={1}
      />,
      crossClient(),
    );
    const group = await findByTestId("event-group");
    expect(headerLinksIn(group)).toEqual(["/users/bot-one"]);
  });
});

describe("the assignment summary names people you can reach (T-391)", () => {
  it("links each person the summary sentence names", async () => {
    const { findByTestId, getByTitle } = renderWithProviders(
      <EventGroup
        family="assignees"
        events={handOff()}
        slug="p"
        issueNumber={1}
      />,
      memberClient(),
    );
    await findByTestId("event-group");

    // The summary sentence alone. The group header's actor chip is an anchor
    // of its own sitting right beside it, and would answer for these if the
    // whole header were searched. Two different logins for the same reason.
    const summary = getByTitle("reassigned Alice → Newcomer");
    expect(
      [...summary.querySelectorAll('a[href^="/users/"]')].map((a) =>
        a.getAttribute("href"),
      ),
    ).toEqual(["/users/alice", "/users/newcomer"]);
  });
});
