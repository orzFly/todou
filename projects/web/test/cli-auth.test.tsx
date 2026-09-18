import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { Agent, CliAuthRequestInfo, Me } from "@todou/shared";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentsQuery,
  api,
  cliAuthRequestQuery,
  meQuery,
} from "../src/api/queries.ts";
import {
  defaultSelection,
  readLastAgentId,
} from "../src/components/shared/auth-target-picker.tsx";
import {
  CliAuthCard,
  CliAuthCodeCard,
  CliAuthPage,
  callbackUrl,
  parseCliAuthSearch,
} from "../src/pages/cli-auth.tsx";
import { safeRedirect } from "../src/pages/login.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

function withResolvers<T>() {
  const promiseConstructor = Promise as unknown as {
    withResolvers<U>(): {
      promise: Promise<U>;
      resolve: (value: U | PromiseLike<U>) => void;
      reject: (reason?: unknown) => void;
    };
  };
  return promiseConstructor.withResolvers<T>();
}

const me: Me = {
  id: 1,
  login: "orz",
  display_name: "Orz",
  kind: "human",
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: false,
  created_at: "2026-01-01T00:00:00.000Z",
};

function agent(id: number, login: string, disabled = false): Agent {
  return {
    id,
    login,
    // Deliberately unlike the login: the page has to show both, so a
    // fixture where they coincide would prove nothing (T-149).
    display_name: `Agent ${id}`,
    kind: "machine",
    avatar_url: null,
    owner: { id: 1, login: "orz" },
    email: null,
    is_instance_admin: false,
    created_at: "2026-01-01T00:00:00.000Z",
    disabled_at: disabled ? "2026-02-01T00:00:00.000Z" : null,
  };
}

describe("parseCliAuthSearch", () => {
  it("accepts a valid request and defaults the name", () => {
    expect(parseCliAuthSearch({ port: 4321, state: "abc" })).toEqual({
      kind: "loopback",
      port: 4321,
      state: "abc",
      name: "todou CLI",
    });
    expect(
      parseCliAuthSearch({ port: "4321", state: "abc", name: "cli @ bot-one" }),
    ).toEqual({
      kind: "loopback",
      port: 4321,
      state: "abc",
      name: "cli @ bot-one",
    });
  });

  it("rejects bad ports and missing state", () => {
    expect(parseCliAuthSearch({ port: 0, state: "abc" })).toBeNull();
    expect(parseCliAuthSearch({ port: 70000, state: "abc" })).toBeNull();
    expect(parseCliAuthSearch({ port: "x", state: "abc" })).toBeNull();
    expect(parseCliAuthSearch({ port: 4321 })).toBeNull();
  });

  it("takes a one-time code however the user typed it", () => {
    expect(parseCliAuthSearch({ code: "AB3D-EFGH" })).toEqual({
      kind: "code",
      code: "AB3DEFGH",
    });
    expect(parseCliAuthSearch({ code: "ab3defgh" })).toEqual({
      kind: "code",
      code: "AB3DEFGH",
    });
  });

  it("rejects codes of the wrong shape and mixed-up links", () => {
    expect(parseCliAuthSearch({ code: "AB3D" })).toBeNull();
    // I/L/O/U are not in the alphabet, so they cannot be a valid code.
    expect(parseCliAuthSearch({ code: "ILOUABCD" })).toBeNull();
    expect(parseCliAuthSearch({ code: "AB3DEFGH", port: 4321 })).toBeNull();
    expect(parseCliAuthSearch({ code: "AB3DEFGH", state: "abc" })).toBeNull();
  });
});

describe("callbackUrl", () => {
  it("targets loopback with encoded token and state", () => {
    expect(
      callbackUrl({ port: 4321, state: "a b", name: "n" }, "todou_pat_x/y"),
    ).toBe("http://127.0.0.1:4321/callback?token=todou_pat_x%2Fy&state=a+b");
  });
});

describe("defaultSelection", () => {
  const two = [agent(7, "bot-one"), agent(8, "bot-two")];

  it("prefers the last authorized agent", () => {
    expect(defaultSelection(two, 8)).toEqual({ kind: "agent", id: 8 });
  });

  it("falls back to a sole agent, else forces an explicit pick", () => {
    expect(defaultSelection([agent(7, "bot-one")], null)).toEqual({
      kind: "agent",
      id: 7,
    });
    expect(defaultSelection(two, null)).toBeNull();
    expect(defaultSelection(two, 99)).toBeNull();
  });

  it("lands on the create form when there are no agents", () => {
    expect(defaultSelection([], null)).toEqual({ kind: "new" });
  });
});

