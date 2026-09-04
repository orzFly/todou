import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { Agent, Member } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentsQuery, membersQuery } from "../src/api/queries.ts";
import { AddAgentPicker } from "../src/components/shared/add-agent-picker.tsx";
import { MembersSection } from "../src/pages/project-settings.tsx";

let nextId = 100;

function makeAgent(
  login: string,
  displayName: string,
  overrides: Partial<Agent> = {},
): Agent {
  return {
    id: nextId++,
    login,
    display_name: displayName,
    kind: "machine",
    avatar_url: null,
    owner: { id: 1, login: "user" },
    email: null,
    is_instance_admin: false,
    created_at: "2026-08-28T00:00:00Z",
    disabled_at: null,
    ...overrides,
  };
}

const PROBE = makeAgent("probe-1", "探针 Probe");
const PROBE2 = makeAgent("probe-2", "Zulu Probe");
const PROBER = makeAgent("prober", "Alpha Prober");
const HELPER = makeAgent("helper-bot", "Helper Bot");
const RETIRED = makeAgent("retired-bot", "Retired Bot", {
  disabled_at: "2026-08-30T00:00:00Z",
});

const ALL = [PROBE, PROBE2, PROBER, HELPER, RETIRED];

afterEach(() => {
  vi.unstubAllGlobals();
});

function open(
  props: Partial<Parameters<typeof AddAgentPicker>[0]> = {},
): ReturnType<typeof render> {
  return render(
    <AddAgentPicker
      agents={ALL}
      memberIds={new Set()}
      onAdd={() => {}}
      defaultOpen
      {...props}
    />,
  );
}

const input = () => screen.getByLabelText("filter agents");
const list = () => within(screen.getByRole("listbox"));
const options = () => list().getAllByRole("option");

// The avatar's initials fallback sits in the row's textContent too, glued to
// the name; skipping it keeps these assertions about the text the row spells.
const rowText = (option: HTMLElement): string =>
  Array.from(option.children)
    .filter((child) => child.getAttribute("data-slot") !== "avatar")
    .map((child) => child.textContent)
    .join("");

describe("AddAgentPicker candidates", () => {
  it("filters by display name, case-insensitively and in Chinese", () => {
    open();
    fireEvent.change(input(), { target: { value: "  ZULU " } });
    expect(options().map(rowText)).toEqual(["Zulu Probe@probe-2"]);

    fireEvent.change(input(), { target: { value: "探针" } });
    expect(options().map(rowText)).toEqual(["探针 Probe@probe-1"]);
  });

  it("filters by login", () => {
    open();
    fireEvent.change(input(), { target: { value: "probe-" } });
    expect(options().map(rowText)).toEqual([
      "Zulu Probe@probe-2",
      "探针 Probe@probe-1",
    ]);
  });

  it("hides existing members and disabled agents", () => {
    open({ memberIds: new Set([HELPER.id]) });
    expect(options().map(rowText)).toEqual([
      "Alpha Prober@prober",
      "Zulu Probe@probe-2",
      "探针 Probe@probe-1",
    ]);
  });

  it("sorts by display name when nothing is typed", () => {
    open();
    expect(options().map(rowText)).toEqual([
      "Alpha Prober@prober",
      "Helper Bot@helper-bot",
      "Zulu Probe@probe-2",
      "探针 Probe@probe-1",
    ]);
  });
});

describe("AddAgentPicker avatars", () => {
  it("gives every candidate row an avatar", () => {
    open();
    for (const option of options()) {
      expect(option.querySelector("[data-slot=avatar]")).toBeTruthy();
    }
  });

  it("falls back to the display name's initials", () => {
    open();
    fireEvent.change(input(), { target: { value: "zulu" } });
    expect(list().getByText("ZP")).toBeTruthy();
  });

  it("keeps the avatar out of the row's accessible name", () => {
    open();
    fireEvent.change(input(), { target: { value: "zulu" } });
    expect(
      options()[0]
        .querySelector("[data-slot=avatar]")
        ?.getAttribute("aria-hidden"),
    ).toBe("true");
  });
});

