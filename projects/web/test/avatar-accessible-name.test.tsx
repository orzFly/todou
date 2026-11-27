import { within } from "@testing-library/react";
import type { Me, Member, UserRef } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { membersQuery } from "../src/api/queries.ts";
import { MentionLink } from "../src/components/shared/mention-link.tsx";
import { UserChip } from "../src/components/shared/user-chip.tsx";
import { WatcherDetail } from "../src/components/shared/watcher-detail.tsx";
import { AppShell } from "../src/components/shell.tsx";
import { NewerVersionCard } from "../src/components/spec/newer-version-toast.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";
import { watcher } from "./watcher-fixtures.ts";

// An avatar beside a name is decoration: the name already says who it is.
// The initials fallback is an image labelled with its own text, so an avatar
// left in the accessibility tree is read in front of the name ("AL Alice
// Liddell") (T-817). Where the name is a control's, the whole accessible name
// is compared exactly. Where it is plain text, the initials are drawn and no
// image is exposed under their name; the drawn half is what stops the absence
// passing on a screen that rendered nothing.
//
// The two page headers that carry an avatar are covered beside their own
// fixtures, in user-page.test.tsx and agents-settings.test.tsx.

const alice: UserRef = {
  id: 7,
  login: "alice",
  display_name: "Alice Liddell",
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

function expectInitialsDrawnNotExposed(scope: HTMLElement, initials: string) {
  expect(within(scope).getByText(initials)).toBeTruthy();
  expect(within(scope).queryByRole("img", { name: initials })).toBeNull();
}

// The badge is a lucide SVG, which testing-library gives no `img` role, so
// it is found by its label and checked to sit outside every hidden subtree.
function expectBadgeExposed(scope: HTMLElement) {
  const badge = within(scope).getByLabelText("agent");
  expect(badge.closest('[aria-hidden="true"]')).toBeNull();
}

describe("UserChip's accessible name (T-817)", () => {
  it("is the person's name, without the initials in front", async () => {
    const view = renderWithProviders(<UserChip user={alice} />);
    expect(
      (await view.findByRole("link", { name: "Alice Liddell" })).getAttribute(
        "href",
      ),
    ).toBe("/users/alice");
  });

  // The badge is the one thing telling an agent from a person, and it sits
  // beside the avatar rather than inside it, so hiding the avatar keeps it.
  it("keeps the agent badge's label on a machine account", async () => {
    const view = renderWithProviders(<UserChip user={botOne} />);
    expect(
      await view.findByRole("link", { name: "agent Bot One" }),
    ).toBeTruthy();
  });

  // A compact chip is the avatar alone. Its name comes from the link's own
  // label, which hiding the avatar beside a name must not have taken away.
  it("still names a compact chip by its label", async () => {
    const view = renderWithProviders(<UserChip user={alice} compact />);
    expect(
      await view.findByRole("link", { name: "Alice Liddell" }),
    ).toBeTruthy();
  });
});

describe("the header's account button (T-817)", () => {
  const me: Me = {
    ...alice,
    email: null,
    is_instance_admin: false,
    created_at: "2026-01-01T00:00:00Z",
  };

  it("is named by the account's display name alone", async () => {
    const view = renderWithProviders(<AppShell me={me}>x</AppShell>);
    expect(
      await view.findByRole("button", { name: "Alice Liddell" }),
    ).toBeTruthy();
  });
});

describe("a mention's accessible name (T-817)", () => {
  const member = (user: UserRef): Member => ({
    user,
    role: "writer",
    created_at: "2026-01-01T00:00:00Z",
    owner_role: null,
  });

  const renderMention = (user: UserRef) => {
    const client = testQueryClient();
    client.setQueryData(membersQuery("garden").queryKey, [
      member(alice),
      member(botOne),
    ]);
    return renderWithProviders(
      <MentionLink
        slug="garden"
        userId={user.id}
        fallback={`@${user.login}`}
      />,
      client,
    );
  };

  it("is the login alone", async () => {
    const view = renderMention(alice);
    expect(await view.findByRole("link", { name: "@alice" })).toBeTruthy();
  });

  it("keeps the agent badge's label in front of an agent's login", async () => {
    const view = renderMention(botOne);
    expect(
      await view.findByRole("link", { name: "agent @bot-one" }),
    ).toBeTruthy();
  });
});

describe("a watcher row (T-817)", () => {
  it("exposes the agent badge and no initials", async () => {
    const view = renderWithProviders(
      <WatcherDetail
        heading="Watching this card"
        watchers={[watcher(botOne)]}
      />,
    );
    const row = await view.findByRole("listitem");
    expectInitialsDrawnNotExposed(row, "BO");
    expectBadgeExposed(row);
  });
});

describe("the newer-version card (T-817)", () => {
  it("exposes no initials beside the author's name", async () => {
    const view = renderWithProviders(
      <NewerVersionCard
        version={{
          number: 3,
          author: alice,
          message: null,
          created_at: "2026-11-27T12:00:00Z",
        }}
        onClose={() => {}}
        action={null}
      />,
    );
    const name = await view.findByText("Alice Liddell");
    expectInitialsDrawnNotExposed(name.closest("div") as HTMLElement, "AL");
  });
});
