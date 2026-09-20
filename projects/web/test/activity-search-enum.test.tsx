import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ActivityDay, SearchDiagnostic, SearchItem } from "@todou/shared";
import { Component, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { referenceConfigQuery } from "../src/api/references.ts";
import { searchQuery } from "../src/api/search.ts";
import { ActivityCalendar } from "../src/components/activity-calendar/activity-calendar.tsx";
import { SearchResults } from "../src/pages/search.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const futureValues = ["future-state", "constructor", "__proto__"];
const malformedValues = [undefined, null, "", 0, false, {}, []].map(
  (value) => ({
    value,
  }),
);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function calendar(days: ActivityDay[], onDayChange = vi.fn()) {
  return render(
    <ActivityCalendar
      from="2024-01-01"
      to="2025-01-01"
      days={days}
      selection={null}
      today="2024-01-10"
      onDayChange={onDayChange}
      onRetry={vi.fn()}
    />,
  );
}

// Producer: services/activity-calendar/buckets.ts emits recorded, future,
// not_applicable; schemas/activity-calendar.ts requires the state discriminator.
// Inject wire extensions at the actual calendar boundary, without widening DTOs.
describe("ActivityCalendar state identity", () => {
  it("preserves known labels and only permits recorded dates to be selected", () => {
    const onDayChange = vi.fn();
    calendar(
      [
        { date: "2024-01-01", state: "recorded", count: 1 },
        { date: "2024-01-02", state: "recorded", count: 3 },
        { date: "2024-01-03", state: "future", count: null },
        { date: "2024-01-04", state: "not_applicable", count: null },
      ],
      onDayChange,
    );
    for (const [label, enabled] of [
      ["2024-01-01: 1 active card", true],
      ["2024-01-02: 3 active cards", true],
      ["2024-01-03: Future date", false],
      ["2024-01-04: Not applicable", false],
      ["2024-01-05: No data", false],
    ] as const) {
      const tile = screen.getByRole<HTMLButtonElement>("button", {
        name: label,
      });
      expect(tile.disabled).toBe(!enabled);
      fireEvent.click(tile);
    }
    expect(onDayChange.mock.calls).toEqual([["2024-01-01"], ["2024-01-02"]]);
  });

  it.each(futureValues)(
    "does not label future state %s as not applicable",
    (state) => {
      const onDayChange = vi.fn();
      calendar(
        [{ date: "2024-01-01", state, count: null } as ActivityDay],
        onDayChange,
      );
      // Restoring the old final `: "Not applicable"` breaks this accessible label.
      const tile = screen.getByRole<HTMLButtonElement>("button", {
        name: "2024-01-01: Unknown activity state",
      });
      expect(tile.disabled).toBe(true);
      expect(tile.dataset.level).toBeUndefined();
      expect(tile.className).not.toContain("border-transparent");
      fireEvent.click(tile);
      expect(onDayChange).not.toHaveBeenCalled();
      fireEvent.pointerEnter(tile.parentElement as HTMLElement);
      expect(screen.getByRole("tooltip").textContent).toBe(
        "2024-01-01: Unknown activity state",
      );
      expect(tile.getAttribute("aria-label")).not.toContain("Not applicable");
    },
  );

  it.each(malformedValues)(
    "rejects malformed required state %j",
    ({ value: state }) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      expect(() =>
        calendar([{ date: "2024-01-01", state, count: null } as ActivityDay]),
      ).toThrow(new TypeError("ActivityDay.state must be a non-empty string"));
    },
  );
});

