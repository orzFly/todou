import type { Me } from "@todou/shared";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppShell } from "../src/components/shell.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const me: Me = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human",
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: true,
  created_at: "2026-01-01T00:00:00Z",
};

async function openUserMenu(mode: "single" | "forward") {
  const client = testQueryClient();
  client.setQueryData(["auth-mode"], { mode });
  const view = renderWithProviders(<AppShell me={me}>x</AppShell>, client);
  // The UserChip in the trigger renders the login, not the display name.
  const trigger = await view.findByText("user");
  fireEvent.pointerDown(trigger.closest("button") ?? trigger, {
    button: 0,
    pointerType: "mouse",
  });
  // The menu content mounts in a portal; anchor on a link that is always there.
  await waitFor(() => expect(screen.getByText("Profile")).toBeTruthy());
  return view;
}

describe("AppShell logout visibility", () => {
  it("offers Log out under session-based modes", async () => {
    await openUserMenu("single");
    expect(screen.getByText("Log out")).toBeTruthy();
  });

  it("hides Log out in forward mode — the proxy owns the login state", async () => {
    await openUserMenu("forward");
    expect(screen.queryByText("Log out")).toBeNull();
  });
});
