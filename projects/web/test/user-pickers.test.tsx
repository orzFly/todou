import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { IssueCounts, Me, Member } from "@todou/shared";
import { parseSearchQuery } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentsQuery, membersQuery, meQuery } from "../src/api/queries.ts";
import { FilterBar } from "../src/components/issue/filter-bar.tsx";
import { qualifierValueSource } from "../src/components/search/suggestions.ts";
import { AVATAR_SLOT } from "../src/components/shared/user-picker.tsx";
import { commandCompletionSource } from "../src/lib/editor/slash-commands.ts";
import {
  userAvatarOption,
  userOf,
  userOptionClass,
  withUser,
} from "../src/lib/editor/user-completion.tsx";
import { buildCommandRegistry } from "../src/lib/slash-commands.ts";
import { MembersSection } from "../src/pages/project-settings.tsx";
import { renderWithClient, renderWithProviders } from "./render.tsx";

const member = (
  id: number,
  login: string,
  displayName: string,
  kind: "human" | "machine" = "human",
): Member => ({
  user: {
    id,
    login,
    display_name: displayName,
    kind,
    avatar_url: null,
    owner: kind === "machine" ? { id: 1, login: "user" } : null,
  },
  role: "admin",
  created_at: "2026-01-01T00:00:00Z",
});

const MEMBERS: Member[] = [
  member(1, "user", "User"),
  member(2, "alice", "Alice Example"),
  member(3, "bot-one", "Bot One", "machine"),
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the list filter's assignee picker (T-677)", () => {
  const counts: IssueCounts = { open: 1, closed: 0, by_status: {} };

  function renderBar(assignee: number | undefined) {
    const onChange = vi.fn();
    renderWithClient(
      <FilterBar
        search={assignee === undefined ? {} : { assignee }}
        counts={counts}
        statuses={[]}
        labels={[]}
        members={MEMBERS}
        typed=""
        onTyped={() => {}}
        onChange={onChange}
      />,
    );
    return onChange;
  }

  it("writes the picked person and closes", () => {
    const onChange = renderBar(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Any assignee" }));
    fireEvent.click(screen.getByRole("option", { name: /Alice Example/ }));
    expect(onChange).toHaveBeenCalledWith({ assignee: 2 });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("clears the filter from the Any assignee row, which stands first", () => {
    const onChange = renderBar(2);
    fireEvent.click(
      screen.getByRole("button", { name: "Assignee: Alice Example" }),
    );
    const [first] = screen.getAllByRole("option");
    expect(first?.textContent).toBe("Any assignee");
    expect(first?.getAttribute("aria-selected")).toBe("false");
    fireEvent.click(first as HTMLElement);
    expect(onChange).toHaveBeenCalledWith({ assignee: undefined });
  });

  it("starts every row's text in one column, Any assignee included", () => {
    // happy-dom lays nothing out, so the column is checked as the class that
    // makes it: every row leads with the same slot, avatar or not.
    renderBar(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Any assignee" }));
    const tokens = AVATAR_SLOT.split(" ");
    expect(tokens.length).toBeGreaterThan(0);
    for (const row of screen.getAllByRole("option")) {
      expect(
        (row.firstElementChild as HTMLElement).className.split(" "),
      ).toEqual(expect.arrayContaining(tokens));
    }
  });

  it("drops the Any assignee row while filtering", () => {
    renderBar(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Any assignee" }));
    fireEvent.change(screen.getByLabelText("filter people"), {
      target: { value: "bot" },
    });
    expect(
      screen.getAllByRole("option").map((o) => o.children[2]?.textContent),
    ).toEqual(["@bot-one"]);
  });
});

describe("Add person's preview of the account a login names (T-677)", () => {
  const ME: Me = {
    ...MEMBERS[0]!.user,
    email: null,
    is_instance_admin: false,
    created_at: "2026-01-01T00:00:00Z",
  };

  async function openForm() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(membersQuery("todou").queryKey, MEMBERS);
    client.setQueryData(agentsQuery.queryKey, []);
    client.setQueryData(meQuery.queryKey, ME);
    renderWithProviders(<MembersSection slug="todou" />, client);
    fireEvent.click(await screen.findByRole("button", { name: "Add person" }));
    return screen.getByLabelText("login to add");
  }

  it("shows the account once the typed login settles", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", (async (input: unknown) => {
      seen.push(String(input));
      return Response.json({
        id: 9,
        login: "newcomer",
        display_name: "Newcomer Example",
        kind: "human",
        avatar_url: null,
        owner: null,
        created_at: "2026-01-01T00:00:00Z",
      });
    }) as typeof fetch);

    fireEvent.change(await openForm(), { target: { value: "newcomer" } });
    expect(await screen.findByText("Newcomer Example")).toBeTruthy();
    expect(screen.getByText("@newcomer")).toBeTruthy();
    expect(seen.filter((url) => url.includes("/users/"))).toEqual([
      expect.stringContaining("/users/newcomer"),
    ]);
  });

  it("says when no account has the login", async () => {
    vi.stubGlobal("fetch", (async () =>
      Response.json(
        { error: { code: "not_found", message: "user not found" } },
        { status: 404 },
      )) as typeof fetch);
    fireEvent.change(await openForm(), { target: { value: "nobody" } });
    expect(await screen.findByText("No account with this login.")).toBeTruthy();
  });

  it("never looks up an all-digit entry, which would read as a user id", async () => {
    const lookups = vi.fn();
    vi.stubGlobal("fetch", (async (input: unknown) => {
      lookups(String(input));
      return new Response(null, { status: 204 });
    }) as typeof fetch);
    fireEvent.change(await openForm(), { target: { value: "1234" } });
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(
      lookups.mock.calls.filter(([url]) => String(url).includes("/users/")),
    ).toEqual([]);
  });
});

