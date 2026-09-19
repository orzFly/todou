import { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Agent, Me, Member, MemberRole, UserRef } from "@todou/shared";
import { Component, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentsQuery, api, membersQuery, meQuery } from "../src/api/queries.ts";
import { MembersSection } from "../src/pages/project-settings.tsx";
import { renderWithProviders } from "./render.tsx";

afterEach(() => vi.restoreAllMocks());

const human = (id: number, login: string): UserRef => ({
  id,
  login,
  display_name: login,
  kind: "human",
  avatar_url: null,
  owner: null,
});

const machine = (id: number, login: string, owner: UserRef): UserRef => ({
  id,
  login,
  display_name: login,
  kind: "machine",
  avatar_url: null,
  owner: { id: owner.id, login: owner.login },
});

const ALICE = human(1, "alice");
const BOB = human(2, "bob");
const ROOT = human(3, "root-admin");
const GONE = human(4, "departed");

const ALICE_BOT = machine(11, "alice-bot", ALICE);
const BOB_BOT = machine(12, "bob-bot", BOB);
const ROOT_BOT = machine(13, "root-bot", ROOT);
const ORPHAN_BOT = machine(14, "orphan-bot", GONE);

const at = "2026-01-01T00:00:00.000Z";
const member = (
  user: UserRef,
  role: MemberRole,
  owner_role?: MemberRole | null,
): Member => ({
  user,
  role,
  created_at: at,
  ...(user.kind === "machine"
    ? { owner_role: owner_role ?? null }
    : { owner_role: null }),
});

const meFrom = (user: UserRef, instanceAdmin = false): Me => ({
  ...user,
  email: null,
  is_instance_admin: instanceAdmin,
  created_at: at,
});

// Through the router shim, because the member chips are links now (T-391).
// RouterProvider mounts a tick late, and the gate is scoped to this render's
// own container — a test that renders two sections has two headings.
async function renderSection(
  members: Member[],
  me: Me,
  agents: Agent[] = [],
): Promise<HTMLElement> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(membersQuery("todou").queryKey, members);
  client.setQueryData(agentsQuery.queryKey, agents);
  client.setQueryData(meQuery.queryKey, me);
  const { container } = renderWithProviders(
    <MembersSection slug="todou" />,
    client,
  );
  await within(container).findByRole("heading", { name: "Members" });
  return container;
}

/**
 * Row order as the table renders it, by the login each row shows. Read off
 * the first cell only: `textContent` on the whole row would run the login
 * straight into the role beside it.
 */
function rowLogins(container: HTMLElement): string[] {
  return [...container.querySelectorAll("tbody tr")].map(
    (tr) =>
      /@([a-z0-9-]+)/.exec(tr.querySelector("td")?.textContent ?? "")?.[1] ??
      "—",
  );
}

const rowOf = (container: HTMLElement, login: string) =>
  [...container.querySelectorAll("tbody tr")].find((tr) =>
    (tr.querySelector("td")?.textContent ?? "").includes(`@${login}`),
  ) ?? null;

const roleSelect = (container: HTMLElement, login: string) =>
  (rowOf(container, login)?.querySelector("button[role=combobox]") ??
    null) as HTMLButtonElement | null;

const removeButton = (container: HTMLElement, name: string) =>
  container.querySelector(
    `button[aria-label='remove ${name}']`,
  ) as HTMLButtonElement | null;

class MemberErrorBoundary extends Component<
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