describe("AddAgentPicker keyboard", () => {
  // Keydown on the input, which is where focus actually sits; the handler
  // lives on the popover content and receives it by bubbling.
  it("ArrowDown then Enter adds the second row", () => {
    const onAdd = vi.fn();
    open({ onAdd });
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onAdd).toHaveBeenCalledWith(HELPER);
  });

  it("ArrowUp clamps at the first row instead of wrapping", () => {
    const onAdd = vi.fn();
    open({ onAdd });
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onAdd).toHaveBeenCalledWith(PROBER);
  });

  it("End jumps to the last row", () => {
    const onAdd = vi.fn();
    open({ onAdd });
    fireEvent.keyDown(input(), { key: "End" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onAdd).toHaveBeenCalledWith(PROBE);
  });

  it("clears the query after a pick and stays open", () => {
    open({ onAdd: vi.fn() });
    fireEvent.change(input(), { target: { value: "zulu" } });
    fireEvent.click(list().getByText("Zulu Probe"));
    expect((input() as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("listbox")).toBeTruthy();
  });
});

describe("AddAgentPicker empty states", () => {
  it("says so when every owned agent is already a member", () => {
    open({ memberIds: new Set(ALL.map((a) => a.id)) });
    expect(
      list().getByText("Every agent you own is already a member."),
    ).toBeTruthy();
  });

  it("says so when the query matches nothing", () => {
    open();
    fireEvent.change(input(), { target: { value: "nobody" } });
    expect(list().getByText("No matching agent.")).toBeTruthy();
  });

  it("renders nothing at all when the viewer owns no agents", () => {
    open({ agents: [] });
    expect(screen.queryByRole("button", { name: /add agent/i })).toBeNull();
  });

  it("ignores clicks while a write is in flight", () => {
    const onAdd = vi.fn();
    open({ onAdd, busy: true });
    fireEvent.click(list().getByText("Helper Bot"));
    expect(onAdd).not.toHaveBeenCalled();
  });
});

const MEMBERS: Member[] = [
  {
    user: {
      id: 1,
      login: "user",
      display_name: "User",
      kind: "human",
      avatar_url: null,
      owner: null,
    },
    role: "admin",
    created_at: "2026-08-28T00:00:00Z",
  },
  {
    user: {
      id: HELPER.id,
      login: HELPER.login,
      display_name: HELPER.display_name,
      kind: "machine",
      avatar_url: null,
      owner: { id: 1, login: "user" },
    },
    role: "writer",
    created_at: "2026-08-28T00:00:00Z",
  },
];

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Seeded, not fetched: useSuspenseQuery would otherwise suspend on a
  // boundary this bare render does not provide.
  client.setQueryData(membersQuery("todou").queryKey, MEMBERS);
  client.setQueryData(agentsQuery.queryKey, ALL);
  return render(
    <QueryClientProvider client={client}>
      <MembersSection slug="todou" />
    </QueryClientProvider>,
  );
}

describe("MembersSection add agent", () => {
  it("adds the picked agent as a writer", async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    vi.stubGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method,
        body: init?.body === undefined ? undefined : String(init.body),
      });
      return new Response(null, { status: 204 });
    }) as typeof fetch);

    renderSection();
    fireEvent.click(screen.getByRole("button", { name: /add agent/i }));
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());

    // Already a member, so the picker must not offer it — the table still does.
    expect(list().queryByText("Helper Bot")).toBeNull();

    fireEvent.change(input(), { target: { value: "zulu" } });
    fireEvent.keyDown(input(), { key: "Enter" });

    await waitFor(() =>
      expect(calls.some((c) => c.method === "PUT")).toBe(true),
    );
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toContain(`/projects/todou/members/${PROBE2.id}`);
    expect(JSON.parse(put?.body ?? "{}")).toEqual({ role: "writer" });
  });

  it("draws the candidate's avatar exactly like the members table draws one", async () => {
    const { container } = renderSection();
    fireEvent.click(screen.getByRole("button", { name: /add agent/i }));
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());

    const inTable = container.querySelector(
      "[data-slot=table-cell] [data-slot=avatar]",
    );
    const inList = options()[0].querySelector("[data-slot=avatar]");
    expect(inTable).toBeTruthy();
    expect(inList).toBeTruthy();
    expect(inList?.className).toBe(inTable?.className);
  });
});
