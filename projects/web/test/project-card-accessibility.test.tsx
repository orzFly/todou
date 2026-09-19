import { waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectCard } from "../src/components/shared/project-card.tsx";
import { renderWithProviders } from "./render.tsx";
import { expectVisible } from "./visibility.ts";

const project = { slug: "atlas", name: "Atlas Lab", prefix: "XYZ" };

afterEach(() => vi.unstubAllGlobals());

describe("ProjectCard accessible name", () => {
  it("draws the fallback prefix without adding it to the link name", async () => {
    const view = renderWithProviders(<ProjectCard project={project} />);
    const link = await view.findByRole("link", { name: "Atlas Lab XYZ" });

    // The meaningful watermark names the REF once; the decorative icon must
    // not prepend a duplicate prefix to that accessible name.
    expect(within(link).getByRole("img", { name: "XYZ" })).toBeTruthy();
    const fallback = within(link).getByText("XYZ", {
      selector: '[data-slot="avatar-fallback"]',
    });
    expectVisible(fallback);
    expect(link.getAttribute("href")).toBe("/projects/atlas");
    expect(view.queryByRole("link", { name: "XYZ Atlas Lab XYZ" })).toBeNull();
  });

  it("replaces the fallback with an uploaded image without changing the link name", async () => {
    class LoadedImage extends EventTarget {
      complete = true;
      naturalWidth = 20;
      crossOrigin: string | null = null;
      referrerPolicy = "";
      src = "";
    }
    vi.stubGlobal("Image", LoadedImage);
    const iconUrl = "/api/projects/1/icon?v=card";
    const view = renderWithProviders(
      <ProjectCard project={{ ...project, icon_url: iconUrl }} />,
    );
    const link = await view.findByRole("link", { name: "Atlas Lab XYZ" });

    await waitFor(() => {
      const image = link.querySelector("img");
      expect(image?.getAttribute("src")).toBe(iconUrl);
      expectVisible(image as HTMLImageElement);
      expect(
        within(link).queryByText("XYZ", {
          selector: '[data-slot="avatar-fallback"]',
        }),
      ).toBeNull();
    });
    expect(view.getByRole("link", { name: "Atlas Lab XYZ" })).toBe(link);
    // Empty alt already keeps a loaded image out of the link's name;
    // the fallback test above is the guard for this placement's hide.
    expect(within(link).getAllByRole("img")).toEqual([
      within(link).getByRole("img", { name: "XYZ" }),
    ]);
  });
});
