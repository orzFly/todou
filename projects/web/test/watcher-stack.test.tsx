import { render } from "@testing-library/react";
import type { Watcher } from "@todou/shared";
import { describe, expect, it } from "vitest";
import {
  groupWatchers,
  WatcherStack,
  watchingSentence,
} from "../src/components/shared/watcher-stack.tsx";
import { agentUser, BOT, CLAUDE, watcher } from "./watcher-fixtures.ts";

const NEWCOMER = agentUser(4, "Newcomer");
const ALICE = agentUser(5, "Alice");

describe("groupWatchers (T-540)", () => {
  it("draws one entry per account, in first-seen order", () => {
    const groups = groupWatchers([
      watcher(CLAUDE),
      watcher(BOT),
      watcher(CLAUDE),
    ]);
    expect(groups.map((g) => [g.user.id, g.sessions.length])).toEqual([
      [2, 2],
      [3, 1],
    ]);
  });
});

describe("WatcherStack (T-540)", () => {
  it("renders nothing for an empty list", () => {
    const view = render(<WatcherStack watchers={[]} />);
    expect(view.container.innerHTML).toBe("");
  });

  it("puts a count pill on an account with several sessions, and labels the stack", () => {
    const view = render(
      <WatcherStack
        watchers={[watcher(CLAUDE), watcher(CLAUDE), watcher(BOT)]}
      />,
    );
    const stack = view.getByRole("img");
    expect(stack.getAttribute("aria-label")).toBe(
      "Watching: Claude Agent (2 sessions), Bot One",
    );
    const pills = view.container.querySelectorAll("[data-session-count]");
    expect([...pills].map((p) => p.textContent)).toEqual(["2"]);
    expect(view.getByText("CA")).toBeTruthy();
    expect(view.getByText("BO")).toBeTruthy();
  });

  it("folds accounts past `max` into +N", () => {
    const view = render(
      <WatcherStack
        watchers={[
          watcher(CLAUDE),
          watcher(BOT),
          watcher(NEWCOMER),
          watcher(ALICE),
        ]}
      />,
    );
    expect(view.queryByText("AL")).toBeNull();
    expect(view.getByText("+1")).toBeTruthy();
  });

  it("puts a live dot on every avatar instead of a leading pulse when live (T-542)", () => {
    const view = render(
      <WatcherStack
        watchers={[watcher(CLAUDE), watcher(CLAUDE), watcher(BOT)]}
        live
      />,
    );
    const avatars = view.container.querySelectorAll('[data-slot="avatar"]');
    expect(avatars).toHaveLength(2);
    for (const avatar of avatars) {
      expect(
        avatar.parentElement?.querySelector(":scope > [data-live-dot]"),
      ).not.toBeNull();
    }
    expect(view.container.querySelector(".watcher-pulse")).toBeNull();
  });

  it("leads with the pulse and draws no per-avatar dot by default", () => {
    const view = render(
      <WatcherStack watchers={[watcher(CLAUDE), watcher(BOT)]} pulse />,
    );
    expect(view.container.querySelector(".watcher-pulse")).not.toBeNull();
    expect(view.container.querySelector("[data-live-dot]")).toBeNull();
  });

  it("drops its own label when hidden inside a labelled control", () => {
    const view = render(<WatcherStack watchers={[watcher(BOT)]} aria-hidden />);
    expect(view.queryByRole("img")).toBeNull();
    expect(view.container.firstElementChild?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });
});

describe("watchingSentence (T-540)", () => {
  const text = (watchers: Watcher[]) =>
    render(<p>{watchingSentence(groupWatchers(watchers))}</p>).container
      .textContent;

  it("names one account, with its session count", () => {
    expect(text([watcher(CLAUDE)])).toBe("Claude Agent is watching this card");
    expect(text([watcher(CLAUDE), watcher(CLAUDE)])).toBe(
      "Claude Agent (2 sessions) is watching this card",
    );
  });

  it("names two accounts", () => {
    expect(text([watcher(CLAUDE), watcher(BOT)])).toBe(
      "Claude Agent and Bot One are watching this card",
    );
  });

  it("names two and counts the rest past that", () => {
    expect(
      text([watcher(CLAUDE), watcher(BOT), watcher(NEWCOMER), watcher(ALICE)]),
    ).toBe("Claude Agent, Bot One and 2 more are watching this card");
  });
});
