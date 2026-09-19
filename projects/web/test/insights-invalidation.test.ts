import { QueryClient } from "@tanstack/react-query";
import type { ChangeEvent } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { insightsKeys, invalidateInsights } from "../src/api/insights.ts";
import {
  coalesceBatch,
  invalidationsFor,
  reconnectInvalidations,
} from "../src/api/useUserEvents.ts";

const slug = "demo";
const burn = { key: insightsKeys.burn(slug), scope: "refetch" as const };
const settings = {
  key: insightsKeys.settings(slug),
  scope: "refetch" as const,
};
const event: ChangeEvent = { entity: "issue", id: 1, action: "updated" };

describe("insights event invalidation", () => {
  it("invalidates every burn range even without an issue pointer", () => {
    expect(invalidationsFor(event, slug)).toEqual([
      { key: ["issues", slug], scope: "refetch" },
      burn,
      { key: ["search-issue-ref"], scope: "refetch" },
      { key: ["search-comment-ref"], scope: "refetch" },
      { key: ["search-comment-location"], scope: "refetch" },
      { key: ["activity-project", slug], scope: "refetch" },
      { key: ["activity-user"], scope: "refetch" },
    ]);
  });

  it("keeps precise issue-list verdicts while invalidating burn broadly", () => {
    expect(
      invalidationsFor(
        { ...event, issue_number: 4, list_row: { kind: "gone" } },
        slug,
      ),
    ).toEqual([
      {
        key: ["issues", slug],
        scope: { issueRows: [{ verdict: "gone", number: 4 }] },
      },
      { key: ["issue", slug, 4], scope: "refetch" },
      { key: ["timeline", slug, 4], scope: "refetch" },
      burn,
      { key: ["search-issue-ref"], scope: "refetch" },
      { key: ["search-comment-ref"], scope: "refetch" },
      { key: ["search-comment-location"], scope: "refetch" },
      { key: ["activity-project", slug], scope: "refetch" },
      { key: ["activity-user"], scope: "refetch" },
    ]);
  });

  it.each(["created", "updated", "deleted"] as const)(
    "covers issue %s and missing list-row answers",
    (action) => {
      expect(
        invalidationsFor({ ...event, action, issue_number: 4 }, slug),
      ).toEqual([
        { key: ["issues", slug], scope: "refetch" },
        { key: ["issue", slug, 4], scope: "refetch" },
        { key: ["timeline", slug, 4], scope: "refetch" },
        burn,
        { key: ["search-issue-ref", slug, 4], scope: "refetch" },
        { key: ["search-comment-ref", slug, 4], scope: "refetch" },
        { key: ["search-comment-location"], scope: "refetch" },
        { key: ["activity-project", slug], scope: "refetch" },
        { key: ["activity-user"], scope: "refetch" },
      ]);
    },
  );

  it("refreshes definitions, effective settings, and all burn ranges on status changes", () => {
    expect(invalidationsFor({ ...event, entity: "status" }, slug)).toEqual([
      { key: ["statuses", slug], scope: "refetch" },
      { key: ["issues", slug], scope: "refetch" },
      settings,
      burn,
      { key: ["activity-project", slug], scope: "refetch" },
      { key: ["activity-user"], scope: "refetch" },
    ]);
  });

  it("covers settings writes announced as project changes", () => {
    expect(invalidationsFor({ ...event, entity: "project" }, slug)).toEqual([
      { key: ["project", slug], scope: "refetch" },
      { key: ["projects"], scope: "refetch" },
      settings,
      burn,
      { key: ["reference-directory"], scope: "refetch" },
      { key: ["reference-config"], scope: "refetch" },
      { key: ["search-issue-ref"], scope: "refetch" },
      { key: ["search-comment-ref"], scope: "refetch" },
      { key: ["search-comment-location"], scope: "refetch" },
      { key: ["activity-project", slug], scope: "refetch" },
      { key: ["activity-user"], scope: "refetch" },
    ]);
    expect(
      invalidationsFor({ ...event, entity: "project" }, "other"),
    ).toContainEqual({
      key: insightsKeys.burn("other"),
      scope: "refetch",
    });
  });

  it("refreshes burn for timeline but not unrelated rendered entities", () => {
    expect(
      invalidationsFor({ ...event, entity: "timeline", issue_number: 4 }, slug),
    ).toContainEqual(burn);
    for (const entity of ["comment", "attachment", "spec", "label"] as const) {
      expect(
        invalidationsFor({ ...event, entity, issue_number: 4 }, slug),
      ).not.toContainEqual(burn);
    }
  });

  it("coalesces repeated project-level burn invalidations", () => {
    const batch = coalesceBatch([
      ...invalidationsFor({ ...event, issue_number: 4 }, slug),
      ...invalidationsFor({ ...event, issue_number: 5 }, slug),
      ...invalidationsFor({ ...event, entity: "project" }, slug),
    ]);
    expect(batch.filter((entry) => entry.key[0] === "insights-burn")).toEqual([
      burn,
    ]);
  });

  it("reconnects invalidate both namespaces across all projects and versions", () => {
    const prefixes = reconnectInvalidations();
    expect(prefixes).toContainEqual(insightsKeys.settings());
    expect(prefixes).toContainEqual(insightsKeys.burn());
    expect(
      prefixes.filter((key) => String(key[0]).startsWith("insights-")),
    ).toEqual([insightsKeys.settings(), insightsKeys.burn()]);
  });
});

describe("settings mutation invalidation", () => {
  it("marks all project ranges and versions stale but leaves other projects alone", async () => {
    const client = new QueryClient();
    const request = {
      from: "2026-03-01",
      to: "2026-03-09",
      grain: "auto" as const,
      tz: "UTC",
    };
    const keys = [
      insightsKeys.settings(slug),
      insightsKeys.burnRequest(slug, request, "v1"),
      insightsKeys.burnRequest(slug, { ...request, grain: "1d" }, "v2"),
      insightsKeys.burnRequest(slug, { ...request, tz: "Asia/Tokyo" }, "v1"),
      insightsKeys.burnRequest(slug, { ...request, from: "2026-03-02" }, "v1"),
    ];
    const otherKey = insightsKeys.burnRequest("other", request, "v1");
    try {
      for (const key of [...keys, otherKey])
        client.setQueryData(key, { cached: true });
      await invalidateInsights(client, slug);
      for (const key of keys)
        expect(client.getQueryState(key)?.isInvalidated).toBe(true);
      expect(client.getQueryState(otherKey)?.isInvalidated).toBe(false);
    } finally {
      client.clear();
    }
  });
});