describe("CliAuthCard", () => {
  const request = { port: 4321, state: "s3cret", name: "cli @ test" };

  beforeEach(() => {
    window.localStorage.clear();
  });

  it("preselects the only agent, mints for it, and remembers it", async () => {
    const mint = vi.fn().mockResolvedValue({ token: "todou_pat_minted" });
    const deliver = vi.fn();
    const { getByRole } = renderWithQuery(
      <CliAuthCard
        request={request}
        me={me}
        agents={[agent(7, "bot-one")]}
        onCancel={() => {}}
        mint={mint}
        deliver={deliver}
      />,
    );
    expect(
      (getByRole("radio", { name: "Agent 7 @bot-one" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(mint).not.toHaveBeenCalled();

    fireEvent.click(getByRole("button", { name: "Authorize" }));
    await waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(mint).toHaveBeenCalledWith({ kind: "agent", id: 7 }, "cli @ test");
    expect(deliver).toHaveBeenCalledWith(
      "http://127.0.0.1:4321/callback?token=todou_pat_minted&state=s3cret",
    );
    expect(readLastAgentId()).toBe(7);
  });

  it("preselects the remembered agent and hides disabled ones", () => {
    const { getByRole, queryByRole } = renderWithQuery(
      <CliAuthCard
        request={request}
        me={me}
        agents={[
          agent(7, "bot-one"),
          agent(8, "bot-two"),
          agent(9, "old", true),
        ]}
        lastAgentId={8}
        onCancel={() => {}}
        mint={vi.fn()}
        deliver={() => {}}
      />,
    );
    expect(
      (getByRole("radio", { name: "Agent 8 @bot-two" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(queryByRole("radio", { name: "Agent 9 @old" })).toBeNull();
  });

  // Both chips on this page sit inside a `<label>` that owns a radio: a
  // `<label>` may not hold interactive content other than its own control,
  // and an anchor here would turn "pick this account" into "go and read
  // somebody's profile" (T-391).
  it("leaves both account chips unlinked inside their radio labels", () => {
    const { getByRole } = renderWithQuery(
      <CliAuthCard
        request={request}
        me={me}
        agents={[agent(7, "bot-one")]}
        onCancel={() => {}}
        mint={vi.fn()}
        deliver={() => {}}
      />,
    );
    const rowOf = (name: string) =>
      getByRole("radio", { name }).closest("label") as HTMLElement;

    for (const [row, shown] of [
      [rowOf("Agent 7 @bot-one"), "Agent 7"],
      [rowOf(`${me.display_name} (yourself)`), me.display_name],
    ] as const) {
      expect(row.querySelectorAll('a[href^="/users/"]')).toHaveLength(0);
      // The name is the other half: a row that stopped rendering its chip
      // would satisfy the line above without linking anything either.
      expect(row.textContent).toContain(shown);
    }
  });

  it("requires an explicit pick among several agents with no history", () => {
    const { getByRole } = renderWithQuery(
      <CliAuthCard
        request={request}
        me={me}
        agents={[agent(7, "bot-one"), agent(8, "bot-two")]}
        onCancel={() => {}}
        mint={vi.fn()}
        deliver={() => {}}
      />,
    );
    const button = getByRole("button", { name: "Authorize" });
    expect(button).toHaveProperty("disabled", true);
    fireEvent.click(getByRole("radio", { name: "Agent 7 @bot-one" }));
    expect(button).toHaveProperty("disabled", false);
  });

  it("creates a new agent inline when none exist", async () => {
    const mint = vi
      .fn()
      .mockResolvedValue({ token: "todou_pat_new", agentId: 42 });
    const deliver = vi.fn();
    const { getByRole } = renderWithQuery(
      <CliAuthCard
        request={request}
        me={me}
        agents={[]}
        onCancel={() => {}}
        mint={mint}
        deliver={deliver}
      />,
    );
    expect(
      (getByRole("radio", { name: "New agent" }) as HTMLInputElement).checked,
    ).toBe(true);
    const button = getByRole("button", { name: "Create & authorize" });
    expect(button).toHaveProperty("disabled", true);

    const input = getByRole("textbox", { name: "New agent login" });
    fireEvent.change(input, { target: { value: "Bad Name" } });
    expect(button).toHaveProperty("disabled", true);
    fireEvent.change(input, { target: { value: "review-bot" } });
    expect(button).toHaveProperty("disabled", false);

    fireEvent.click(button);
    await waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(mint).toHaveBeenCalledWith(
      { kind: "new", login: "review-bot" },
      "cli @ test",
    );
    expect(readLastAgentId()).toBe(42);
  });

  it("still allows authorizing yourself", async () => {
    const mint = vi.fn().mockResolvedValue({ token: "todou_pat_self" });
    const deliver = vi.fn();
    const { getByRole } = renderWithQuery(
      <CliAuthCard
        request={request}
        me={me}
        agents={[agent(7, "bot-one")]}
        onCancel={() => {}}
        mint={mint}
        deliver={deliver}
      />,
    );
    fireEvent.click(getByRole("radio", { name: "Orz (yourself)" }));
    fireEvent.click(getByRole("button", { name: "Authorize" }));
    await waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(mint).toHaveBeenCalledWith({ kind: "me" }, "cli @ test");
    expect(readLastAgentId()).toBeNull();
  });

  it("shows mint failures and cancels via the callback", async () => {
    const mint = vi.fn().mockRejectedValue(new Error("nope"));
    const onCancel = vi.fn();
    const { getByRole, getByText } = renderWithQuery(
      <CliAuthCard
        request={request}
        me={me}
        agents={[agent(7, "bot-one")]}
        onCancel={onCancel}
        mint={mint}
        deliver={() => {}}
      />,
    );
    fireEvent.click(getByRole("button", { name: "Authorize" }));
    await waitFor(() =>
      expect(getByText(/Could not issue the token/)).toBeTruthy(),
    );
    fireEvent.click(getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe("CliAuthCodeCard", () => {
  const request: CliAuthRequestInfo = {
    id: 7,
    name: "cli @ bot-one",
    code: "AB3DEFGH",
    created_at: "2026-08-29T10:00:00.000Z",
    expires_at: "2026-08-29T10:15:00.000Z",
  };

  beforeEach(() => {
    window.localStorage.clear();
  });

  it("shows the code to compare, then approves for the picked identity", async () => {
    const approve = vi.fn().mockResolvedValue({ agent_id: 7 });
    const { getByRole, getByText } = renderWithQuery(
      <CliAuthCodeCard
        request={request}
        me={me}
        agents={[agent(7, "bot-one")]}
        approve={approve}
        refuse={vi.fn()}
      />,
    );
    expect(getByText("AB3D-EFGH")).toBeTruthy();
    expect(getByText(/cli @ bot-one/)).toBeTruthy();

    fireEvent.click(getByRole("button", { name: "Authorize" }));
    await waitFor(() => expect(getByText(/Approved/)).toBeTruthy());
    expect(approve).toHaveBeenCalledWith(7, { kind: "agent", id: 7 });
    expect(readLastAgentId()).toBe(7);
  });

  it("remembers an agent created at approval time", async () => {
    const approve = vi.fn().mockResolvedValue({ agent_id: 42 });
    const { getByRole, getByText } = renderWithQuery(
      <CliAuthCodeCard
        request={request}
        me={me}
        agents={[]}
        approve={approve}
        refuse={vi.fn()}
      />,
    );
    fireEvent.change(getByRole("textbox", { name: "New agent login" }), {
      target: { value: "review-bot" },
    });
    fireEvent.click(getByRole("button", { name: "Create & authorize" }));
    await waitFor(() => expect(getByText(/Approved/)).toBeTruthy());
    expect(approve).toHaveBeenCalledWith(7, {
      kind: "new",
      login: "review-bot",
    });
    expect(readLastAgentId()).toBe(42);
  });

  it("does not remember anything when authorizing yourself", async () => {
    const approve = vi.fn().mockResolvedValue({ agent_id: null });
    const { getByRole, getByText } = renderWithQuery(
      <CliAuthCodeCard
        request={request}
        me={me}
        agents={[agent(7, "bot-one")]}
        approve={approve}
        refuse={vi.fn()}
      />,
    );
    fireEvent.click(getByRole("radio", { name: "Orz (yourself)" }));
    fireEvent.click(getByRole("button", { name: "Authorize" }));
    await waitFor(() => expect(getByText(/Approved/)).toBeTruthy());
    expect(approve).toHaveBeenCalledWith(7, { kind: "me" });
    expect(readLastAgentId()).toBeNull();
  });

  it("denies without issuing anything", async () => {
    const approve = vi.fn();
    const refuse = vi.fn().mockResolvedValue(undefined);
    const { getByRole, getByText } = renderWithQuery(
      <CliAuthCodeCard
        request={request}
        me={me}
        agents={[agent(7, "bot-one")]}
        approve={approve}
        refuse={refuse}
      />,
    );
    fireEvent.click(getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(getByText(/Denied/)).toBeTruthy());
    expect(refuse).toHaveBeenCalledWith(7);
    expect(approve).not.toHaveBeenCalled();
  });

  it("surfaces a refused approval and stays on the form", async () => {
    const approve = vi.fn().mockRejectedValue(new Error("already taken"));
    const { getByRole, getByText } = renderWithQuery(
      <CliAuthCodeCard
        request={request}
        me={me}
        agents={[agent(7, "bot-one")]}
        approve={approve}
        refuse={vi.fn()}
      />,
    );
    fireEvent.click(getByRole("button", { name: "Authorize" }));
    await waitFor(() => expect(getByText(/already taken/)).toBeTruthy());
    expect(getByRole("button", { name: "Deny" })).toBeTruthy();
  });
});

const pageRequest: CliAuthRequestInfo = {
  id: 7,
  name: "cli @ bot-one",
  code: "AB3DEFGH",
  created_at: "2026-08-29T10:00:00.000Z",
  expires_at: "2026-08-29T10:15:00.000Z",
};
const requestKey = cliAuthRequestQuery(pageRequest.code).queryKey;

function cliPage(entry: "loopback" | "code") {
  const client = testQueryClient();
  const meRead = vi.spyOn(api, "me").mockResolvedValue(me);
  const agentsRead = vi
    .spyOn(api, "listAgents")
    .mockResolvedValue([agent(7, "bot-one")]);
  const requestRead = vi
    .spyOn(api, "getCliAuthRequestByCode")
    .mockResolvedValue(pageRequest);
  return {
    client,
    meRead,
    agentsRead,
    requestRead,
    render: () =>
      renderWithProviders(<CliAuthPage />, client, {
        initialEntry:
          entry === "code"
            ? "/?code=AB3DEFGH"
            : "/?port=4321&state=s3cret&name=cli%20%40%20test",
      }),
  };
}

function httpError(message: string, status: number) {
  return Object.assign(new Error(message), { status });
}

describe("CliAuthPage read failures", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  describe.each([
    { entry: "loopback", content: "cli @ test" },
    { entry: "code", content: "AB3D-EFGH" },
  ] as const)("$entry identity reads", ({ entry, content }) => {
    it("keeps cached identities on a 500 refresh and scoped Retry replaces them", async () => {
      const page = cliPage(entry);
      page.client.setQueryData(meQuery.queryKey, me);
      page.client.setQueryData(agentsQuery.queryKey, [agent(7, "bot-one")]);
      if (entry === "code") page.client.setQueryData(requestKey, pageRequest);
      const view = page.render();
      await view.findByText(content);
      expect(
        view.getByRole("radio", { name: "Agent 7 @bot-one" }),
      ).toBeTruthy();
      await waitFor(() =>
        expect(
          page.client.getQueryState(agentsQuery.queryKey)?.fetchStatus,
        ).toBe("idle"),
      );

      page.agentsRead.mockRejectedValue(httpError("agents offline", 500));
      await act(async () => {
        await page.client.refetchQueries({ queryKey: agentsQuery.queryKey });
      });
      const notice = await view.findByText(/Couldn't refresh your agents/);
      expect(notice.textContent).toContain("agents offline");
      expect(notice.closest('[role="status"]')?.className).toContain(
        "text-amber",
      );
      expect(view.getByText(content)).toBeTruthy();
      expect(
        view.getByRole("radio", { name: "Agent 7 @bot-one" }),
      ).toBeTruthy();
      expect(
        view.queryByText(/Couldn't refresh this request|Could not load/),
      ).toBeNull();
      expect(view.queryByText(/expired/i)).toBeNull();

      page.agentsRead.mockResolvedValue([agent(8, "bot-two")]);
      const meCalls = page.meRead.mock.calls.length;
      const requestCalls = page.requestRead.mock.calls.length;
      fireEvent.click(view.getByRole("button", { name: "Retry" }));
      await view.findByRole("radio", { name: "Agent 8 @bot-two" });
      expect(
        view.queryByRole("radio", { name: "Agent 7 @bot-one" }),
      ).toBeNull();
      expect(view.queryByText(/Couldn't refresh your agents/)).toBeNull();
      await waitFor(() =>
        expect(page.meRead).toHaveBeenCalledTimes(meCalls + 1),
      );
      expect(page.requestRead).toHaveBeenCalledTimes(requestCalls);
    });

    it("keeps a cold 500 load failure visible during deferred Retry, then shows identities", async () => {
      const page = cliPage(entry);
      page.client.setQueryData(meQuery.queryKey, me);
      if (entry === "code") page.client.setQueryData(requestKey, pageRequest);
      page.agentsRead.mockRejectedValue(httpError("agents unavailable", 500));
      const view = page.render();
      expect(
        await view.findByText(/Could not load your agents: agents unavailable/),
      ).toBeTruthy();
      expect(
        view.queryByText(
          /Couldn't refresh your agents|Couldn't refresh this request/,
        ),
      ).toBeNull();
      expect(view.queryByText(/expired/i)).toBeNull();

      const retry = withResolvers<Agent[]>();
      page.agentsRead.mockReturnValue(retry.promise);
      const requestCalls = page.requestRead.mock.calls.length;
      fireEvent.click(view.getByRole("button", { name: "Retry" }));
      await waitFor(() =>
        expect(
          (view.getByRole("button", { name: "Retry" }) as HTMLButtonElement)
            .disabled,
        ).toBe(true),
      );
      expect(
        view.getByText(/Could not load your agents: agents unavailable/),
      ).toBeTruthy();
      await act(async () => retry.resolve([agent(8, "bot-two")]));
      expect(await view.findByText(content)).toBeTruthy();
      expect(
        view.getByRole("radio", { name: "Agent 8 @bot-two" }),
      ).toBeTruthy();
      expect(view.queryByText(/Could not load your agents/)).toBeNull();
      expect(page.requestRead).toHaveBeenCalledTimes(requestCalls);
    });

    it("silences a cached-me 401 without hiding concrete content", async () => {
      const page = cliPage(entry);
      page.client.setQueryData(meQuery.queryKey, me);
      page.client.setQueryData(agentsQuery.queryKey, [agent(7, "bot-one")]);
      if (entry === "code") page.client.setQueryData(requestKey, pageRequest);
      const view = page.render();
      await view.findByText(content);
      page.meRead.mockRejectedValue(httpError("session lost", 401));
      await act(async () => {
        await page.client.refetchQueries({ queryKey: meQuery.queryKey });
      });

      await waitFor(() =>
        expect(page.client.getQueryState(meQuery.queryKey)?.status).toBe(
          "error",
        ),
      );
      await waitFor(() => expect(view.getByText(content)).toBeTruthy());
      expect(
        view.getByRole("radio", { name: "Agent 7 @bot-one" }),
      ).toBeTruthy();
      expect(view.queryByText(/Couldn't refresh|Could not load/)).toBeNull();
      expect(view.queryByText(/expired/i)).toBeNull();
    });
  });

  it("keeps a cached code request on a 500 refresh and retries only that request", async () => {
    const page = cliPage("code");
    page.client.setQueryData(meQuery.queryKey, me);
    page.client.setQueryData(agentsQuery.queryKey, [agent(7, "bot-one")]);
    page.client.setQueryData(requestKey, pageRequest);
    const view = page.render();
    await view.findByText("AB3D-EFGH");
    await waitFor(() =>
      expect(page.client.getQueryState(requestKey)?.fetchStatus).toBe("idle"),
    );

    page.requestRead.mockRejectedValue(httpError("request offline", 500));
    await act(async () => {
      await page.client.refetchQueries({ queryKey: requestKey });
    });
    const notice = await view.findByText(/Couldn't refresh this request/);
    expect(notice.textContent).toContain("request offline");
    expect(notice.closest('[role="status"]')?.className).toContain(
      "text-amber",
    );
    expect(view.getByText("AB3D-EFGH")).toBeTruthy();
    expect(view.getByText("cli @ bot-one")).toBeTruthy();
    expect(
      view.queryByText(/Couldn't refresh your agents|Could not load/),
    ).toBeNull();
    expect(view.queryByText(/expired/i)).toBeNull();

    page.requestRead.mockResolvedValue({
      ...pageRequest,
      id: 8,
      name: "cli @ renewed",
    });
    const meCalls = page.meRead.mock.calls.length;
    const agentsCalls = page.agentsRead.mock.calls.length;
    const requestCalls = page.requestRead.mock.calls.length;
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    expect(await view.findByText("cli @ renewed")).toBeTruthy();
    expect(view.queryByText("cli @ bot-one")).toBeNull();
    expect(view.queryByText(/Couldn't refresh this request/)).toBeNull();
    expect(page.requestRead).toHaveBeenCalledTimes(requestCalls + 1);
    expect(page.meRead).toHaveBeenCalledTimes(meCalls);
    expect(page.agentsRead).toHaveBeenCalledTimes(agentsCalls);
  });

  it("keeps a cold code-request 500 visible during deferred Retry, then shows the card", async () => {
    const page = cliPage("code");
    page.client.setQueryData(meQuery.queryKey, me);
    page.client.setQueryData(agentsQuery.queryKey, [agent(7, "bot-one")]);
    page.requestRead.mockRejectedValue(httpError("request unavailable", 500));
    const view = page.render();
    expect(
      await view.findByText(/Could not load this request: request unavailable/),
    ).toBeTruthy();
    expect(
      view.queryByText(
        /Couldn't refresh this request|Couldn't refresh your agents/,
      ),
    ).toBeNull();
    expect(view.queryByText(/expired/i)).toBeNull();

    const retry = withResolvers<CliAuthRequestInfo>();
    page.requestRead.mockReturnValue(retry.promise);
    const meCalls = page.meRead.mock.calls.length;
    const agentsCalls = page.agentsRead.mock.calls.length;
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(
        (view.getByRole("button", { name: "Retry" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
    expect(
      view.getByText(/Could not load this request: request unavailable/),
    ).toBeTruthy();
    await act(async () => retry.resolve(pageRequest));
    expect(await view.findByText("AB3D-EFGH")).toBeTruthy();
    expect(view.getByText("cli @ bot-one")).toBeTruthy();
    expect(view.queryByText(/Could not load this request/)).toBeNull();
    expect(page.meRead).toHaveBeenCalledTimes(meCalls);
    expect(page.agentsRead).toHaveBeenCalledTimes(agentsCalls);
  });

  it.each(["cold", "cached"] as const)(
    "replaces a %s refused code request with expired guidance",
    async (state) => {
      const page = cliPage("code");
      page.client.setQueryData(meQuery.queryKey, me);
      page.client.setQueryData(agentsQuery.queryKey, [agent(7, "bot-one")]);
      if (state === "cached") page.client.setQueryData(requestKey, pageRequest);
      else page.requestRead.mockRejectedValue(httpError("gone", 404));
      const view = page.render();
      if (state === "cached") {
        await view.findByText("AB3D-EFGH");
        await waitFor(() =>
          expect(page.client.getQueryState(requestKey)?.fetchStatus).toBe(
            "idle",
          ),
        );
        page.requestRead.mockRejectedValue(httpError("gone", 404));
        await act(async () => {
          await page.client.refetchQueries({ queryKey: requestKey });
        });
      }

      expect(await view.findByText(/unknown or has expired/)).toBeTruthy();
      expect(view.queryByText("AB3D-EFGH")).toBeNull();
      expect(view.queryByText("cli @ bot-one")).toBeNull();
      expect(view.queryByRole("button", { name: "Authorize" })).toBeNull();
      expect(view.queryByText(/Couldn't refresh|Could not load/)).toBeNull();
    },
  );
});

describe("safeRedirect", () => {
  it("allows only same-site paths", () => {
    expect(safeRedirect("/cli-auth?port=1&state=x")).toBe(
      "/cli-auth?port=1&state=x",
    );
    expect(safeRedirect("//evil.example")).toBeUndefined();
    expect(safeRedirect("https://evil.example")).toBeUndefined();
    expect(safeRedirect(42)).toBeUndefined();
  });
});
