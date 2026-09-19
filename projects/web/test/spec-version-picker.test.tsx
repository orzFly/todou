import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { SpecVersionInfo, UserRef } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { SpecBaselinePicker } from "../src/components/spec/spec-baseline-picker.tsx";
import { SpecVersionPicker } from "../src/components/spec/spec-version-picker.tsx";
import { specSearchFor } from "../src/lib/spec-search.ts";
import { renderWithProviders } from "./render.tsx";

const AUTHOR: UserRef = {
  id: 1,
  login: "bot-one",
  display_name: "Bot One",
  kind: "machine",
  avatar_url: null,
  owner: null,
};

const VERSIONS: SpecVersionInfo[] = [
  {
    number: 1,
    author: AUTHOR,
    message: "first cut of the design",
    created_at: "2026-01-01T10:00:00Z",
  },
  {
    number: 2,
    author: AUTHOR,
    message: null,
    created_at: "2026-01-02T11:30:00Z",
  },
  {
    number: 3,
    author: AUTHOR,
    message: "plan v1: nine steps",
    created_at: "2026-01-03T12:45:00Z",
  },
];

const WITHDRAWAL: NonNullable<SpecVersionInfo["withdrawal"]> = {
  actor: {
    ...AUTHOR,
    id: 2,
    login: "alice",
    display_name: "Alice",
    kind: "human",
  },
  created_at: "2026-01-02T12:00:00Z",
  reason: "Rework **scope** with @user and #123 [notes](https://example.test)",
};

function renderPicker(
  props: Partial<Parameters<typeof SpecVersionPicker>[0]> = {},
) {
  return renderWithProviders(
    <SpecVersionPicker
      slug="demo"
      issueNumber={7}
      versions={VERSIONS}
      version={3}
      searchFor={(target) =>
        specSearchFor({
          file: "design.md",
          v: target,
          version: target,
          baseline: null,
          view: "rendered",
        })
      }
      {...props}
    />,
  );
}

async function openMenu(
  props?: Partial<Parameters<typeof SpecVersionPicker>[0]>,
) {
  const view = renderPicker(props);
  const trigger = await view.findByRole("button");
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  // The menu mounts in a portal, outside the render container.
  await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
  return view;
}

/** Every version item, in menu order. */
const versionLinks = () =>
  screen
    .getAllByRole("menuitem")
    .filter((item) => /^v\d/.test(item.textContent ?? ""));

