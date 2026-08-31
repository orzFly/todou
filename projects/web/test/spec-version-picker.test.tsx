import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { SpecVersionInfo, UserRef } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { SpecVersionPicker } from "../src/components/spec/spec-version-picker.tsx";
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

function renderPicker(
  props: Partial<Parameters<typeof SpecVersionPicker>[0]> = {},
) {
  return renderWithProviders(
    <SpecVersionPicker
      slug="demo"
      issueNumber={7}
      versions={VERSIONS}
      version={3}
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

  it("names the two versions being compared, keeping the same two parts", async () => {
    const view = renderPicker({ compare: 2 });
    const trigger = await view.findByRole("button");
    expect(trigger.textContent).toContain("v2…v3");
    // Chip plus message in both modes, so entering compare mode re-lays
    // nothing out around the trigger (T-190). The message belongs to the
    // version being viewed — the diff's right-hand side.
    expect(trigger.textContent).toContain("plan v1: nine steps");
    expect(trigger.getAttribute("title")).toBe("plan v1: nine steps");
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

  it("marks no version while comparing — the diff is what is on screen", async () => {
    await openMenu({ compare: 2 });
    expect(
      versionLinks().filter((i) => i.getAttribute("aria-current") === "true"),
    ).toHaveLength(0);
  });

  it("keeps the file and drops compare when switching version", async () => {
    await openMenu({ compare: 2, file: "design.md" });
    const target = versionLinks()[2];
    expect(target?.getAttribute("href")).toBe(
      "/projects/demo/issues/7/spec?file=design.md&v=1",
    );
  });

  it("offers the diff against the previous version", async () => {
    await openMenu({ file: "design.md" });
    const diff = screen.getByRole("menuitem", { name: /diff v2…v3/ });
    expect(diff.getAttribute("href")).toBe(
      "/projects/demo/issues/7/spec?file=design.md&v=3&compare=2",
    );
  });

  it("has no diff entry at v1 — there is nothing behind it", async () => {
    await openMenu({ version: 1 });
    expect(screen.queryByRole("menuitem", { name: /diff/ })).toBeNull();
  });
});
