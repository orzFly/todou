import { fireEvent, within } from "@testing-library/react";
import type { Project, ReferenceDirectory } from "@todou/shared";
import { describe, expect, it, vi } from "vitest";
import { referenceDirectoryQuery } from "../src/api/references.ts";
import {
  ProjectListbox,
  type ProjectListboxOption,
} from "../src/components/project-listbox.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";
import { expectVisible } from "./visibility.ts";

const project: Project = {
  id: 1,
  slug: "atlas",
  name: "Atlas Lab",
  description: "",
  icon_url: null,
  created_at: "2026-01-01T00:00:00Z",
};
const directory: ReferenceDirectory = {
  entries: [
    { prefix: "XYZ", slug: project.slug, from: project.created_at, to: null },
  ],
  contested: [],
};

describe("ProjectListbox accessible names", () => {
  it.each(["button", "link"] as const)(
    "keeps the decorative fallback out of a %s option's name",
    async (kind) => {
      const client = testQueryClient();
      client.setQueryData(referenceDirectoryQuery.queryKey, directory);
      const onSelect = vi.fn();
      const option: ProjectListboxOption = {
        project,
        ...(kind === "link"
          ? { link: { to: "/projects/$slug", params: { slug: project.slug } } }
          : {}),
      };
      const view = renderWithProviders(
        <ProjectListbox
          options={[option]}
          label="Pick a project"
          idPrefix="pick"
          searchPlaceholder="Search projects…"
          emptyText="No matching project."
          onSelect={onSelect}
        />,
        client,
      );
      const list = await view.findByRole("listbox", { name: "Pick a project" });
      // The trailing spelling is meaningful content and stays in the name.
      // No ariaLabel override: this exercises the name derived from the row.
      const row = within(list).getByRole("option", { name: "Atlas Lab XYZ" });
      const prefixes = within(row).getAllByText("XYZ", { exact: true });
      expect(prefixes).toHaveLength(2);
      for (const prefix of prefixes) expectVisible(prefix);
      expect(
        within(list).queryByRole("option", { name: "XYZ Atlas Lab XYZ" }),
      ).toBeNull();

      if (kind === "link") {
        expect(row.tagName).toBe("A");
        expect(row.getAttribute("href")).toBe("/projects/atlas");
      } else {
        fireEvent.click(row);
        expect(onSelect).toHaveBeenCalledExactlyOnceWith(option);
      }
    },
  );
});
