import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  type RenderResult,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import type { MemberRole, Project, Settings } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { insightsKeys, insightsSettingsQuery } from "../src/api/insights.ts";
import { projectQuery } from "../src/api/queries.ts";
import {
  InsightsSettings,
  insightsRolePreset,
} from "../src/components/insights/insights-settings.tsx";

const PROJECT: Project = {
  id: 1,
  slug: "todou",
  name: "todou",
  description: "The tracker itself.",
  created_at: "2026-08-01T00:00:00.000Z",
  icon_url: null,
};

const SETTINGS: Settings = {
  version: "opaque-v1",
  source: "default",
  roles: [
    {
      status_id: 1,
      name: "Todo",
      category: "open",
      color: "#6b7280",
      position: 0,
      role: "remaining",
    },
    {
      status_id: 2,
      name: "Done",
      category: "closed",
      color: "#22c55e",
      position: 1,
      role: "completed",
    },
    {
      status_id: 3,
      name: "Shipped",
      category: "closed",
      color: "#22c55e",
      position: 2,
      role: "completed",
    },
    {
      status_id: 4,
      name: "Invalid",
      category: "closed",
      color: "#999999",
      position: 3,
      role: "excluded",
    },
    {
      status_id: 5,
      name: "Archived",
      category: "closed",
      color: "#999999",
      position: 4,
      role: "completed",
    },
  ],
};

function renderSection(
  settings: Settings = SETTINGS,
  role: MemberRole = "admin",
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(projectQuery("todou").queryKey, {
    ...PROJECT,
    viewer_role: role,
  });
  client.setQueryData(insightsSettingsQuery("todou").queryKey, settings);
  const view = render(
    <QueryClientProvider client={client}>
      <InsightsSettings slug="todou" />
    </QueryClientProvider>,
  );
  return { view, client };
}

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Call = { url: string; method: string; body?: string };

function mockServer(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : String(init.body),
    };
    calls.push(call);
    return handler(call);
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, fetch };
}

function radio(
  view: RenderResult,
  status: string,
  category: "open" | "closed",
  role: "Remaining" | "Completed" | "Excluded",
) {
  return within(
    view.getByRole("group", { name: `${status} ${category}` }),
  ).getByRole("radio", { name: role }) as HTMLInputElement;
}

const saveButton = (view: RenderResult) =>
  view.getByRole("button", {
    name: "Save insights settings",
  }) as HTMLButtonElement;

