import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SpecEntryRow,
  SpecSidebarSection,
} from "../src/components/issue/spec-entry.tsx";
import { renderWithProviders } from "./render.tsx";

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

function stubFetch() {
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = new URL(String(input), "http://test");
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
}

afterEach(() => vi.unstubAllGlobals());

describe("SpecEntryRow (#63)", () => {
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
});

describe("SpecSidebarSection (#63)", () => {
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
