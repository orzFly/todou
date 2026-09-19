import { waitFor } from "@testing-library/react";
import type {
  TimelineComment,
  TimelineEvent,
  TimelineItem,
} from "@todou/shared";
import { Component, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { timelineTailOptions } from "../src/api/timeline.ts";
import { EventRow } from "../src/components/timeline/event-row.tsx";
import { Timeline } from "../src/components/timeline/timeline.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const user = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};
const created_at = "2026-09-01T00:00:00Z";
const event = (
  event_type: TimelineEvent["event_type"],
  payload: Record<string, unknown> = {},
): TimelineEvent => ({
  type: "event",
  id: 1,
  event_type,
  payload,
  actor: user,
  created_at,
  agent_context: null,
});
const comment: TimelineComment = {
  type: "comment",
  id: 2,
  author: user,
  body: "Known comment body",
  component: null,
  created_at,
  edited_at: null,
  resolved_at: null,
  hidden_at: null,
  agent_context: null,
};

class CaptureError extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? (
      <div role="alert">{`${this.state.error.name}: ${this.state.error.message}`}</div>
    ) : (
      this.props.children
    );
  }
}

function renderTimeline(items: TimelineItem[]) {
  const client = testQueryClient();
  client.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
  client.setQueryData(timelineTailOptions("p", 1).queryKey, {
    pages: [
      {
        items,
        prev_cursor: null,
        next_cursor: null,
        total_count: items.length,
      },
    ],
    pageParams: [{ dir: "init" }],
  });
  return renderWithProviders(
    <CaptureError>
      <Timeline slug="p" issueNumber={1} pendingComments={[]} />
    </CaptureError>,
    client,
  );
}

const malformed = [undefined, null, "", 42, false, {}, []];

describe("Timeline item dispatch", () => {
  it.each(["future_item", "constructor", "__proto__"])(
    "keeps %s neutral without requiring event fields or swallowing adjacent rows",
    async (type) => {
      const future = { type, id: 3, created_at } as unknown as TimelineItem;
      const view = renderTimeline([event("opened"), future, comment]);
      await waitFor(() => {
        expect(view.getByText(`Unknown timeline item: ${type}`)).toBeTruthy();
        expect(view.getByText("opened this issue")).toBeTruthy();
        expect(view.getByText("Known comment body")).toBeTruthy();
      });
      expect(view.container.querySelector("#event-3")).toBeNull();
      expect(view.queryByRole("alert")).toBeNull();
    },
  );

  it("does not dispatch a future type even when it carries event fields", async () => {
    const future = {
      ...event("opened"),
      type: "future_event_container",
    } as unknown as TimelineItem;
    const view = renderTimeline([future]);
    await waitFor(() =>
      expect(
        view.getByText("Unknown timeline item: future_event_container"),
      ).toBeTruthy(),
    );
    expect(view.queryByText("opened this issue")).toBeNull();
  });

  it.each(malformed)("rejects malformed required type %j", async (type) => {
    const item = { ...event("opened"), type } as unknown as TimelineItem;
    const view = renderTimeline([item]);
    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toContain(
        "TypeError: timeline item type must be a non-empty string",
      ),
    );
  });

  it("still rejects an event missing event_type", async () => {
    const view = renderTimeline([
      { type: "event", id: 3, created_at } as TimelineItem,
    ]);
    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toContain(
        "TypeError: event_type",
      ),
    );
  });
});

describe.each(["block_added", "block_removed"] as const)(
  "EventRow %s role",
  (type) => {
    it.each(["future_role", "constructor", "__proto__"])(
      "preserves %s and scalar payloads without assigning a direction",
      async (role) => {
        const item = event(type, {
          role,
          other_project_id: 7,
          other_number: 23,
          active: true,
        });
        const view = renderWithProviders(<EventRow event={item} />);
        const text = `logged event: ${type} (role=${role}, other_project_id=7, other_number=23, active=true)`;
        await waitFor(() => expect(view.getByText(text)).toBeTruthy());
        expect(view.getByText(text).getAttribute("title")).toBe(text);
        expect(view.container.textContent).not.toMatch(
          /marked this|removed the block|removed this card/,
        );
      },
    );

    it.each(["blocked", "blocker"])(
      "keeps known %s direction",
      async (role) => {
        const view = renderWithProviders(
          <EventRow
            event={event(type, {
              role,
              other_project_id: null,
              other_number: null,
            })}
          />,
        );
        const verb =
          type === "block_added"
            ? role === "blocked"
              ? "marked this blocked by"
              : "marked this a blocker of"
            : role === "blocked"
              ? "removed the block by"
              : "removed this card's block on";
        await waitFor(() => expect(view.container.textContent).toContain(verb));
        expect(view.container.textContent).toContain("a card you cannot see");
        expect(view.container.textContent).not.toContain("logged event");
      },
    );

    it.each(malformed)("rejects malformed required role %j", async (role) => {
      const view = renderWithProviders(
        <CaptureError>
          <EventRow event={event(type, { role })} />
        </CaptureError>,
      );
      await waitFor(() =>
        expect(view.getByRole("alert").textContent).toContain(
          "TypeError: block role must be a non-empty string",
        ),
      );
    });

    it("passes a future role through Timeline grouping", async () => {
      const view = renderTimeline([event(type, { role: "future_role" })]);
      await waitFor(() =>
        expect(
          view.getByText(`logged event: ${type} (role=future_role)`),
        ).toBeTruthy(),
      );
      expect(view.queryByRole("alert")).toBeNull();
    });
  },
);
