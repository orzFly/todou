import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { Label, LabelUsage } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { labelsQuery, labelUsageQuery } from "../src/api/queries.ts";
import { labelColorFor } from "../src/lib/labels.ts";
import { LabelsSection } from "../src/pages/project-settings.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const LABELS: Label[] = [
  { id: 1, name: "area:web", color: "#3b82f6" },
  { id: 2, name: "kind:bug", color: "#ef4444" },
];
const USAGE: LabelUsage[] = [
  { id: 1, open_issues: 2, issues: 3 },
  { id: 2, open_issues: 0, issues: 0 },
];

type Call = { url: string; method?: string; body?: string };

function stubFetch(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body === undefined ? undefined : String(init.body);
    calls.push({ url, method: init?.method, body });
    const payload = url.endsWith("/labels/usage")
      ? USAGE
      : url.endsWith("/labels") && (init?.method ?? "GET") === "GET"
        ? LABELS
        : { id: 9, name: "x", color: "#6b7280" };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  return calls;
}

const writes = (calls: Call[]) =>
  calls.filter((c) => c.method !== undefined && c.method !== "GET");

async function renderSection() {
  const client = testQueryClient();
  client.setQueryData(labelsQuery("todou").queryKey, LABELS);
  client.setQueryData(labelUsageQuery("todou").queryKey, USAGE);
  const view = renderWithProviders(<LabelsSection slug="todou" />, client);
  await screen.findByLabelText("edit label area:web");
  return view;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Labels settings (T-713)", () => {
  it("saves a rename and a recolour as one PATCH with the trimmed name", async () => {
    const calls = stubFetch();
    await renderSection();
    fireEvent.click(screen.getByLabelText("edit label area:web"));
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    expect(name.value).toBe("area:web");
    fireEvent.change(name, { target: { value: "  area:frontend " } });
    fireEvent.click(screen.getByLabelText("set area:frontend color #22c55e"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    const [patch] = writes(calls);
    expect(patch?.method).toBe("PATCH");
    expect(patch?.url).toContain("/labels/1");
    expect(JSON.parse(patch?.body ?? "{}")).toEqual({
      name: "area:frontend",
      color: "#22c55e",
    });
    await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
  });

  it("sends only what changed", async () => {
    const calls = stubFetch();
    await renderSection();
    fireEvent.click(screen.getByLabelText("edit label kind:bug"));
    fireEvent.click(screen.getByLabelText("set kind:bug color #22c55e"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(JSON.parse(writes(calls)[0]?.body ?? "{}")).toEqual({
      color: "#22c55e",
    });
  });

  it("keeps Save off until something changes, and Escape sends nothing", async () => {
    const calls = stubFetch();
    await renderSection();
    fireEvent.click(screen.getByLabelText("edit label area:web"));
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "area:frontend" },
    });
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Escape" });
    expect(screen.queryByLabelText("Name")).toBeNull();
    // The closed row draws the stored label again, not the abandoned draft.
    expect(screen.getByLabelText("edit label area:web").textContent).toBe(
      "area:web",
    );
    expect(writes(calls)).toEqual([]);
  });

  it("previews the draft in the row's own chip", async () => {
    stubFetch();
    await renderSection();
    const row = screen.getByLabelText("edit label area:web");
    fireEvent.click(row);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "kind:frontend" },
    });
    expect(row.textContent).toBe("kind:frontend");
  });

  it("links each open count to the list filtered by that label", async () => {
    stubFetch();
    const view = await renderSection();
    const link = screen.getByRole("link", { name: "2 open" });
    expect(link.getAttribute("href")).toMatch(/^\/projects\/todou\?label=/);
    fireEvent.click(link);
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe("/projects/todou"),
    );
    // The list's own filter value: the id, as the filter bar writes it.
    expect(view.router.state.location.search).toEqual({ label: "1" });
  });

  it("asks before deleting, and says how many issues lose the label", async () => {
    const calls = stubFetch();
    await renderSection();
    fireEvent.click(screen.getByLabelText("edit label area:web"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(writes(calls)).toEqual([]);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(
      "It comes off 3 issues at once, and there is no undo.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete label" }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]?.method).toBe("DELETE");
    expect(writes(calls)[0]?.url).toContain("/labels/1");
  });

  it("gives a new label the picker's colour for its name until one is picked", async () => {
    const calls = stubFetch();
    await renderSection();
    fireEvent.click(screen.getByRole("button", { name: /New label/ }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: " area:docs " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(JSON.parse(writes(calls)[0]?.body ?? "{}")).toEqual({
      name: "area:docs",
      color: labelColorFor("area:docs"),
    });

    fireEvent.click(screen.getByRole("button", { name: /New label/ }));
    fireEvent.click(screen.getByLabelText("set new label color #8b5cf6"));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "upstream" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    expect(JSON.parse(writes(calls)[1]?.body ?? "{}")).toEqual({
      name: "upstream",
      color: "#8b5cf6",
    });
  });
});
