import type { TimelineEvent } from "@todou/shared";
import { describe, expect, it } from "vitest";
import {
  type EventRenderContext,
  ICONS,
  renderEvent,
} from "../src/components/timeline/event-row.tsx";
import { NO_ENTITIES } from "../src/components/timeline/use-event-entities.ts";
import { render } from "./render.tsx";

const CONTEXT: EventRenderContext = {
  slug: "demo",
  issueNumber: 7,
  refConfig: { internalPrefix: null, autolinks: [] },
  slugEntries: [],
  entities: NO_ENTITIES,
};

function event(
  eventType: TimelineEvent["event_type"],
  payload: Record<string, unknown>,
): TimelineEvent {
  return {
    type: "event",
    id: 8,
    event_type: eventType,
    actor: {
      id: 1,
      login: "alice",
      display_name: "Alice",
      kind: "human",
      avatar_url: null,
      owner: null,
    },
    created_at: "2026-01-02T12:00:00Z",
    agent_context: null,
    payload,
  };
}

describe("spec withdrawal event rendering", () => {
  it("renders the reason literally even when project reference parsing is enabled", () => {
    const reason =
      "Rework **scope** with @user and #123 [notes](https://example.test) <b>literal</b>";
    const rendered = renderEvent(
      event("spec_withdrawn", { version: 2, reason }),
      CONTEXT,
    );
    const expected = `withdrew spec v2 · reworking — ${reason}`;
    expect(rendered.text).toBe(expected);
    const view = render(<div>{rendered.node}</div>);
    expect(view.container.textContent).toBe(expected);
    expect(view.container.querySelectorAll("a, strong, em, b")).toHaveLength(0);
    expect(ICONS.spec_withdrawn).toBeTruthy();
  });

  it("omits the reason separator when no reason was supplied", () => {
    const rendered = renderEvent(
      event("spec_withdrawn", { version: 3, reason: null }),
      CONTEXT,
    );
    expect(rendered.text).toBe("withdrew spec v3 · reworking");
    expect(rendered.node).toBe(rendered.text);
  });

  it.each([
    ["approve", "approved spec v2 with 1 comment"],
    ["request_changes", "requested changes on spec v2 with 1 comment"],
    ["comment", "commented on spec v2 with 1 comment"],
  ])("preserves the %s review event wording", (verdict, expected) => {
    expect(
      renderEvent(
        event("spec_review", { version: 2, verdict, annotation_count: 1 }),
        CONTEXT,
      ).text,
    ).toBe(expected);
  });
});