describe("MembersSection as an indented tree (T-340)", () => {
  it("files each machine under its owner and sorts by display name", async () => {
    const container = await renderSection(
      [
        member(BOB, "writer"),
        member(ALICE_BOT, "reader", "admin"),
        member(ALICE, "admin"),
        member(BOB_BOT, "writer", "writer"),
      ],
      meFrom(ALICE),
    );

    expect(rowLogins(container)).toEqual([
      "alice",
      "alice-bot",
      "bob",
      "bob-bot",
    ]);
  });

  it.each(["future_user_kind", "constructor", "__proto__"])(
    "keeps a member of unknown kind %s as a visible independent row",
    async (kind) => {
      const future = {
        ...human(21, "newcomer"),
        kind,
        owner: { id: ALICE.id, login: ALICE.login },
      } as UserRef;
      const container = await renderSection(
        [
          member(ALICE, "admin"),
          member(ALICE_BOT, "reader", "admin"),
          member(future, "reader"),
        ],
        meFrom(ALICE),
      );
      expect(rowLogins(container)).toEqual(["alice", "alice-bot", "newcomer"]);
      expect(rowOf(container, "newcomer")?.textContent).toContain("reader");
      expect(rowOf(container, "newcomer")?.textContent).not.toContain("agent");
    },
  );

  it.each([undefined, null, "", 42])(
    "rejects malformed required member kind %j instead of losing the row",
    async (kind) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const client = new QueryClient();
      const invalid = { ...human(21, "newcomer"), kind } as UserRef;
      client.setQueryData(membersQuery("todou").queryKey, [
        member(ALICE, "admin"),
        member(invalid, "reader"),
      ]);
      client.setQueryData(agentsQuery.queryKey, []);
      client.setQueryData(meQuery.queryKey, meFrom(ALICE));
      const onError = vi.fn();
      renderWithProviders(
        <MemberErrorBoundary onError={onError}>
          <MembersSection slug="todou" />
        </MemberErrorBoundary>,
        client,
      );
      await waitFor(() => expect(onError).toHaveBeenCalled());
      expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(TypeError);
      expect(onError.mock.calls[0]?.[0].message).toBe(
        "user kind must be a non-empty string",
      );
    },
  );

  it("keeps a machine whose owner is an instance admin in the main list", async () => {
    const container = await renderSection(
      [member(ALICE, "admin"), member(ROOT_BOT, "admin", "admin")],
      meFrom(ALICE),
    );

    // The owner holds no membership row, so the group gets a display-only
    // header — but the machine is an ordinary row with an ordinary ceiling.
    expect(container.textContent).toContain("not a member of this project");
    expect(container.textContent).not.toContain("Owner is not a member here");
    expect(roleSelect(container, "root-bot")?.disabled).toBe(false);
  });

  it("splits out a machine whose owner holds nothing, and locks its role", async () => {
    const container = await renderSection(
      [member(ALICE, "admin"), member(ORPHAN_BOT, "writer", null)],
      meFrom(ALICE),
    );

    expect(container.textContent).toContain("Owner is not a member here");
    // Removable, but no role control at all: with no ceiling there is no
    // role that could be judged legal.
    expect(roleSelect(container, "orphan-bot")).toBeNull();
    expect(container.textContent).toContain("(locked)");
    expect(removeButton(container, "orphan-bot")?.disabled).toBe(false);
  });

  it("gives an owner header row no controls of its own", async () => {
    const container = await renderSection(
      [member(ALICE, "admin"), member(ROOT_BOT, "reader", "admin")],
      meFrom(ALICE),
    );

    // A header stands for a membership that does not exist; a control there
    // would aim a write at nothing.
    expect(removeButton(container, "root-admin")).toBeNull();
    expect(roleSelect(container, "root-admin")).toBeNull();
  });

  it("marks a row already above its ceiling instead of hiding the role", async () => {
    const container = await renderSection(
      [
        member(ALICE, "admin"),
        member(BOB, "reader"),
        member(BOB_BOT, "admin", "reader"),
      ],
      meFrom(ALICE),
    );

    expect(container.textContent).toContain(
      "the next change clamps it to reader",
    );
    // The stored role still shows, or the control would disagree with the
    // project's own data.
    expect(roleSelect(container, "bob-bot")?.textContent).toContain("admin");
  });
});

