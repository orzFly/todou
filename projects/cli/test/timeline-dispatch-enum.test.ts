import type {
  TimelineComment,
  TimelineEvent,
  TimelineItem,
} from "@todou/shared";
import { describe, expect, it } from "vitest";
import type { Painter } from "../src/format.ts";
import { renderActivityLine, renderTimelineItem } from "../src/timeline.ts";

const paint: Painter = (_style, text) => text;
const ctx = {
  issueNumber: 1,
  refPrefix: "T",
  refLabel: "T-1",
  summaryChars: 0,
};
const user = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};
const created_at = "2026-09-01T00:00:00Z";
const event: TimelineEvent = {
  type: "event",
  id: 1,
  event_type: "title_changed",
  payload: { from: "Old title", to: "New title" },
  actor: user,
  created_at,
  agent_context: null,
};
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

for (const [name, render] of [
  ["timeline", renderTimelineItem],
  ["activity", renderActivityLine],
] as const) {
  describe(`${name} item dispatch`, () => {
    it.each(["future_item", "constructor", "__proto__"])(
      "renders %s neutrally without requiring event fields",
      (type) => {
        const item = { type, id: 3, created_at } as unknown as TimelineItem;
        const text = render(item, paint, ctx);
        expect(text).toContain(`Unknown timeline item: ${type}`);
        expect(text).not.toMatch(/commented|undefined|renamed/);
        if (name === "activity") expect(text).toMatch(/^T-1 /);
      },
    );

    it("does not dispatch a future type with otherwise valid event fields", () => {
      const item = {
        ...event,
        type: "future_event_container",
      } as unknown as TimelineItem;
      const text = render(item, paint, ctx);
      expect(text).toContain("Unknown timeline item: future_event_container");
      expect(text).not.toMatch(/title_changed|Old title|New title|renamed/);
    });

    it.each([undefined, null, "", 42, false, {}, []])(
      "rejects malformed required type %j",
      (type) => {
        const item = { ...event, type } as unknown as TimelineItem;
        expect(() => render(item, paint, ctx)).toThrow(TypeError);
        expect(() => render(item, paint, ctx)).toThrow("timeline item type");
      },
    );

    it("keeps known comment and event output", () => {
      const commentText = render(comment, paint, ctx);
      expect(commentText).toContain("#comment-2");
      expect(commentText).toContain("User commented");
      expect(commentText).toContain("Known comment body");
      const eventText = render(event, paint, ctx);
      expect(eventText).toContain("User");
      expect(eventText).toContain('"Old title" → "New title"');
      expect(eventText).not.toContain("Unknown timeline item");
    });

    it("keeps a future event_type on the event path with raw details", () => {
      const item = {
        ...event,
        event_type: "future_event",
        payload: { reason: "future reason", count: 3 },
      } as unknown as TimelineEvent;
      const text = render(item, paint, ctx);
      expect(text).toContain("future_event (reason=future reason count=3)");
      expect(text).not.toContain("Unknown timeline item");
    });

    it.each([undefined, null, "", 42])(
      "rejects malformed event_type on a known event: %j",
      (event_type) => {
        const item = { ...event, event_type } as unknown as TimelineItem;
        expect(() => render(item, paint, ctx)).toThrow(TypeError);
      },
    );
  });
}
