import type { UserRef } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { UserChip } from "../src/components/shared/user-chip.tsx";
import { renderWithProviders } from "./render.tsx";

// The id and the login share no arithmetic, and the expected address below is
// written out rather than derived from the fixture: an implementation that
// addressed the page by id would produce `/users/7` and cannot drag the
// expectation along with it.
const alice: UserRef = {
  id: 7,
  login: "alice",
  display_name: "Alice Liu",
  kind: "human",
  avatar_url: null,
  owner: null,
};

const botOne: UserRef = {
  id: 9,
  login: "bot-one",
  display_name: "Bot One",
  kind: "machine",
  avatar_url: null,
  owner: { id: 7, login: "alice" },
};

describe("UserChip link", () => {
  // Red when the implementation switches to `params={{ ref: String(user.id) }}`.
  it("addresses the user page by login, not by id", async () => {
    const { findByRole } = renderWithProviders(<UserChip user={alice} />);
    const link = await findByRole("link");
    expect(link.getAttribute("href")).toBe("/users/alice");
  });

  // Red when the anchor is wrapped around the chip's span instead of
  // replacing it: the box classes then sit on a span one level in and the
  // anchor carries none of them. Asserted through the box rather than
  // through "the avatar is the anchor's first child", which stopped telling
  // the two shapes apart once the avatar moved into a positioned span of its
  // own (T-487) — as it already had for a machine user's badge.
  it("makes the anchor the chip's outermost element", async () => {
    const { container, findByRole } = renderWithProviders(
      <UserChip user={alice} />,
    );
    await findByRole("link");
    const outer = container.firstElementChild;
    expect(outer?.tagName).toBe("A");
    expect(outer?.className).toContain("inline-block");
    expect(outer?.querySelector('[data-slot="avatar"]')).not.toBeNull();
  });

  // Red either way round: put only the name inside the anchor and the avatar
  // lookup fails; put only the avatar inside it and the text does.
  it("wraps both the avatar and the name", async () => {
    const { findByRole } = renderWithProviders(<UserChip user={alice} />);
    const link = await findByRole("link");
    expect(link.querySelector('[data-slot="avatar"]')).not.toBeNull();
    expect(link.textContent).toContain("Alice Liu");
  });

  // The name assertion is what stops this passing on a UserChip that renders
  // nothing at all — which is the only other way to have no link on screen.
  it("renders no anchor under link={false}, and still renders the chip", async () => {
    const { findByText, queryByRole } = renderWithProviders(
      <UserChip user={alice} link={false} />,
    );
    expect(await findByText("Alice Liu")).not.toBeNull();
    expect(queryByRole("link")).toBeNull();
  });

  // Red when the aria-label goes: a compact chip is an avatar alone, whose
  // `alt` is empty, so the accessible name falls back to the fallback's
  // initials ("AL") and no longer matches.
  it("gives a compact chip the user's name to be found by", async () => {
    const { findByRole } = renderWithProviders(
      <UserChip user={alice} compact />,
    );
    const link = await findByRole("link", { name: "Alice Liu" });
    expect(link.getAttribute("href")).toBe("/users/alice");
  });

  // Machine accounts link like anyone else — their page is the one surface
  // that says whose agent this is. The tooltip wrapper renders the anchor
  // itself (TooltipTrigger asChild), so it stays the outermost element.
  it("links a machine account, tooltip and all", async () => {
    const { container, findByRole } = renderWithProviders(
      <UserChip user={botOne} />,
    );
    const link = await findByRole("link");
    expect(link.getAttribute("href")).toBe("/users/bot-one");
    expect(container.firstElementChild?.tagName).toBe("A");
  });
});
