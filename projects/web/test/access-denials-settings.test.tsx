import { QueryClient } from "@tanstack/react-query";
import { fireEvent, waitFor } from "@testing-library/react";
import type { AccessDenial } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accessDenialsQuery } from "../src/api/queries.ts";
import { AccessDenialsSection } from "../src/pages/project-settings.tsx";
import { renderWithProviders } from "./render.tsx";

const user = (id: number, login: string, kind: "human" | "machine") => ({
  id,
  login,
  display_name: login,
  kind,
  avatar_url: null,
  owner: kind === "machine" ? { id: 9, login: "alice" } : null,
});

const DENIAL: AccessDenial = {
  user: user(41, "bot-one", "machine"),
  denied_by: user(9, "alice", "human"),
  created_at: "2026-09-07T10:00:00.000Z",
};

// Through the router shim, because the two chips in a denial row are links
// now (T-391). RouterProvider mounts a tick late, and the empty case below
// asserts an absence: the sentinel is what keeps it from reading "" off a
// tree that has not rendered yet. It contributes no text of its own.
async function renderSection(denials: AccessDenial[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(accessDenialsQuery("todou").queryKey, denials);
  const view = renderWithProviders(
    <>
      <AccessDenialsSection slug="todou" />
      <span data-testid="mounted" />
    </>,
    client,
  );
  await view.findByTestId("mounted");
  return { view, client };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AccessDenialsSection", () => {
  it("stays out of the way when nobody has declined anything", async () => {
    const { view } = await renderSection([]);
    expect(view.container.textContent).toBe("");
  });

  it("names the agent, who declined, and what the record does not do", async () => {
    const { view } = await renderSection([DENIAL]);
    expect(view.container.textContent).toContain("bot-one");
    expect(view.container.textContent).toContain("alice");
    // The one thing a reader of this page could get wrong: it is not a block.
    expect(view.container.textContent).toContain("admin can still add them");
  });

  // Cell by cell, and the two people carry different logins: whichever of
  // the row's two chips loses its link, only that cell's list empties.
  it("links both the declined account and whoever declined it (T-391)", async () => {
    const { view } = await renderSection([DENIAL]);
    const cells = [...view.container.querySelectorAll("tbody td")];
    const hrefsIn = (cell: Element) =>
      [...cell.querySelectorAll('a[href^="/users/"]')].map((a) =>
        a.getAttribute("href"),
      );

    expect(hrefsIn(cells[0] as Element)).toEqual(["/users/bot-one"]);
    expect(hrefsIn(cells[1] as Element)).toEqual(["/users/alice"]);
  });

  it("undoes one with a DELETE and refetches the list", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method });
      return new Response(null, { status: 204 });
    }) as typeof fetch);

    const { view } = await renderSection([DENIAL]);
    const button = view.container.querySelector(
      "button[aria-label='allow bot-one to ask again']",
    );
    expect(button).not.toBeNull();
    fireEvent.click(button as HTMLButtonElement);

    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE")).toBe(true),
    );
    expect(calls.find((c) => c.method === "DELETE")?.url).toContain(
      "/api/projects/todou/access-denials/41",
    );
  });
});
