import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  Agent,
  Me,
  MePrefs,
  TokenCreated,
  TokenListItem,
  TokenScope,
} from "@todou/shared";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prefsQuery } from "../src/api/prefs.ts";
import {
  agentsQuery,
  api,
  meQuery,
  myTokensQuery,
  projectsQuery,
} from "../src/api/queries.ts";
import { router } from "../src/router.tsx";
import { restoreAppRouterPage, teardownAppRouter } from "./app-router.tsx";
import { testQueryClient } from "./render.tsx";

const me: Me = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human",
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: false,
  created_at: "2026-01-01T00:00:00Z",
};

const prefs: MePrefs = {
  show_weak_unread: true,
  ref_placement_list: "before",
  ref_placement_board: "own_line",
  ref_placement_detail: "before",
  ref_placement_reference: "before",
  boxed_ref_links: true,
  truncate_ref_title: true,
  show_repeated_ref_title: false,
  open_external_links_in_new_tab: false,
  project_icon_fallback: "colorful_text",
  user_avatar_fallback: "monochrome_text",
};

function agent(id: number, login: string, disabled = false): Agent {
  return {
    id,
    login,
    display_name: login,
    kind: "machine",
    avatar_url: null,
    owner: { id: me.id, login: me.login },
    email: null,
    is_instance_admin: false,
    created_at: "2026-08-28T00:00:00Z",
    disabled_at: disabled ? "2026-09-01T00:00:00Z" : null,
  };
}

const BOT = agent(7, "bot-one");
const HELPER = agent(8, "bot-two");

function token(id: number, name: string, holder: Me | Agent): TokenListItem {
  return {
    id,
    name,
    prefix: `td_${id}`,
    created_at: "2026-09-01T12:00:00Z",
    expires_at: null,
    scopes: [],
    revoked_at: null,
    last_used_at: null,
    holder,
  };
}

// The same name under two holders, so a revoke button can only be found by
// naming whose token it is.
const MINE = token(11, "cli", me);
const BOTS = token(12, "cli", BOT);
const HELPERS = token(13, "ci", HELPER);
const ALL = [MINE, BOTS, HELPERS];

/** The app's own route tree, entered at `path`, with a stubbed API. */
function mountAt(
  path: string,
  agents: Agent[] = [BOT, HELPER],
  tokens: TokenListItem[] = ALL,
) {
  const listMyTokens = vi.spyOn(api, "listMyTokens").mockResolvedValue(tokens);
  const listAgentTokens = vi.spyOn(api, "listAgentTokens");
  vi.spyOn(api, "listAgents").mockResolvedValue(agents);
  const client = testQueryClient();
  client.setQueryData(meQuery.queryKey, me);
  client.setQueryData(prefsQuery.queryKey, prefs);
  client.setQueryData(projectsQuery.queryKey, []);
  client.setQueryData(agentsQuery.queryKey, agents);
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  void router.navigate({ href: path, replace: true }).catch(() => undefined);
  return { listMyTokens, listAgentTokens };
}

const page = async () =>
  within(
    (
      await screen.findByRole("heading", {
        level: 1,
        name: "Personal access tokens",
      })
    ).closest("div.space-y-10") as HTMLElement,
  );

const rowNames = (view: Awaited<ReturnType<typeof page>>) =>
  view
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.textContent);

afterEach(() => {
  vi.restoreAllMocks();
  restoreAppRouterPage();
});
afterAll(() => teardownAppRouter());

