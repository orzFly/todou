import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { Agent, CliAuthRequestInfo, Me } from "@todou/shared";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CliAuthCard,
  CliAuthCodeCard,
  callbackUrl,
  defaultSelection,
  parseCliAuthSearch,
  readLastAgentId,
} from "../src/pages/cli-auth.tsx";
import { safeRedirect } from "../src/pages/login.tsx";

function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
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