describe("MembersSection from a non-admin's chair", () => {
  const ROWS = [
    member(ALICE, "admin"),
    member(ALICE_BOT, "reader", "admin"),
    member(BOB, "reporter"),
    member(BOB_BOT, "reporter", "reporter"),
  ];

  it("leaves controls only on the machines I own", async () => {
    const container = await renderSection(ROWS, meFrom(BOB));

    expect(roleSelect(container, "bob-bot")?.disabled).toBe(false);
    expect(removeButton(container, "bob-bot")?.disabled).toBe(false);
    // Not a disabled control — nothing at all. A greyed button on a row you
    // hold no authority over only reads as "did I misclick?".
    expect(roleSelect(container, "alice-bot")).toBeNull();
    expect(removeButton(container, "alice-bot")).toBeNull();
    expect(roleSelect(container, "alice")).toBeNull();
    expect(removeButton(container, "alice")).toBeNull();
  });

  it("keeps my own row's controls present but disabled", async () => {
    const container = await renderSection(ROWS, meFrom(BOB));

    // The other half of the pair above: this control is meaningful to me,
    // it is simply not mine to press, so it stays.
    expect(roleSelect(container, "bob")?.disabled).toBe(true);
    expect(removeButton(container, "bob")?.disabled).toBe(true);
  });

  it("offers Add person to an admin and to nobody else", async () => {
    // Both halves read through their own container. Asked of `screen` before
    // any render, the negative half is put to an empty document — cleanup
    // has already taken the previous test's tree down — and passes whatever
    // the component does.
    const asReporter = await renderSection(ROWS, meFrom(BOB));
    expect(
      within(asReporter).queryByRole("button", { name: /Add person/ }),
    ).toBeNull();

    const asAdmin = await renderSection(ROWS, meFrom(ALICE));
    expect(
      within(asAdmin).getByRole("button", { name: /Add person/ }),
    ).toBeTruthy();
  });

  it("caps the role its dropdown offers at my own", async () => {
    const container = await renderSection(ROWS, meFrom(BOB));

    fireEvent.keyDown(roleSelect(container, "bob-bot") as HTMLElement, {
      key: "ArrowDown",
    });
    const disabled = Object.fromEntries(
      screen
        .getAllByRole("option")
        .map((o) => [
          (o.textContent ?? "").split(" ")[0],
          o.getAttribute("aria-disabled"),
        ]),
    );
    expect(disabled).toMatchObject({
      admin: "true",
      writer: "true",
      reporter: null,
      reader: null,
    });
  });

  it("adds an agent at my own role rather than a hard-coded writer", async () => {
    const spy = vi.spyOn(api, "setMember").mockResolvedValue(undefined);
    const agent: Agent = {
      ...machine(21, "spare-bot", BOB),
      email: null,
      is_instance_admin: false,
      created_at: at,
      disabled_at: null,
    };
    await renderSection(ROWS, meFrom(BOB), [agent]);

    fireEvent.click(screen.getByRole("button", { name: /Add agent/ }));
    fireEvent.click(await screen.findByRole("option", { name: /spare-bot/ }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith("todou", 21, "reporter"),
    );
  });
});

describe("MembersSection against a server that never sends owner_role", () => {
  it("treats an unknown ceiling as read-only", async () => {
    const rows = [
      member(ALICE, "admin"),
      // The field absent entirely, which is what a rolling release looks
      // like. Nothing parses this at runtime, so only this branch stops a
      // ceiling being computed from undefined.
      { user: BOB_BOT, role: "writer", created_at: at } as Member,
      member(BOB, "writer"),
    ];
    const container = await renderSection(rows, meFrom(ALICE));

    expect(roleSelect(container, "bob-bot")).toBeNull();
    expect(container.textContent).toContain("(locked)");
    // Still removable, and still in the main list — an unknown ceiling is
    // not the same claim as "the owner holds nothing".
    expect(removeButton(container, "bob-bot")?.disabled).toBe(false);
    expect(container.textContent).not.toContain("Owner is not a member here");
  });
});

describe("MembersSection adding a person by login", () => {
  it("posts the exact login and role, with no directory in sight", async () => {
    const spy = vi
      .spyOn(api, "addMember")
      .mockResolvedValue(member(BOB, "reporter"));
    await renderSection([member(ALICE, "admin")], meFrom(ALICE));

    fireEvent.click(screen.getByRole("button", { name: /Add person/ }));
    fireEvent.change(screen.getByLabelText("login to add"), {
      target: { value: "Newcomer " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith("todou", {
        login: "newcomer",
        role: "reporter",
      }),
    );
  });
});

describe("every member row links to that member's page (T-391)", () => {
  it("points each row's chip at its own login", async () => {
    const container = await renderSection(
      [
        member(ALICE, "admin"),
        member(BOB, "writer"),
        member(BOB_BOT, "writer", "writer"),
      ],
      meFrom(ALICE),
    );

    // Each row on its own, and three different logins: a row that lost its
    // link cannot be covered by a neighbour that kept one.
    const userLinksIn = (login: string) =>
      [
        ...(rowOf(container, login) as Element).querySelectorAll(
          'a[href^="/users/"]',
        ),
      ].map((a) => a.getAttribute("href"));

    expect(userLinksIn("alice")).toEqual(["/users/alice"]);
    expect(userLinksIn("bob")).toEqual(["/users/bob"]);
    expect(userLinksIn("bob-bot")).toEqual(["/users/bob-bot"]);
  });
});
