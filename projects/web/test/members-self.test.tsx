import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { Agent, Me, Member } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentsQuery, membersQuery, meQuery } from "../src/api/queries.ts";
import { MembersSection } from "../src/pages/project-settings.tsx";

const ME: Me = {
  id: 100,
  login: "alice",
  display_name: "alice",
  kind: "human",
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: false,
  created_at: "2026-01-01T00:00:00.000Z",
};

const BOB: Member["user"] = {
  id: 101,
  login: "bob",
  display_name: "bob",
  kind: "human",
  avatar_url: null,
  owner: null,
};

const MEMBERS: Member[] = [
  { user: ME, role: "admin", created_at: "2026-01-01T00:00:00.000Z" },
  { user: BOB, role: "admin", created_at: "2026-01-02T00:00:00.000Z" },
];

const STRANGER: Me = { ...ME, id: 999, login: "carol", display_name: "carol" };

function renderSection(me: Me) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(membersQuery("todou").queryKey, MEMBERS);
  client.setQueryData(agentsQuery.queryKey, [] as Agent[]);
  client.setQueryData(meQuery.queryKey, me);
  return render(
    <QueryClientProvider client={client}>
      <MembersSection slug="todou" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MembersSection on your own row", () => {
  it("disables both controls on your row and leaves the others alone", () => {
    const view = renderSection(ME);
    const mine = view.container.querySelector(
      "button[aria-label='remove alice']",
    );
    const theirs = view.container.querySelector(
      "button[aria-label='remove bob']",
    );
    expect(mine).not.toBeNull();
    expect(theirs).not.toBeNull();
    expect((mine as HTMLButtonElement).disabled).toBe(true);
    expect((theirs as HTMLButtonElement).disabled).toBe(false);

    const roles = view.container.querySelectorAll("button[role=combobox]");
    expect(roles.length).toBe(2);
    expect((roles[0] as HTMLButtonElement).disabled).toBe(true);
    expect((roles[1] as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends nothing when your own remove button is clicked", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method });
      if ((init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify(MEMBERS), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch);

    const view = renderSection(ME);
    // The positive control comes first: without it, a stub that never got
    // attached would satisfy the negative assertion on its own.
    fireEvent.click(
      view.container.querySelector(
        "button[aria-label='remove bob']",
      ) as HTMLButtonElement,
    );
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.method === "DELETE" && c.url.endsWith("/members/101"),
        ),
      ).toBe(true),
    );

    fireEvent.click(
      view.container.querySelector(
        "button[aria-label='remove alice']",
      ) as HTMLButtonElement,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.filter((c) => c.url.includes("/members/100"))).toEqual([]);
  });

  it("explains itself only to someone the table actually lists", () => {
    expect(renderSection(ME).container.textContent).toContain(
      "ask another admin",
    );
    expect(renderSection(STRANGER).container.textContent).not.toContain(
      "ask another admin",
    );
  });
});
