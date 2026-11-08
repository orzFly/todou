import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  compactRemaining,
  WatcherDetail,
} from "../src/components/shared/watcher-detail.tsx";
import { renderWithClient as render } from "./render.tsx";
import { BOT, CLAUDE, marked, watcher } from "./watcher-fixtures.ts";

const NOW = Date.parse("2026-10-22T11:00:00.000Z");

describe("WatcherDetail marks (T-669)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the time a mark has left, and a watch row its age", () => {
    const view = render(
      <WatcherDetail
        heading="Watching this card"
        watchers={[
          marked(CLAUDE, "2026-10-22T11:12:00.000Z", {
            since: "2026-10-22T10:00:00.000Z",
          }),
          watcher(BOT, { since: "2026-10-22T10:55:00.000Z" }),
        ]}
      />,
    );
    const rows = view.getAllByRole("listitem").map((li) => li.textContent);
    expect(rows[0]).toContain("marked · 12m left");
    expect(rows[1]).toContain("this card · 5m ago");
  });
});

describe("compactRemaining (T-669)", () => {
  it("counts down in seconds, minutes, then hours, never below zero", () => {
    const at = (ms: number) => new Date(NOW + ms).toISOString();
    expect(compactRemaining(at(45_000), NOW)).toBe("45s");
    expect(compactRemaining(at(12 * 60_000), NOW)).toBe("12m");
    expect(compactRemaining(at(60 * 60_000), NOW)).toBe("1h");
    expect(compactRemaining(at(-5_000), NOW)).toBe("0s");
  });
});
