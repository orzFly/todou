import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MemberRole, Project, ReferenceDirectory } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectQuery } from "../src/api/queries.ts";
import { referenceDirectoryQuery } from "../src/api/references.ts";
import { ProjectSection } from "../src/pages/project-settings.tsx";

const PROJECT: Project = {
  id: 1,
  slug: "todou",
  name: "todou",
  description: "The tracker itself.",
  created_at: "2026-08-01T00:00:00.000Z",
  icon_url: null,
};

function renderSection(
  viewer_role: MemberRole = "admin",
  directory?: ReferenceDirectory,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(projectQuery("todou").queryKey, {
    ...PROJECT,
    viewer_role,
  });
  if (directory) {
    client.setQueryData(referenceDirectoryQuery.queryKey, directory);
  }
  const invalidated: unknown[][] = [];
  const real = client.invalidateQueries.bind(client);
  vi.spyOn(client, "invalidateQueries").mockImplementation((filters) => {
    const key = (filters as { queryKey?: unknown[] } | undefined)?.queryKey;
    if (key) invalidated.push(key);
    return real(filters);
  });
  render(
    <QueryClientProvider client={client}>
      <ProjectSection slug="todou" />
    </QueryClientProvider>,
  );
  return { invalidated };
}

/** The icon editor's own drop zone, which the name/description form has not. */
const iconZone = () => screen.queryByRole("group", { name: "icon" });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the project icon editor", () => {
  it("is not rendered at all for someone who cannot update the project", () => {
    // Hidden rather than disabled: a reader has nothing to read here that the
    // icon beside the project's name does not already show.
    renderSection("reader");
    expect(iconZone()).toBeNull();
  });

  it("is there for an admin", () => {
    renderSection("admin");
    expect(iconZone()).not.toBeNull();
  });

  it("draws the same three characters of a long REF that every list row draws", async () => {
    // The editor is the one face that does not go through `ProjectIcon`, and
    // it drew the whole of a 20-character REF straight out of its box and
    // across to the Upload button beside it.
    renderSection("admin", {
      entries: [
        {
          prefix: "W".repeat(20),
          slug: "todou",
          from: "2020-01-01T00:00:00.000Z",
          to: null,
        },
      ],
      contested: [],
    });
    const zone = await waitFor(() => {
      const found = iconZone();
      expect(
        found?.querySelector('[data-slot="avatar-fallback"]')?.textContent,
      ).toBe("WWW");
      return found as HTMLElement;
    });
    expect(zone.querySelector('[data-slot="avatar"]')?.className).toContain(
      "overflow-hidden",
    );
  });

  it("refreshes every surface that draws the icon after an upload", async () => {
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(
          JSON.stringify({ ...PROJECT, icon_url: "/api/projects/1/icon?v=a" }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    );

    const { invalidated } = renderSection("admin");
    const input = document
      .querySelector("fieldset[aria-label=icon]")
      ?.querySelector("input[type=file]") as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "i.png", { type: "image/png" })] },
    });

    // The icon rides in three caches: this page, every project list, and the
    // bot list's project chips. Missing one leaves a stale image on screen.
    await waitFor(() => {
      const keys = invalidated.map((k) => JSON.stringify(k));
      expect(keys).toContain(JSON.stringify(["project", "todou"]));
      expect(keys).toContain(JSON.stringify(["projects"]));
      expect(keys).toContain(JSON.stringify(["agent-memberships"]));
    });
  });
});
