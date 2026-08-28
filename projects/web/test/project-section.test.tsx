import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Project } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectQuery } from "../src/api/queries.ts";
import { ProjectSection } from "../src/pages/project-settings.tsx";

const PROJECT: Project = {
  id: 1,
  slug: "todou",
  name: "todou",
  description: "The tracker itself.",
  created_at: "2026-08-01T00:00:00.000Z",
};

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(projectQuery("todou").queryKey, PROJECT);
  return render(
    <QueryClientProvider client={client}>
      <ProjectSection slug="todou" />
    </QueryClientProvider>,
  );
}

function stubFetch() {
  const calls: Array<{ url: string; method?: string; body?: string }> = [];
  vi.stubGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      body: init?.body === undefined ? undefined : String(init.body),
    });
    return new Response(JSON.stringify({ ...PROJECT, name: "Todou" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ProjectSection", () => {
  it("shows the current name and description", () => {
    stubFetch();
    renderSection();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "todou",
    );
    expect(
      (screen.getByLabelText("Description") as HTMLTextAreaElement).value,
    ).toBe("The tracker itself.");
  });

  it("patches only the field that changed", async () => {
    const calls = stubFetch();
    renderSection();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "  Todou " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The success invalidation refetches, so filter to the mutation call.
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PATCH")).toBe(true),
    );
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toContain("/api/projects/todou");
    expect(JSON.parse(patch?.body ?? "{}")).toEqual({ name: "Todou" });
  });

  it("keeps Save disabled while nothing effectively changed", () => {
    const calls = stubFetch();
    renderSection();
    const save = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    // Edited back to the stored value — whitespace only is not a change.
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "todou  " },
    });
    expect(save.disabled).toBe(true);

    // An empty name would 400 at the server; block it here instead.
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: " " } });
    expect(save.disabled).toBe(true);

    fireEvent.click(save);
    expect(calls).toEqual([]);
  });
});
