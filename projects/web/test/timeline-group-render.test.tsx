import { fireEvent, waitFor } from "@testing-library/react";
import type { AgentContext, TimelineEvent, UserRef } from "@todou/shared";
import { useState } from "react";
import { describe, expect, it } from "vitest";
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

const label = (name: string, type: "label_added" | "label_removed") =>
  event({
    event_type: type,
    payload: { label: { id: 1, name, color: "#0f0" } },
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

describe("EventGroup", () => {
  it("summarizes a mixed labels run GitHub-style", async () => {
    const { findByTestId } = renderWithProviders(
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
    expect(group.textContent).toContain("added labels area:infra, area:docs");
    expect(group.textContent).toContain("removed label kind:legacy");
    expect(group.textContent).toContain("3 items");
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

  it("expands to raw rows without repeating the actor", async () => {
    const { findByTestId, getByTestId, getAllByText, queryByText } =
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
    expect(queryByText("added label area:infra")).toBeNull();

    const toggle = getByTestId("event-group-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    await waitFor(() => {
      expect(queryByText("added label area:infra")).toBeTruthy();
      expect(queryByText("added label area:docs")).toBeTruthy();
    });
    // The header names the actor once; expanded sub-rows must not repeat it.
    expect(getAllByText("bot-one")).toHaveLength(1);

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(queryByText("added label area:infra")).toBeNull(),
    );
  });

  it("mounts expanded when the anchored event is inside", async () => {
    const events = [
      label("area:infra", "label_added"),
      label("area:docs", "label_added"),
    ];
    const { findByText } = renderWithProviders(
      <EventGroup
        family="labels"
        events={events}
        slug="p"
        issueNumber={1}
        anchorEventId={events[1]?.id}
      />,
    );
    await findByText("added label area:docs");
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
    const { findByTestId, getByTestId, queryByText } = renderWithProviders(
      <Harness />,
    );
    await findByTestId("event-group");
    expect(queryByText("added label area:docs")).toBeNull();

    fireEvent.click(getByTestId("set-anchor"));
    await waitFor(() =>
      expect(queryByText("added label area:docs")).toBeTruthy(),
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