describe("personal tokens by holder (T-560)", () => {
  it("opens on User: only my tokens, no Holder column", async () => {
    mountAt("/settings/tokens");
    const view = await page();
    await waitFor(() =>
      expect(view.getByRole("link", { name: "User 1" })).toBeTruthy(),
    );
    expect(view.queryByRole("columnheader", { name: "Holder" })).toBeNull();
    const rows = rowNames(view);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("td_11");
    expect(view.getByText(/Tokens act as you over the REST API/)).toBeTruthy();
  });

  it("an unknown ?holder= falls back to User", async () => {
    mountAt("/settings/tokens?holder=everyone");
    const view = await page();
    await waitFor(() =>
      expect(
        view.getByRole("link", { name: "User 1" }).getAttribute("aria-current"),
      ).toBe("page"),
    );
    expect(view.queryByRole("columnheader", { name: "Holder" })).toBeNull();
    const rows = rowNames(view);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("td_11");
    expect(view.getByText(/Tokens act as you over the REST API/)).toBeTruthy();
  });

  it("each segment is a link to its own address, exactly one current", async () => {
    mountAt("/settings/tokens?holder=agents");
    const view = await page();
    const links = await waitFor(() => {
      const found = ["User 1", "Agents 2", "All 3"].map((name) =>
        view.getByRole("link", { name }),
      );
      expect(found[1]?.getAttribute("aria-current")).toBe("page");
      return found;
    });
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/settings/tokens",
      "/settings/tokens?holder=agents",
      "/settings/tokens?holder=all",
    ]);
    expect(
      links.filter((l) => l.getAttribute("aria-current") === "page"),
    ).toHaveLength(1);
  });

  it("Agents shows only agents' tokens, each with its holder", async () => {
    mountAt("/settings/tokens?holder=agents");
    const view = await page();
    await waitFor(() =>
      expect(view.getByRole("columnheader", { name: "Holder" })).toBeTruthy(),
    );
    const rows = rowNames(view);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("bot-one");
    expect(rows[1]).toContain("bot-two");
    expect(rows.join()).not.toContain("td_11");
    expect(view.getByText(/acts as its agent, not as you/)).toBeTruthy();
  });

  it("loads every row with one holder=all request, never per agent", async () => {
    const { listMyTokens, listAgentTokens } = mountAt(
      "/settings/tokens?holder=all",
    );
    const view = await page();
    await waitFor(() => expect(rowNames(view)).toHaveLength(3));
    expect(listMyTokens).toHaveBeenCalledWith("all");
    expect(listAgentTokens).not.toHaveBeenCalled();
  });

  it("revokes an agent's token through the agent endpoint, mine through /me", async () => {
    mountAt("/settings/tokens?holder=all");
    const revokeAgent = vi
      .spyOn(api, "revokeAgentToken")
      .mockResolvedValue(undefined);
    const revokeMine = vi.spyOn(api, "revokeMyToken").mockResolvedValue();
    const view = await page();

    fireEvent.click(
      await view.findByRole("button", { name: "revoke cli of bot-one" }),
    );
    await waitFor(() => expect(revokeAgent).toHaveBeenCalledWith(7, 12));
    expect(revokeMine).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("button", { name: "revoke cli of user" }));
    await waitFor(() => expect(revokeMine).toHaveBeenCalledWith(11));
    expect(revokeAgent).toHaveBeenCalledTimes(1);
  });

  it("issues for an agent through the agent endpoint", async () => {
    mountAt("/settings/tokens");
    const issueAgent = vi.spyOn(api, "issueAgentToken").mockResolvedValue({
      id: 99,
      token: "todou_pat_fallback",
      prefix: "td_99",
      name: "deploy",
      expires_at: null,
      scopes: [],
    });
    const createMine = vi.spyOn(api, "createMyToken");
    const view = await page();

    fireEvent.click(await view.findByRole("button", { name: /^Issue for/ }));
    fireEvent.click(await screen.findByRole("option", { name: /@bot-two/ }));
    fireEvent.change(view.getByPlaceholderText("Token name (e.g. cli, ci)"), {
      target: { value: "deploy" },
    });
    fireEvent.click(view.getByRole("button", { name: "Issue token" }));

    await waitFor(() =>
      expect(issueAgent).toHaveBeenCalledWith(8, {
        name: "deploy",
        expires_at: null,
      }),
    );
    expect(createMine).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("heading", {
        name: "Token created for @bot-two",
      }),
    ).toBeTruthy();
  });

  it("offers only active agents to issue for", async () => {
    mountAt("/settings/tokens", [BOT, agent(9, "retired-bot", true)]);
    const view = await page();
    fireEvent.click(await view.findByRole("button", { name: /^Issue for/ }));
    // The login is the row's third child, after the avatar and the name.
    const options = (await screen.findAllByRole("option")).map(
      (o) => o.children[2]?.textContent,
    );
    expect(options).toEqual(["@user", "@bot-one"]);
  });

  it("without agents there is nothing to filter or issue for", async () => {
    mountAt("/settings/tokens?holder=agents", [], [MINE]);
    const view = await page();
    await waitFor(() => expect(rowNames(view)).toHaveLength(1));
    expect(view.queryByRole("link", { name: /^User/ })).toBeNull();
    expect(view.queryByRole("button", { name: /^Issue for/ })).toBeNull();
  });
});