describe("SpecVersionPicker (T-178)", () => {
  it("shows the current version's message on the trigger", async () => {
    const view = renderPicker();
    const trigger = await view.findByRole("button");
    expect(trigger.textContent).toContain("v3");
    expect(trigger.textContent).toContain("plan v1: nine steps");
    expect(trigger.getAttribute("title")).toBe("plan v1: nine steps");
  });

  it("sizes the version chip to its digits, keeping them tabular (T-194)", async () => {
    // The chip only ever spells one version (T-192 moved the comparison to
    // the baseline picker), so the min-width it used to carry was 20px of
    // padding around `v1` and nothing else. tabular-nums stays: it is what
    // keeps the digits column-aligned with the menu's chips.
    const view = renderPicker({ version: 1 });
    const chip = (await view.findByRole("button")).firstElementChild;
    expect(chip?.textContent).toBe("v1");
    expect(chip?.className).not.toContain("min-w-14");
    expect(chip?.className).toContain("tabular-nums");
  });

  it("lists versions newest first with message, pusher and time", async () => {
    await openMenu();
    const items = versionLinks();
    expect(items.map((i) => i.textContent?.slice(0, 2))).toEqual([
      "v3",
      "v2",
      "v1",
    ]);

    const oldest = items[2];
    expect(oldest?.textContent).toContain("first cut of the design");
    expect(oldest?.textContent).toContain("Bot One");
    const stamp = oldest?.querySelector("time");
    expect(stamp?.getAttribute("title")).toBe("2026-01-01T10:00:00Z");
    expect(stamp?.textContent).toBe(
      new Date("2026-01-01T10:00:00Z").toLocaleString(),
    );
  });

  it("leaves the pusher's chip unlinked inside the menu item (T-391)", async () => {
    await openMenu();
    const oldest = versionLinks()[2] as HTMLElement;

    // The item is itself the anchor to that version's url. A second anchor
    // nested in it is invalid content, and whichever of the two won the
    // click, one of them would be the wrong destination.
    expect(oldest.querySelectorAll('a[href^="/users/"]')).toHaveLength(0);
    // The other half: without it, a picker that stopped rendering the chip
    // at all would satisfy the line above.
    expect(oldest.textContent).toContain("Bot One");
  });

  it("falls back to 'no message' where a version pushed without one", async () => {
    await openMenu();
    const items = versionLinks();
    expect(items[1]?.textContent).toContain("no message");
  });

  it("marks the version being viewed, and only it", async () => {
    await openMenu();
    const current = versionLinks().filter(
      (i) => i.getAttribute("aria-current") === "true",
    );
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent?.slice(0, 2)).toBe("v3");
  });

  it("points every item at the url its caller builds", async () => {
    await openMenu();
    expect(versionLinks()[2]?.getAttribute("href")).toBe(
      "/projects/demo/issues/7/spec?file=design.md&v=1",
    );
  });

  it("carries the comparison across a version switch (T-192)", async () => {
    await openMenu({
      searchFor: (target) =>
        specSearchFor({
          file: "design.md",
          v: target,
          version: target,
          baseline: target > 1 ? target - 1 : null,
          view: "source",
        }),
    });
    expect(versionLinks()[1]?.getAttribute("href")).toBe(
      "/projects/demo/issues/7/spec?file=design.md&v=2&compare=1",
    );
    expect(versionLinks()[2]?.getAttribute("href")).toBe(
      "/projects/demo/issues/7/spec?file=design.md&v=1",
    );
  });

  it("keeps withdrawal history on its version after a new submission", async () => {
    const view = await openMenu({
      versions: VERSIONS.map((v) =>
        v.number === 2 ? { ...v, withdrawal: WITHDRAWAL } : v,
      ),
    });
    expect(
      view.getByRole("button", { hidden: true }).textContent,
    ).not.toContain("withdrawn");
    const [latest, withdrawn, oldest] = versionLinks();
    expect(latest?.textContent).not.toContain("withdrawn");
    expect(oldest?.textContent).not.toContain("withdrawn");
    expect(withdrawn?.textContent).toContain("Previously withdrawn by ");
    expect(withdrawn?.textContent).toContain("Alice");
    expect(withdrawn?.textContent).toContain(WITHDRAWAL.reason);
    expect(
      withdrawn?.querySelector(`time[datetime="${WITHDRAWAL.created_at}"]`),
    ).not.toBeNull();
    expect(withdrawn?.querySelectorAll("a, strong, em")).toHaveLength(0);
    expect(withdrawn?.getAttribute("href")).toBe(
      "/projects/demo/issues/7/spec?file=design.md&v=2",
    );
  });

  it("marks the viewed historical version on the closed trigger", async () => {
    const view = renderPicker({
      version: 2,
      versions: VERSIONS.map((v) =>
        v.number === 2
          ? { ...v, withdrawal: { ...WITHDRAWAL, reason: null } }
          : v,
      ),
    });
    const trigger = await view.findByRole("button");
    expect(trigger.textContent).toContain("v2");
    expect(trigger.textContent).toContain("previously withdrawn");
    expect(trigger.textContent).not.toContain("reworking");
  });

  it("retains a withdrawn baseline and its historical comparison destination", async () => {
    const view = renderWithProviders(
      <SpecBaselinePicker
        slug="demo"
        issueNumber={7}
        version={3}
        baseline={2}
        versions={VERSIONS.map((v) =>
          v.number === 2 ? { ...v, withdrawal: WITHDRAWAL } : v,
        )}
        searchFor={(baseline) => ({ v: 3, compare: baseline })}
      />,
    );
    const trigger = await view.findByRole("button");
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
    const [withdrawn, oldest] = versionLinks();
    expect(withdrawn?.textContent).toContain("Previously withdrawn by ");
    expect(withdrawn?.textContent).toContain("Alice");
    expect(withdrawn?.textContent).toContain(WITHDRAWAL.reason);
    expect(withdrawn?.querySelectorAll("a")).toHaveLength(0);
    expect(withdrawn?.getAttribute("href")).toBe(
      "/projects/demo/issues/7/spec?v=3&compare=2",
    );
    expect(oldest?.textContent).not.toContain("withdrawn");
  });
});
