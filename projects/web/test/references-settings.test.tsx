import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { ReferenceConfig } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { referenceConfigQuery } from "../src/api/references.ts";
import { ReferencesSection } from "../src/pages/project-settings.tsx";

const baseConfig: ReferenceConfig = {
  format: { prefix: null, history: [] },
  autolinks: [
    { id: 5, prefix: "JIRA-", url_template: "https://jira.example/<num>" },
  ],
};

function renderSection(config: ReferenceConfig = baseConfig) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(referenceConfigQuery("todou").queryKey, config);
  const view = render(
    <QueryClientProvider client={client}>
      <ReferencesSection slug="todou" />
    </QueryClientProvider>,
  );
  return { view, client };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ReferencesSection", () => {
  it("shows the current format, rules, and a live preview", () => {
    const { view } = renderSection();
    expect(
      view.container.querySelector("[data-testid='ref-format-preview']")
        ?.textContent,
    ).toBe("#76");
    expect(view.container.textContent).toContain("JIRA-");
    expect(view.container.textContent).toContain("https://jira.example/<num>");

    const input = view.container.querySelector(
      "input[aria-label='reference format prefix']",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "t" } });
    // Uppercased on input; preview follows the draft.
    expect(input.value).toBe("T");
    expect(
      view.container.querySelector("[data-testid='ref-format-preview']")
        ?.textContent,
    ).toBe("T-76");
  });

  it("saves the format via PUT and disables Save while clean", async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    vi.stubGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method,
        body: init?.body === undefined ? undefined : String(init.body),
      });
      return new Response(
        JSON.stringify({
          format: {
            prefix: "T",
            history: [
              { prefix: "T", effective_from: "2026-08-13T00:00:00.000Z" },
            ],
          },
          autolinks: baseConfig.autolinks,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch);

    const { view } = renderSection();
    const save = [...view.container.querySelectorAll("button")].find(
      (b) => b.textContent === "Save",
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    const input = view.container.querySelector(
      "input[aria-label='reference format prefix']",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "T" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() => {
      const put = calls.find((c) => c.method === "PUT");
      expect(put).toBeDefined();
      expect(put?.url).toContain("/projects/todou/references/format");
      expect(put?.body).toBe(JSON.stringify({ prefix: "T" }));
    });
  });

  it("adds and deletes autolinks through the API", async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    vi.stubGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({
        url: String(input),
        method,
        body: init?.body === undefined ? undefined : String(init.body),
      });
      if (method === "DELETE") return new Response(null, { status: 204 });
      if (method === "POST") {
        return new Response(
          JSON.stringify({
            id: 9,
            prefix: "GH-",
            url_template: "https://github.com/o/r/issues/<num>",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      // Invalidation refetches the config; keep the table stable.
      return new Response(JSON.stringify(baseConfig), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch);

    const { view } = renderSection();
    fireEvent.change(
      view.container.querySelector(
        "input[aria-label='autolink prefix']",
      ) as HTMLInputElement,
      { target: { value: "GH-" } },
    );
    fireEvent.change(
      view.container.querySelector(
        "input[aria-label='autolink url template']",
      ) as HTMLInputElement,
      { target: { value: "https://github.com/o/r/issues/<num>" } },
    );
    const add = [...view.container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Add"),
    ) as HTMLButtonElement;
    fireEvent.click(add);
    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST");
      expect(post?.url).toContain("/projects/todou/references/autolinks");
      expect(post?.body).toBe(
        JSON.stringify({
          prefix: "GH-",
          url_template: "https://github.com/o/r/issues/<num>",
        }),
      );
    });

    fireEvent.click(
      view.container.querySelector(
        "button[aria-label='delete autolink JIRA-']",
      ) as HTMLButtonElement,
    );
    await waitFor(() => {
      const del = calls.find((c) => c.method === "DELETE");
      expect(del?.url).toContain("/projects/todou/references/autolinks/5");
    });
  });
});
