import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  type Agent,
  MEMBER_ROLES,
  type MemberRole,
  ROLE_RANK,
} from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentMembershipsQuery,
  agentsQuery,
  api,
  membersQuery,
  meQuery,
} from "../src/api/queries.ts";
import { AgentProjectsCell } from "../src/components/shared/agent-projects-dialog.tsx";
import { cappedRole, ROLE_DOT, roleDotOf } from "../src/lib/roles.ts";
import { MembersSection } from "../src/pages/project-settings.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

afterEach(() => vi.restoreAllMocks());

const future = "future-role" as MemberRole;
const bot: Agent = {
  id: 2,
  login: "probe-bot",
  display_name: "Probe Bot",
  kind: "machine",
  avatar_url: null,
  owner: { id: 1, login: "alice" },
  email: null,
  is_instance_admin: false,
  created_at: "2026-01-01T00:00:00Z",
  disabled_at: null,
};

// Casts model wire data that this client's compile-time union cannot describe.
describe("role values from newer servers", () => {
  it("preserves every known role cap and dot", () => {
    for (const want of MEMBER_ROLES) {
      expect(roleDotOf(want)).toBe(ROLE_DOT[want]);
      for (const ceiling of MEMBER_ROLES) {
        expect(cappedRole(want, ceiling)).toBe(
          ROLE_RANK[want] <= ROLE_RANK[ceiling] ? want : ceiling,
        );
      }
      expect(cappedRole(want, null)).toBeNull();
      expect(cappedRole(want, undefined)).toBeNull();
    }
  });

  it("never returns an unknown desired role or ceiling for submission", () => {
    for (const unknown of [future, "constructor", "__proto__", "toString"]) {
      expect(roleDotOf(unknown)).toBe("bg-muted-foreground");
      for (const role of MEMBER_ROLES) {
        expect(cappedRole(unknown as MemberRole, role)).toBeNull();
        expect(cappedRole(role, unknown as MemberRole)).toBeNull();
      }
      expect(
        cappedRole(unknown as MemberRole, unknown as MemberRole),
      ).toBeNull();
    }
  });

  it("rejects missing required data even beside an unknown or absent ceiling", () => {
    for (const invalid of [undefined, null, "", 0]) {
      expect(() => roleDotOf(invalid as string)).toThrow(TypeError);
      for (const ceiling of ["admin", future, null, undefined] as const) {
        expect(() => cappedRole(invalid as MemberRole, ceiling)).toThrow(
          TypeError,
        );
      }
    }
    expect(() => cappedRole(future, "" as MemberRole)).toThrow(TypeError);
  });

  it.each([
    { role: "writer" as MemberRole, ceiling: future },
    { role: future, ceiling: "admin" as MemberRole },
  ])(
    "locks agent role editing for $role under $ceiling",
    async ({ role, ceiling }) => {
      const setMember = vi.spyOn(api, "setMember").mockResolvedValue(undefined);
      const client = testQueryClient();
      client.setQueryData(agentMembershipsQuery.queryKey, {
        memberships: [
          {
            agent_id: bot.id,
            project: { id: 1, slug: "alpha", name: "Alpha" },
            role,
            created_at: bot.created_at,
          },
        ],
        manageable_projects: [
          { id: 1, slug: "alpha", name: "Alpha", my_role: ceiling },
        ],
      });
      renderWithProviders(<AgentProjectsCell agent={bot} />, client);
      fireEvent.click(
        await screen.findByRole("button", {
          name: "Manage probe-bot's projects",
        }),
      );
      const dialog = within(await screen.findByRole("dialog"));
      const select = dialog.getByRole("combobox", {
        name: "role in Alpha",
      }) as HTMLButtonElement;
      expect(select.disabled).toBe(true);
      fireEvent.click(select);
      expect(dialog.queryByRole("option")).toBeNull();
      expect(setMember).not.toHaveBeenCalled();
      expect(dialog.getByRole("button", { name: "remove Alpha" })).toBeTruthy();
    },
  );

  it("does not enable Add when a newer owner role is the ceiling", async () => {
    const setMember = vi.spyOn(api, "setMember").mockResolvedValue(undefined);
    const client = testQueryClient();
    client.setQueryData(agentMembershipsQuery.queryKey, {
      memberships: [],
      manageable_projects: [
        { id: 1, slug: "alpha", name: "Alpha", my_role: future },
      ],
    });
    renderWithProviders(<AgentProjectsCell agent={bot} />, client);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Manage probe-bot's projects",
      }),
    );
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.keyDown(
      dialog.getByRole("combobox", { name: "Project to add" }),
      { key: "ArrowDown" },
    );
    fireEvent.click(await screen.findByRole("option", { name: "Alpha" }));
    const add = dialog.getByRole("button", {
      name: "Add",
    }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.click(add);
    expect(setMember).not.toHaveBeenCalled();
  });

  it.each([future, "reader"] as const)(
    "only enables project Add agent for a known ceiling: %s",
    async (role) => {
      const setMember = vi.spyOn(api, "setMember").mockResolvedValue(undefined);
      const client = testQueryClient();
      const alice = {
        id: 1,
        login: "alice",
        display_name: "Alice",
        kind: "human" as const,
        avatar_url: null,
        owner: null,
      };
      client.setQueryData(meQuery.queryKey, {
        ...alice,
        email: null,
        is_instance_admin: false,
        created_at: bot.created_at,
      });
      client.setQueryData(agentsQuery.queryKey, [bot]);
      client.setQueryData(membersQuery("alpha").queryKey, [
        { user: alice, role, owner_role: null, created_at: bot.created_at },
      ]);
      const { container } = renderWithProviders(
        <MembersSection slug="alpha" />,
        client,
      );
      const add = (await within(container).findByRole("button", {
        name: "Add agent",
      })) as HTMLButtonElement;
      expect(add.disabled).toBe(role === future);
      fireEvent.click(add);
      if (role === future) {
        expect(screen.queryByRole("listbox", { name: "agents" })).toBeNull();
        expect(setMember).not.toHaveBeenCalled();
      } else {
        fireEvent.click(
          await screen.findByRole("option", { name: /Probe Bot/ }),
        );
        await waitFor(() =>
          expect(setMember).toHaveBeenCalledExactlyOnceWith(
            "alpha",
            bot.id,
            "reader",
          ),
        );
      }
    },
  );

  it.each([
    { role: "writer" as MemberRole, ceiling: future },
    { role: future, ceiling: "admin" as MemberRole },
  ])(
    "locks project settings for $role under $ceiling",
    async ({ role, ceiling }) => {
      const client = testQueryClient();
      const alice = {
        id: 1,
        login: "alice",
        display_name: "Alice",
        kind: "human" as const,
        avatar_url: null,
        owner: null,
      };
      client.setQueryData(meQuery.queryKey, {
        ...alice,
        email: null,
        is_instance_admin: false,
        created_at: bot.created_at,
      });
      client.setQueryData(agentsQuery.queryKey, []);
      client.setQueryData(membersQuery("alpha").queryKey, [
        {
          user: alice,
          role: "admin",
          owner_role: null,
          created_at: bot.created_at,
        },
        { user: bot, role, owner_role: ceiling, created_at: bot.created_at },
      ]);
      const { container } = renderWithProviders(
        <MembersSection slug="alpha" />,
        client,
      );
      await within(container).findByRole("heading", { name: "Members" });
      const remove = within(container).getByRole("button", {
        name: "remove Probe Bot",
      });
      const row = remove.closest("tr");
      expect(row).not.toBeNull();
      expect(within(row as HTMLElement).queryByRole("combobox")).toBeNull();
      expect(row?.textContent).toContain("(locked)");
    },
  );
});
