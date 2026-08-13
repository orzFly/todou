import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { specVersionStatsQuery } from "../src/api/spec.ts";
import {
  SpecEntryRow,
  SpecSidebarSection,
} from "../src/components/issue/spec-entry.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const INFO = {
  current_version: 3,
  review_status: "unreviewed",
  unresolved_comments: 0,
  files: [
    { path: "design.md", size: 2048 },
    { path: "phases.md", size: 512 },
  ],
  versions: [],
};

const PUSH_EVENT = {
  type: "event",
  id: 77,
  event_type: "spec_pushed",
  actor: { id: 2, login: "bot", display_name: "Bot", kind: "machine" },
  payload: {
    version: 3,
    message: "round 2",
    added: [],
    changed: ["design.md"],
    removed: [],
  },
  created_at: "2026-08-12T13:00:00Z",
  agent_context: null,
};

/** Records every requested URL; `specVersion` shapes the issue payload. */
function stubFetch(specVersion: number | null = 3): string[] {
  const requested: string[] = [];
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = new URL(String(input), "http://test");
    requested.push(url.pathname + url.search);
    if (url.pathname.endsWith("/issues/1")) {
      return Response.json({
        number: 1,
        spec_version: specVersion,
        spec_review_status: specVersion === null ? null : "unreviewed",
      });
    }
    if (url.pathname.endsWith("/timeline")) {
      return Response.json({
        items: [PUSH_EVENT],
        prev_cursor: null,
        next_cursor: null,
      });
    }
    if (url.pathname.endsWith("/spec/files")) {
      return Response.json(
        url.searchParams.get("version") === "2"
          ? { version: 2, files: [{ path: "design.md", body: "a\n", size: 2 }] }
          : {
              version: 3,
              files: [
                { path: "design.md", body: "a\nb\n", size: 4 },
                { path: "phases.md", body: "p\n", size: 2 },
              ],
            },
      );
    }
    if (url.pathname.endsWith("/spec")) return Response.json(INFO);
    throw new Error(`unexpected fetch: ${url.pathname}`);
  });
  return requested;
}

afterEach(() => vi.unstubAllGlobals());

describe("SpecEntryRow (T-63)", () => {
  it("renders version, status, file count and anchors to the latest push", async () => {
    stubFetch();
    const view = renderWithProviders(<SpecEntryRow slug="p" issueNumber={1} />);
    expect(await view.findByText("Spec v3")).toBeTruthy();
    expect(view.getByText("awaiting review")).toBeTruthy();
    expect(view.getByText("2 files")).toBeTruthy();
    await waitFor(() => {
      const link = view.getByTestId("spec-entry");
      expect(link.getAttribute("href")).toContain("#event-77");
    });
    await view.findByText("+1");
  });

  it("skips the spec probe and push lookup when the issue has no spec (T-91)", async () => {
    const requested = stubFetch(null);
    const view = renderWithProviders(<SpecEntryRow slug="p" issueNumber={1} />);
    await waitFor(() =>
      expect(requested.some((u) => u.includes("/issues/1"))).toBe(true),
    );
    expect(view.queryByTestId("spec-entry")).toBeNull();
    expect(requested.some((u) => u.endsWith("/spec"))).toBe(false);
    expect(requested.some((u) => u.includes("types=spec_pushed"))).toBe(false);
  });
});

describe("specVersionStatsQuery (T-91)", () => {
  it("reuses immutable version snapshots across adjacent stats queries", async () => {
    const requested = stubFetch();
    const client = testQueryClient();
    const payload = (version: number) => ({
      version,
      message: null,
      added: [],
      changed: ["design.md"],
      removed: [],
    });
    // v3's "before" and v2's "after" are the same snapshot — one fetch.
    await client.fetchQuery(specVersionStatsQuery("p", 1, payload(3)));
    await client.fetchQuery(specVersionStatsQuery("p", 1, payload(2)));
    expect(requested.filter((u) => u.includes("version=2"))).toHaveLength(1);
  });
});

describe("SpecSidebarSection (T-63)", () => {
  it("lists files with stats and a review link, no verdict buttons", async () => {
    stubFetch();
    const view = renderWithProviders(
      <SpecSidebarSection slug="p" issueNumber={1} />,
    );
    expect(await view.findByText(/Latest spec/)).toBeTruthy();
    expect(view.getByText("design.md")).toBeTruthy();
    expect(view.getByText("phases.md")).toBeTruthy();
    expect(view.getByText(/Read & review/)).toBeTruthy();
    expect(view.queryByText("Approve")).toBeNull();
    expect(view.queryByText("Request changes")).toBeNull();
    await view.findByText("+1");
  });
});