describe("person rows in text completion (T-677)", () => {
  it("draws the avatar for a person's row and nothing for any other", async () => {
    const option = userAvatarOption(new QueryClient());
    const person = withUser({ label: "@bot-one" }, MEMBERS[2]!.user);
    const host = option.render(person) as HTMLElement;
    await act(async () => {});
    expect(host.querySelector("[data-slot=avatar]")).toBeTruthy();
    expect(host.querySelector('[aria-label="agent"]')).toBeTruthy();
    expect(userOptionClass(person)).toBe("cm-completion-user");

    const plain = { label: "#12" };
    expect(option.render(plain)).toBeNull();
    expect(userOptionClass(plain)).toBe("");
  });

  it("attaches the member to each /assign candidate, `me` included", () => {
    const registry = buildCommandRegistry({
      statuses: [],
      labels: [],
      members: MEMBERS,
      me: { id: 1, login: "user" },
      surface: "comment",
    });
    const doc = "/assign ";
    const result = commandCompletionSource(() => registry)(
      new CompletionContext(EditorState.create({ doc }), doc.length, false),
    );
    const rows = result?.options ?? [];
    expect(rows.map((o) => [o.label, userOf(o)?.id, o.detail])).toEqual([
      ["me", 1, "User"],
      ["user", 1, "User"],
      ["alice", 2, "Alice Example"],
      ["bot-one", 3, "Bot One"],
    ]);
  });

  it("carries the person on the search box's assignee values", () => {
    const query = "assignee:al";
    const { rows } = qualifierValueSource({
      assignee: MEMBERS.map((m) => ({
        value: m.user.login,
        hint: m.user.display_name,
        user: m.user,
      })),
    })({
      slug: "todou",
      query,
      caret: query.length,
      parts: parseSearchQuery(query),
    });
    expect(rows.map((r) => [r.text, r.hint, r.user?.id])).toEqual([
      ["alice", "Alice Example", 2],
    ]);
  });
});

describe("Escape and Enter in the shared picker", () => {
  it("closes on Escape from the filter", async () => {
    const onChange = vi.fn();
    renderWithClient(
      <FilterBar
        search={{}}
        counts={{ open: 0, closed: 0, by_status: {} }}
        statuses={[]}
        labels={[]}
        members={MEMBERS}
        typed=""
        onTyped={() => {}}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Any assignee" }));
    const input = screen.getByLabelText("filter people");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    // Row 0 is Any assignee, so one step down is the first person.
    expect(onChange).toHaveBeenCalledWith({ assignee: 1 });
    // The search here is fixed, so the trigger still reads as unfiltered.
    fireEvent.click(screen.getByRole("button", { name: "Any assignee" }));
    fireEvent.keyDown(screen.getByLabelText("filter people"), {
      key: "Escape",
    });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });
});
