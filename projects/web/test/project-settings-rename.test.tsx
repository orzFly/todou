import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Label } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { labelsQuery } from "../src/api/queries.ts";
import { LabelsSection } from "../src/pages/project-settings.tsx";

const LABELS: Label[] = [
  { id: 1, name: "area:web", color: "#3b82f6" },
  { id: 2, name: "kind:bug", color: "#ef4444" },
];

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(labelsQuery("todou").queryKey, LABELS);
  return render(
    <QueryClientProvider client={client}>
      <LabelsSection slug="todou" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LabelsSection rename", () => {
  it("renames via PATCH with the trimmed name", async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    vi.stubGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method,
        body: init?.body === undefined ? undefined : String(init.body),
      });
      return new Response(
        JSON.stringify({ id: 1, name: "area:frontend", color: "#3b82f6" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch);

    renderSection();
    fireEvent.click(screen.getByLabelText("rename label area:web"));
    const input = screen.getByLabelText(
      "new name for area:web",
    ) as HTMLInputElement;
    expect(input.value).toBe("area:web");
    fireEvent.change(input, { target: { value: "  area:frontend " } });
    fireEvent.click(screen.getByLabelText("save name for area:web"));

    // The success invalidation refetches the labels list, so filter to the
    // mutation call instead of counting requests.
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PATCH")).toBe(true),
    );
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toContain("/labels/1");
    expect(JSON.parse(patch?.body ?? "{}")).toEqual({
      name: "area:frontend",
    });
    // The form closes back into the chip row.
    await waitFor(() =>
      expect(screen.queryByLabelText("new name for area:web")).toBeNull(),
    );
  });

  it("escape and an unchanged name both cancel without a request", () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (async (input: unknown) => {
      calls.push(String(input));
      return new Response("{}", { status: 200 });
    }) as typeof fetch);

    renderSection();
    fireEvent.click(screen.getByLabelText("rename label area:web"));
    fireEvent.keyDown(screen.getByLabelText("new name for area:web"), {
      key: "Escape",
    });
    expect(screen.queryByLabelText("new name for area:web")).toBeNull();

    fireEvent.click(screen.getByLabelText("rename label kind:bug"));
    fireEvent.click(screen.getByLabelText("save name for kind:bug"));
    expect(screen.queryByLabelText("new name for kind:bug")).toBeNull();
    expect(calls).toEqual([]);
  });
});