describe("token scopes (T-693)", () => {
  const scopeBox = (view: Awaited<ReturnType<typeof page>>, scope: string) =>
    view.queryByRole("checkbox", {
      name: new RegExp(`^${scope}`),
    }) as HTMLInputElement | null;
  const created = (scopes: TokenCreated["scopes"]): TokenCreated => ({
    id: 98,
    token: "todou_pat_fallback",
    prefix: "td_98",
    name: "proxy",
    expires_at: null,
    scopes,
  });

  it("issues my token with the scopes ticked, none by default", async () => {
    mountAt("/settings/tokens");
    const createMine = vi
      .spyOn(api, "createMyToken")
      .mockResolvedValue(created(["agents:act", "agents:create"]));
    const view = await page();
    const act = await waitFor(() => {
      const found = scopeBox(view, "agents:act");
      expect(found?.checked).toBe(false);
      return found as HTMLInputElement;
    });
    expect(scopeBox(view, "agents:create")?.checked).toBe(false);

    // Creating implies acting: ticking it ticks agents:act too.
    fireEvent.click(scopeBox(view, "agents:create") as HTMLInputElement);
    expect(act.checked).toBe(true);
    fireEvent.change(view.getByRole("textbox", { name: "Name" }), {
      target: { value: "proxy" },
    });
    fireEvent.click(view.getByRole("button", { name: "Issue token" }));

    await waitFor(() =>
      expect(createMine).toHaveBeenCalledWith({
        name: "proxy",
        expires_at: null,
        scopes: ["agents:act", "agents:create"],
      }),
    );
    const dialog = within(
      await screen.findByRole("dialog", { name: "Token created" }),
    );
    expect(dialog.getByText("x-todou-act-as: <agent login>")).toBeTruthy();
    // Reset for the next token, once the reveal is dismissed.
    fireEvent.click(dialog.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(scopeBox(view, "agents:act")?.checked).toBe(false),
    );
  });

  it("unticking agents:act unticks agents:create", async () => {
    mountAt("/settings/tokens");
    const view = await page();
    const create = await waitFor(
      () => scopeBox(view, "agents:create") as HTMLInputElement,
    );
    fireEvent.click(create);
    fireEvent.click(scopeBox(view, "agents:act") as HTMLInputElement);
    expect(scopeBox(view, "agents:act")?.checked).toBe(false);
    expect(create.checked).toBe(false);
  });

  it("hides the scopes while issuing for an agent, and forgets them", async () => {
    mountAt("/settings/tokens");
    const issueAgent = vi.spyOn(api, "issueAgentToken").mockResolvedValue({
      ...created([]),
      id: 99,
      name: "deploy",
    });
    const createMine = vi.spyOn(api, "createMyToken");
    const view = await page();
    fireEvent.click(
      await waitFor(() => scopeBox(view, "agents:act") as HTMLInputElement),
    );

    fireEvent.click(view.getByRole("button", { name: /^Issue for/ }));
    fireEvent.click(await screen.findByRole("option", { name: /@bot-two/ }));
    await waitFor(() => expect(scopeBox(view, "agents:act")).toBeNull());
    fireEvent.change(view.getByRole("textbox", { name: "Name" }), {
      target: { value: "deploy" },
    });
    fireEvent.click(view.getByRole("button", { name: "Issue token" }));
    await waitFor(() =>
      expect(issueAgent).toHaveBeenCalledWith(8, {
        name: "deploy",
        expires_at: null,
      }),
    );

    // Back on myself, the earlier tick did not survive the detour.
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    fireEvent.click(view.getByRole("button", { name: /^Issue for/ }));
    fireEvent.click(await screen.findByRole("option", { name: /@user/ }));
    await waitFor(() =>
      expect(scopeBox(view, "agents:act")?.checked).toBe(false),
    );
    expect(createMine).not.toHaveBeenCalled();
  });

  it("lists each token's scopes, including ones this build does not know", async () => {
    mountAt(
      "/settings/tokens?holder=all",
      [BOT, HELPER],
      [
        { ...MINE, scopes: ["agents:act"] },
        {
          ...token(14, "proxy", me),
          // A newer server's scope, as an older page would receive it.
          scopes: ["agents:act", "issues:read" as TokenScope],
        },
        BOTS,
      ],
    );
    const view = await page();
    await waitFor(() => expect(rowNames(view)).toHaveLength(3));
    expect(view.getByRole("columnheader", { name: "Scopes" })).toBeTruthy();
    const rows = rowNames(view);
    expect(rows[0]).toContain("agents:act");
    expect(rows[1]).toContain("agents:act");
    expect(rows[1]).toContain("issues:read");
    expect(rows[2]).not.toContain("agents:");
  });
});