const payload = (settings: Settings) => ({
  version: settings.version,
  roles: settings.roles.map(({ status_id, role }) => ({ status_id, role })),
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("InsightsSettings", () => {
  it("displays API roles and categories without deriving another default mapping", () => {
    const settings: Settings = {
      ...SETTINGS,
      roles: SETTINGS.roles.map((entry) => ({ ...entry, role: "excluded" })),
    };
    const { view } = renderSection(settings);
    expect(view.getAllByRole("radio")).toHaveLength(15);
    expect(radio(view, "Done", "closed", "Excluded").checked).toBe(true);
    expect(radio(view, "Todo", "open", "Excluded").checked).toBe(true);
    expect(view.container.textContent).toContain("Using default roles.");
    expect(view.container.textContent).toContain("entire chart history");
    expect(view.container.textContent).toContain("dependency blocking");
    expect(view.container.textContent).toContain(
      "All-closed counts still use status categories",
    );
    expect(
      view.getAllByRole("radio").every((input) => input.tagName === "INPUT"),
    ).toBe(true);
    const names = view
      .getAllByRole("radio")
      .map((input) => input.getAttribute("name"));
    expect(new Set(names).size).toBe(5);
    expect(saveButton(view).disabled).toBe(true);
  });

  it("shows an unknown role as selected without making an untouched form dirty", () => {
    const settings = {
      ...SETTINGS,
      roles: SETTINGS.roles.map((entry) =>
        entry.status_id === 1 ? { ...entry, role: "future-role" } : entry,
      ),
    } as Settings;
    const { calls } = mockServer(() => response(settings));
    const { view, client } = renderSection(settings);
    const unknown = view.getByRole("radio", {
      name: "Unknown role: future-role",
    }) as HTMLInputElement;
    expect(unknown.checked).toBe(true);
    expect(unknown.disabled).toBe(true);
    expect(radio(view, "Todo", "open", "Remaining").checked).toBe(false);
    expect(saveButton(view).disabled).toBe(true);
    act(() => {
      client.setQueryData(insightsKeys.settings("todou"), {
        ...settings,
        roles: settings.roles.map((entry) => ({ ...entry })),
      });
    });
    expect(view.getByRole("status").textContent).toBe("No unsaved changes");
    expect(view.queryByRole("alert")).toBeNull();
    fireEvent.submit(view.container.querySelector("form")!);
    expect(calls.filter((call) => call.method === "PUT")).toEqual([]);
  });

  it.each(["another row", "Default roles", "By open/closed category"])(
    "preserves the exact unknown role in the request after editing %s",
    async (action) => {
      const settings = {
        ...SETTINGS,
        roles: SETTINGS.roles.map((entry) =>
          entry.status_id === 4 ? { ...entry, role: "future-role" } : entry,
        ),
      } as Settings;
      const { calls } = mockServer(() => response(settings));
      const { view } = renderSection(settings);
      // Make the form dirty even when the preset matches all known roles.
      fireEvent.click(radio(view, "Todo", "open", "Excluded"));
      if (action !== "another row") {
        fireEvent.click(view.getByRole("button", { name: action }));
        fireEvent.click(radio(view, "Todo", "open", "Excluded"));
      }
      fireEvent.click(saveButton(view));
      await waitFor(() =>
        expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1),
      );
      const sent = JSON.parse(
        calls.find((call) => call.method === "PUT")!.body!,
      );
      expect(sent.roles).toContainEqual({
        status_id: 4,
        role: "future-role",
      });
      await waitFor(() => expect(saveButton(view).disabled).toBe(true));
    },
  );

  it("replaces an unknown role only after an explicit choice on that row", async () => {
    const settings = {
      ...SETTINGS,
      roles: SETTINGS.roles.map((entry) =>
        entry.status_id === 1 ? { ...entry, role: "future-role" } : entry,
      ),
    } as Settings;
    const saved = {
      ...settings,
      roles: SETTINGS.roles,
    };
    const { calls } = mockServer(() => response(saved));
    const { view } = renderSection(settings);
    fireEvent.click(radio(view, "Todo", "open", "Remaining"));
    expect(view.queryByRole("radio", { name: /Unknown role:/ })).toBeNull();
    expect(saveButton(view).disabled).toBe(false);
    fireEvent.click(saveButton(view));
    await waitFor(() =>
      expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1),
    );
    expect(
      JSON.parse(calls.find((call) => call.method === "PUT")!.body!).roles,
    ).toContainEqual({ status_id: 1, role: "remaining" });
    await waitFor(() => expect(saveButton(view).disabled).toBe(true));
  });

  it.each(["default", "category"] as const)(
    "keeps a role when the %s preset cannot recognize its category",
    (preset) => {
      const entries = [
        {
          ...SETTINGS.roles[4]!,
          category: "future-category",
          role: "excluded",
        },
      ] as unknown as Settings["roles"];
      expect(insightsRolePreset(entries, preset)[0]?.role).toBe("excluded");
    },
  );

  it("does not label an unknown settings source as saved", () => {
    const { view } = renderSection({
      ...SETTINGS,
      source: "future-source",
    } as unknown as Settings);
    expect(view.container.textContent).toContain(
      "Unknown settings source: future-source",
    );
    expect(view.container.textContent).not.toContain("Using saved roles.");
  });

  it("keeps an unknown role visible for readers without permitting writes", () => {
    const settings = {
      ...SETTINGS,
      roles: [{ ...SETTINGS.roles[0]!, role: "future-role" }],
    } as unknown as Settings;
    const { calls } = mockServer(() => response(settings));
    const { view } = renderSection(settings, "reader");
    const unknown = view.getByRole("radio", {
      name: "Unknown role: future-role",
    }) as HTMLInputElement;
    expect(unknown.checked).toBe(true);
    expect(unknown.disabled).toBe(true);
    fireEvent.submit(view.container.querySelector("form")!);
    expect(calls.filter((call) => call.method === "PUT")).toEqual([]);
  });

  it.each([undefined, null, "", 42])(
    "rejects a malformed required insights role %s instead of displaying unknown",
    (role) => {
      const settings = {
        ...SETTINGS,
        roles: [{ ...SETTINGS.roles[0]!, role }],
      } as unknown as Settings;
      expect(() => renderSection(settings)).toThrow(
        "insights role must be a non-empty string",
      );
      expect(() => insightsRolePreset(settings.roles, "category")).toThrow(
        "insights role must be a non-empty string",
      );
    },
  );

  it.each([undefined, null, "", 42])(
    "rejects a malformed source or preset category %s",
    (value) => {
      expect(() =>
        renderSection({ ...SETTINGS, source: value } as unknown as Settings),
      ).toThrow("insights settings source must be a non-empty string");
      expect(() =>
        insightsRolePreset(
          [{ ...SETTINGS.roles[0]!, category: value }] as Settings["roles"],
          "category",
        ),
      ).toThrow("status category must be a non-empty string");
    },
  );

  it("uses exact default names and category fallback, while category excludes nothing", () => {
    const entries: Settings["roles"] = [
      { ...SETTINGS.roles[0]!, name: "Shipped" },
      { ...SETTINGS.roles[0]!, status_id: 6, name: "Done" },
      { ...SETTINGS.roles[0]!, status_id: 7, name: "Invalid" },
      { ...SETTINGS.roles[0]!, status_id: 8, name: "done" },
      SETTINGS.roles[4]!,
    ];
    expect(
      insightsRolePreset(entries, "default").map((entry) => entry.role),
    ).toEqual(["completed", "completed", "excluded", "remaining", "completed"]);
    expect(
      insightsRolePreset(entries, "category").map((entry) => entry.role),
    ).toEqual([
      "remaining",
      "remaining",
      "remaining",
      "remaining",
      "completed",
    ]);
    expect(entries[0]?.role).toBe("remaining");
  });

  it("keeps both presets local until an explicit save and tracks reverting to clean", () => {
    const { fetch } = mockServer(() => response(SETTINGS));
    const { view, client } = renderSection();
    fireEvent.click(
      view.getByRole("button", { name: "By open/closed category" }),
    );
    expect(radio(view, "Invalid", "closed", "Completed").checked).toBe(true);
    expect(saveButton(view).disabled).toBe(false);
    expect(view.getByRole("status").textContent).toBe("Unsaved changes");
    expect(client.getQueryData(insightsKeys.settings("todou"))).toEqual(
      SETTINGS,
    );
    fireEvent.click(view.getByRole("button", { name: "Default roles" }));
    expect(radio(view, "Invalid", "closed", "Excluded").checked).toBe(true);
    expect(saveButton(view).disabled).toBe(true);
    expect(view.getByRole("status").textContent).toBe("No unsaved changes");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("tracks a radio change and changing it back without contacting the server", () => {
    const { fetch } = mockServer(() => response(SETTINGS));
    const { view } = renderSection();
    fireEvent.click(radio(view, "Todo", "open", "Completed"));
    expect(saveButton(view).disabled).toBe(false);
    fireEvent.click(radio(view, "Todo", "open", "Remaining"));
    expect(saveButton(view).disabled).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lets a reader see settings but prevents changes, presets, and submissions", () => {
    const { fetch } = mockServer(() => response(SETTINGS));
    const { view } = renderSection(SETTINGS, "reader");
    expect(
      view
        .getAllByRole("group")
        .every((group) => (group as HTMLFieldSetElement).disabled),
    ).toBe(true);
    expect(
      view.queryByRole("button", { name: "Save insights settings" }),
    ).toBeNull();
    expect(view.queryByRole("button", { name: "Default roles" })).toBeNull();
    expect(
      view.queryByRole("button", { name: "By open/closed category" }),
    ).toBeNull();
    fireEvent.click(radio(view, "Todo", "open", "Completed"));
    fireEvent.submit(view.container.querySelector("form")!);
    expect(radio(view, "Todo", "open", "Remaining").checked).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("saves the complete status set and opaque version, then refreshes burn queries", async () => {
    const saved: Settings = {
      ...SETTINGS,
      version: "opaque-v2",
      source: "saved",
      roles: SETTINGS.roles.map((entry) =>
        entry.status_id === 1 ? { ...entry, role: "completed" } : entry,
      ),
    };
    const { calls } = mockServer(() => response(saved));
    const { view, client } = renderSection();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    fireEvent.click(radio(view, "Todo", "open", "Completed"));
    fireEvent.click(saveButton(view));
    await waitFor(() =>
      expect(view.getByRole("status").textContent).toBe("No unsaved changes"),
    );
    const puts = calls.filter((call) => call.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0]?.url).toContain("/api/projects/todou/insights/settings");
    expect(JSON.parse(puts[0]!.body!)).toEqual({
      ...payload(saved),
      version: SETTINGS.version,
    });
    expect(client.getQueryData(insightsKeys.settings("todou"))).toEqual(saved);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: insightsKeys.burn("todou"),
    });
    expect(view.container.textContent).toContain("Using saved roles.");
    expect(saveButton(view).disabled).toBe(true);
  });

  it("preserves the draft and its original version across a background refresh", async () => {
    const latest: Settings = {
      ...SETTINGS,
      version: "opaque-v2",
      source: "saved",
    };
    const { calls } = mockServer(() => response(latest));
    const { view, client } = renderSection();
    fireEvent.click(radio(view, "Todo", "open", "Excluded"));
    act(() => {
      client.setQueryData(insightsKeys.settings("todou"), latest);
    });
    expect(radio(view, "Todo", "open", "Excluded").checked).toBe(true);
    fireEvent.click(saveButton(view));
    await waitFor(() =>
      expect(calls.some((call) => call.method === "PUT")).toBe(true),
    );
    expect(
      JSON.parse(calls.find((call) => call.method === "PUT")!.body!).version,
    ).toBe("opaque-v1");
    await waitFor(() =>
      expect(view.getByRole("status").textContent).toBe("No unsaved changes"),
    );
  });

  it("keeps choices on 409 until explicit reload, then saves all new statuses with the new version", async () => {
    const latest: Settings = {
      ...SETTINGS,
      version: "opaque-v2",
      source: "saved",
      roles: [
        ...SETTINGS.roles,
        {
          status_id: 6,
          name: "Review",
          category: "open",
          color: "#6b7280",
          position: 5,
          role: "remaining",
        },
      ],
    };
    let puts = 0;
    const { calls } = mockServer((call) => {
      if (call.method === "PUT" && ++puts === 1) {
        return response(
          { error: { code: "conflict", message: "Settings changed" } },
          409,
        );
      }
      return response(latest);
    });
    const { view, client } = renderSection();
    fireEvent.click(radio(view, "Todo", "open", "Excluded"));
    fireEvent.click(saveButton(view));
    await view.findByRole("alert");
    await waitFor(() =>
      expect(client.getQueryData(insightsKeys.settings("todou"))).toEqual(
        latest,
      ),
    );
    expect(radio(view, "Todo", "open", "Excluded").checked).toBe(true);
    expect(view.queryByRole("group", { name: "Review open" })).toBeNull();
    expect(view.getByRole("alert").textContent).toContain(
      "Your choices have been kept",
    );
    expect(saveButton(view).disabled).toBe(true);
    fireEvent.submit(view.container.querySelector("form")!);
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    await waitFor(() => {
      const reload = view.getByRole("button", {
        name: "Reload settings",
      }) as HTMLButtonElement;
      expect(reload.disabled).toBe(false);
    });
    fireEvent.click(view.getByRole("button", { name: "Reload settings" }));
    await view.findByRole("group", { name: "Review open" });
    expect(view.queryByRole("alert")).toBeNull();
    expect(radio(view, "Todo", "open", "Remaining").checked).toBe(true);
    expect(saveButton(view).disabled).toBe(true);
    fireEvent.click(radio(view, "Review", "open", "Completed"));
    fireEvent.click(saveButton(view));
    await waitFor(() =>
      expect(calls.filter((call) => call.method === "PUT")).toHaveLength(2),
    );
    const second = JSON.parse(
      calls.filter((call) => call.method === "PUT")[1]!.body!,
    );
    expect(second.version).toBe(latest.version);
    expect(second.roles).toHaveLength(6);
    expect(second.roles[5]).toEqual({ status_id: 6, role: "completed" });
    await waitFor(() =>
      expect(view.getByRole("status").textContent).toBe("No unsaved changes"),
    );
  });

  it("retains a draft after other errors so the user can retry explicitly", async () => {
    const { calls } = mockServer(() =>
      response(
        { error: { code: "internal_error", message: "Save failed" } },
        500,
      ),
    );
    const { view } = renderSection();
    fireEvent.click(radio(view, "Todo", "open", "Excluded"));
    fireEvent.click(saveButton(view));
    await view.findByRole("alert");
    await waitFor(() => expect(saveButton(view).disabled).toBe(false));
    expect(view.getByRole("alert").textContent).toContain("Save failed");
    expect(radio(view, "Todo", "open", "Excluded").checked).toBe(true);
    expect(view.queryByRole("button", { name: "Reload settings" })).toBeNull();
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });

  it("does not discard choices when reloading after a conflict fails", async () => {
    let gets = 0;
    mockServer((call) => {
      if (call.method === "PUT") {
        return response(
          { error: { code: "conflict", message: "Settings changed" } },
          409,
        );
      }
      if (++gets === 1) return response(SETTINGS);
      return response(
        { error: { code: "internal_error", message: "Reload failed" } },
        500,
      );
    });
    const { view } = renderSection();
    fireEvent.click(radio(view, "Todo", "open", "Excluded"));
    fireEvent.click(saveButton(view));
    await view.findByRole("alert");
    await waitFor(() => {
      const reload = view.getByRole("button", {
        name: "Reload settings",
      }) as HTMLButtonElement;
      expect(reload.disabled).toBe(false);
    });
    fireEvent.click(view.getByRole("button", { name: "Reload settings" }));
    await waitFor(() => expect(view.getAllByRole("alert")).toHaveLength(2));
    expect(view.getAllByRole("alert")[1]?.textContent).toContain(
      "Reload failed",
    );
    expect(radio(view, "Todo", "open", "Excluded").checked).toBe(true);
    expect(saveButton(view).disabled).toBe(true);
    expect(view.getByRole("status").textContent).toBe("Unsaved changes");
  });

  it("disables editing and duplicate submissions while a save is pending", async () => {
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    const { calls } = mockServer((call) =>
      call.method === "PUT" ? pending : response(SETTINGS),
    );
    const { view } = renderSection();
    fireEvent.click(radio(view, "Todo", "open", "Excluded"));
    fireEvent.click(saveButton(view));
    await waitFor(() =>
      expect(
        view.getByRole("button", { name: "Saving…" }).hasAttribute("disabled"),
      ).toBe(true),
    );
    expect(
      view
        .getAllByRole("group")
        .every((group) => (group as HTMLFieldSetElement).disabled),
    ).toBe(true);
    expect(
      (view.getByRole("button", { name: "Default roles" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.submit(view.container.querySelector("form")!);
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    resolve(response(SETTINGS));
    await waitFor(() =>
      expect(view.getByRole("status").textContent).toBe("No unsaved changes"),
    );
  });
});
