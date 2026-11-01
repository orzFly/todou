import type { TimelineEvent } from "@todou/shared";
import { describe, expect, it } from "vitest";
import {
  type EventRenderContext,
  ICONS,
  renderEvent,
} from "../src/components/timeline/event-row.tsx";
import { NO_ENTITIES } from "../src/components/timeline/use-event-entities.ts";
import { renderWithProviders } from "./render.tsx";

const CONTEXT: EventRenderContext = {
  slug: "demo",
  issueNumber: 7,
  refConfig: { internalPrefix: null, autolinks: [] },
  slugEntries: [],
  entities: NO_ENTITIES,
};

function event(payload: Record<string, unknown>): TimelineEvent {
  return {
    type: "event",
    id: 8,
    event_type: "question_withdrawn",
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

describe("question withdrawal event rendering", () => {
  it("links to the comment and keeps the reason literal", async () => {
    const reason = "answered in #12 by @alice, see **notes**";
    const rendered = renderEvent(event({ comment_id: 42, reason }), CONTEXT);
    const expected = `withdrew questions — ${reason}`;
    expect(rendered.text).toBe(expected);
    const view = renderWithProviders(<div>{rendered.node}</div>);
    const link = await view.findByRole("link", { name: "withdrew questions" });
    expect(link.getAttribute("href")).toBe(
      "/projects/demo/issues/7#comment-42",
    );
    expect(view.container.textContent).toBe(expected);
    // Only the comment link: the reason's ref and mention are not linked.
    expect(view.container.querySelectorAll("a")).toHaveLength(1);
    expect(view.container.querySelectorAll("strong, em, b")).toHaveLength(0);
    expect(ICONS.question_withdrawn).toBeTruthy();
  });

  it("ends at the link when no reason was given", () => {
    const rendered = renderEvent(
      event({ comment_id: 42, reason: null }),
      CONTEXT,
    );
    expect(rendered.text).toBe("withdrew questions");
  });
});
