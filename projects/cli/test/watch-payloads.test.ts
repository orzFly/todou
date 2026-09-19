import type { ActivityItem, TimelineEvent } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { renderTimelineItem } from "../src/timeline.ts";
import { fakeFetch, loggedInEnv, parseNdjson, runCli } from "./harness.ts";

const actor = {
  id: 5,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};
const event = (
  event_type: TimelineEvent["event_type"],
  payload: Record<string, unknown>,
): TimelineEvent & { issue_number: number } => ({
  type: "event",
  id: 81,
  event_type,
  actor,
  payload,
  created_at: "2026-08-11T12:00:00Z",
  agent_context: null,
  issue_number: 7,
});

// Same shape as the actual activity/watch answer that triggered T-465;
// identifiers and text are synthetic. In particular, `via` is present.
const selected = {
  key: "q1",
  other: null,
  declined: false,
  selected: [{ index: 2, label: "Keep the reading order" }],
};
const answerForms = [
  { name: "selection", answer: selected, text: "q1=Keep the reading order" },
  {
    name: "declined",
    answer: { key: "q1", other: null, declined: true, selected: [] },
    text: "q1=declined",
  },
  {
    name: "other",
    answer: {
      key: "q1",
      other: "Use another order\nKeep the labels",
      declined: false,
      selected: [],
    },
    text: "q1=Use another order\n  Keep the labels",
  },
];
const metadata = { future_metadata: { source: "web", tags: ["answer"] } };

async function watch(item: ActivityItem, cross: boolean, json = false) {
  const path = cross ? "/api/activity" : "/api/projects/demo/activity";
  const wireItem = cross ? { ...item, project: "demo" } : item;
  const { fetchImpl, calls } = fakeFetch([
    ["GET", "/api/me", actor],
    [
      "GET",
      "/api/projects/demo/references/config",
      { format: { prefix: "D", history: [] }, autolinks: [] },
    ],
    [
      "GET",
      path,
      (_init: RequestInit, url: URL) =>
        url.searchParams.get("after") === "before"
          ? { items: [wireItem], next_cursor: "after", has_more: false }
          : { items: [], next_cursor: null, has_more: false },
    ],
  ]);
  const result = await runCli(
    [
      "watch",
      ...(cross ? ["--all-projects"] : ["-p", "demo"]),
      "--poll",
      "--any-actor",
      "--since",
      "before",
      ...(json ? ["--json"] : []),
    ],
    { fetchImpl, env: loggedInEnv() },
  );
  expect(result.exitCode, result.stderr).toBe(0);
  expect(calls.some((call) => new URL(call.url).pathname === path)).toBe(true);
  expect(calls.some((call) => call.url.includes("/timeline"))).toBe(false);
  return result;
}

for (const cross of [false, true]) {
  describe(`watch structured payloads: ${cross ? "cross-project" : "project"} activity`, () => {
    for (const { name, answer, text } of answerForms) {
      for (const extension of [false, true]) {
        it(`renders ${name}${extension ? " with added metadata" : " from the current wire shape"} and preserves full JSON`, async () => {
          const payload = {
            via: "answer",
            answers: [answer],
            comment_id: 17,
            ...(extension ? metadata : {}),
          };
          const item = event("question_answered", payload);
          const human = await watch(item, cross);
          // These assertions exercise renderActivityLine through WatchCommand:
          // removing its answer branch must fail, even though JSON still works.
          expect(human.stdout).toContain("D-7 User answered #comment-17");
          expect(human.stdout).toContain(text);
          expect(human.stdout).not.toContain("question_answered (");
          const json = parseNdjson<{ payload: unknown }>(
            (await watch(item, cross, true)).stdout,
          );
          expect(json.items).toHaveLength(1);
          expect(json.items[0]?.payload).toEqual(payload);
          expect(json.cursor.next_cursor).toBe("after");
        });
      }
    }

    it.each([
      {
        name: "legacy answer without via",
        payload: { answers: [selected], comment_id: 17 },
        text: "q1=Keep the reading order",
      },
      {
        name: "hide decline",
        payload: {
          via: "hide",
          answers: [{ key: "q1", other: null, declined: true, selected: [] }],
          comment_id: 17,
        },
        text: "q1=declined",
      },
    ])("renders $name", async ({ payload, text }) => {
      expect(
        (await watch(event("question_answered", payload), cross)).stdout,
      ).toContain(text);
    });

    it.each([
      {
        type: "spec_pushed" as const,
        payload: {
          version: 2,
          message: "Ready for review",
          added: ["a.md"],
          changed: ["b.md"],
          removed: [],
        },
        text: "v2: 1 added, 1 changed — Ready for review",
        invalid: { added: "invalid" },
      },
      {
        type: "spec_withdrawn" as const,
        payload: { version: 2, reason: "Rework needed" },
        text: "v2 — Rework needed",
        invalid: { version: "invalid" },
      },
      {
        type: "spec_review" as const,
        payload: {
          version: 2,
          verdict: "request_changes",
          comment_id: 17,
          annotation_count: 2,
        },
        text: "v2 changes requested, 2 annotation(s)",
        invalid: { verdict: "invalid" },
      },
    ])(
      "renders $type with metadata, retaining validation and JSON",
      async ({ type, payload: core, text, invalid }) => {
        const payload = { ...core, ...metadata };
        const item = event(type, payload);
        expect((await watch(item, cross)).stdout).toContain(text);
        expect(
          parseNdjson<{ payload: unknown }>(
            (await watch(item, cross, true)).stdout,
          ).items[0]?.payload,
        ).toEqual(payload);
        const malformed = { ...payload, ...invalid };
        expect(
          (await watch(event(type, malformed), cross)).stdout,
        ).not.toContain(text);
        expect(
          parseNdjson<{ payload: unknown }>(
            (await watch(event(type, malformed), cross, true)).stdout,
          ).items[0]?.payload,
        ).toEqual(malformed);
      },
    );

    it.each([
      { comment_id: "invalid" },
      { via: "invalid" },
      { answers: [{ ...selected, selected: [{ index: 2, label: 42 }] }] },
      { answers: [{ ...selected, declined: "invalid" }] },
      { answers: [{ ...selected, other: 42 }] },
    ])(
      "keeps malformed known answer fields on the fallback path: %j",
      async (invalid) => {
        const payload = {
          via: "answer",
          comment_id: 17,
          answers: [selected],
          ...metadata,
          ...invalid,
        };
        const item = event("question_answered", payload);
        const human = await watch(item, cross);
        expect(human.stdout).toContain("question_answered (");
        expect(human.stdout).not.toContain("answered #comment-17");
        expect(
          parseNdjson<{ payload: unknown }>(
            (await watch(item, cross, true)).stdout,
          ).items[0]?.payload,
        ).toEqual(payload);
      },
    );
  });
}

it("keeps all answer forms readable in the full timeline with added metadata", () => {
  const item = event("question_answered", {
    via: "answer",
    comment_id: 17,
    answers: answerForms.map(({ answer }) => answer),
    ...metadata,
  });
  const text = renderTimelineItem(item, (_style, value) => value, {
    issueNumber: 7,
    refPrefix: "D",
  });
  expect(text).toContain("User answered #comment-17");
  expect(text).toContain("q1: 3) Keep the reading order");
  expect(text).toContain("q1: declined");
  expect(text).toContain('q1: other: "Use another order\\nKeep the labels"');
});