function hit(overrides: Partial<SearchItem> = {}): SearchItem {
  return {
    kind: "issue",
    issue: {
      number: 17,
      title: "Search fixture",
      status: {
        id: 1,
        name: "Open",
        category: "open",
        color: "#3b82f6",
        position: 1,
        is_default: true,
      },
    },
    comment_id: null,
    spec_path: null,
    field: "title",
    snippet: { text: "matched text", ranges: [] },
    hidden: false,
    updated_at: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

class CaptureError extends Component<
  { children: ReactNode; onError: (error: Error) => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    this.props.onError(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function searchResults(
  item: SearchItem,
  diagnostics: SearchDiagnostic[] = [],
  onError = vi.fn(),
) {
  const client = testQueryClient();
  const search = { q: "is:body matched" };
  client.setQueryData(referenceConfigQuery("fixture").queryKey, {
    format: { prefix: "F", history: [] },
    autolinks: [],
  });
  client.setQueryData(searchQuery("fixture", search).queryKey, {
    items: [item],
    diagnostics,
    has_more: false,
  });
  return renderWithProviders(
    <CaptureError onError={onError}>
      <SearchResults slug="fixture" search={search} />
    </CaptureError>,
    client,
  );
}

// Producer: services/search.ts emits issue title/body, comment body, spec
// path/body; schemas/search.ts requires both kind and field on every SearchItem.
// SearchResults receives the cache snapshot through its real query and router.
describe("SearchResults hit identity", () => {
  it.each([
    [{ field: "title" }, "title", "/projects/fixture/issues/17"],
    [{ field: "body" }, "body", "/projects/fixture/issues/17"],
    [{ field: "path" }, "path", "/projects/fixture/issues/17"],
    [
      { kind: "comment", field: "body", comment_id: 9 },
      "#comment-9",
      "/projects/fixture/issues/17#comment-9",
    ],
    [
      { kind: "spec", field: "path", spec_path: "design.md" },
      "design.md",
      "/projects/fixture/issues/17/spec?file=design.md",
    ],
    [
      { kind: "spec", field: "body", spec_path: "design.md" },
      "design.md",
      "/projects/fixture/issues/17/spec?file=design.md",
    ],
  ] satisfies Array<[Partial<SearchItem>, string, string]>)(
    "preserves known hit %j",
    async (overrides, label, href) => {
      searchResults(hit(overrides));
      const row = await screen.findByRole("link", {
        name: `${label} matched text`,
      });
      expect(row.getAttribute("href")).toBe(href);
    },
  );

  it.each(futureValues)("does not call future field %s body", async (field) => {
    searchResults(hit({ field: field as SearchItem["field"] }));
    // Restoring `field === "title" ? "title" : "body"` breaks this row label.
    const row = await screen.findByRole("link", {
      name: "unknown matched text",
    });
    expect(row.textContent).not.toContain("body");
    expect(row.getAttribute("href")).toBe("/projects/fixture/issues/17");
  });

  it.each(futureValues)(
    "does not call future kind %s an issue title",
    async (kind) => {
      searchResults(hit({ kind: kind as SearchItem["kind"] }));
      // Restoring comment/spec/else-issue breaks this even with a known field.
      const row = await screen.findByRole("link", {
        name: "unknown matched text",
      });
      expect(row.textContent).not.toContain("title");
    },
  );

  for (const key of ["field", "kind"] as const) {
    it.each(malformedValues)(
      `rejects malformed required ${key} %j`,
      async ({ value }) => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const onError = vi.fn();
        searchResults(
          hit({ [key]: value } as Partial<SearchItem>),
          [],
          onError,
        );
        await waitFor(() => expect(onError).toHaveBeenCalled());
        expect(onError.mock.calls[0][0]).toBeInstanceOf(TypeError);
        expect(onError.mock.calls[0][0].message).toBe(
          `SearchItem.${key} must be a non-empty string`,
        );
      },
    );
  }

  it("uses severity only for error emphasis, without labeling other diagnostics as notes", async () => {
    searchResults(
      hit(),
      ["error", "note", "future-severity"].map((severity) => ({
        severity: severity as SearchDiagnostic["severity"],
        key: "label",
        value: null,
        message: `Diagnostic ${severity}`,
        suggestion: null,
      })),
    );
    expect((await screen.findByText("Diagnostic error")).className).toContain(
      "text-amber-700",
    );
    for (const severity of ["note", "future-severity"]) {
      const diagnostic = screen.getByText(`Diagnostic ${severity}`);
      expect(diagnostic.className).toBe("text-muted-foreground");
      expect(diagnostic.textContent).toBe(`Diagnostic ${severity}`);
    }
  });
});
