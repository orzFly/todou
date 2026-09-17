import type { QueryClient } from "@tanstack/react-query";
import { fireEvent, waitFor, within } from "@testing-library/react";
import type { Project, ReferenceDirectory } from "@todou/shared";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { referenceDirectoryQuery } from "../src/api/references.ts";
import {
  ProjectListbox,
  type ProjectListboxOption,
} from "../src/components/project-listbox.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

function project(slug: string): Project {
  return {
    id: slug.length,
    slug,
    name: slug,
    description: "",
    created_at: "2026-01-01T00:00:00Z",
  };
}

const FEW = ["alpha", "beta", "gamma"].map(project);
const MANY = Array.from({ length: 9 }, (_, i) => project(`p${i}`));

function renderListbox(
  options: ProjectListboxOption[],
  extra: {
    onSelect?: (option: ProjectListboxOption) => void;
    selected?: string;
  } = {},
) {
  const view = renderWithProviders(
    <ProjectListbox
      options={options}
      label="Pick a project"
      idPrefix="pick"
      searchPlaceholder="Search projects…"
      emptyText="No matching project."
      {...extra}
    />,
  );
  return view;
}

const asButtons = (projects: Project[]): ProjectListboxOption[] =>
  projects.map((p) => ({ project: p }));

const asLinks = (projects: Project[]): ProjectListboxOption[] =>
  projects.map((p) => ({
    project: p,
    link: { to: "/projects/$slug", params: { slug: p.slug } },
  }));

async function listbox(view: ReturnType<typeof renderListbox>) {
  return waitFor(() => within(view.container).getByRole("listbox"));
}

function highlighted(list: HTMLElement): string | null {
  return list.getAttribute("aria-activedescendant");
}

describe("ProjectListbox row semantics", () => {
  it("renders a link row as an anchor carrying the destination", async () => {
    const view = renderListbox(asLinks(FEW));
    const list = await listbox(view);
    const rows = within(list).getAllByRole("option");
    expect(rows.map((el) => el.tagName)).toEqual(["A", "A", "A"]);
    expect(rows[1]?.getAttribute("href")).toBe("/projects/beta");
  });

  it("renders a button row as a button and hands the choice back", async () => {
    const onSelect = vi.fn();
    const view = renderListbox(asButtons(FEW), { onSelect });
    const list = await listbox(view);
    const rows = within(list).getAllByRole("option");
    expect(rows.map((el) => el.tagName)).toEqual([
      "BUTTON",
      "BUTTON",
      "BUTTON",
    ]);

    fireEvent.click(rows[1] as HTMLElement);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        project: expect.objectContaining({ slug: "beta" }),
      }),
    );
  });

  it("marks the project in force only when the caller names one", async () => {
    const marked = await listbox(
      renderListbox(asButtons(FEW), { selected: "beta" }),
    );
    expect(
      within(marked)
        .getAllByRole("option")
        .map((el) => el.getAttribute("aria-selected")),
    ).toEqual(["false", "true", "false"]);
  });
});

describe("ProjectListbox keyboard walking", () => {
  it("walks with the arrows and stops at both ends", async () => {
    const view = renderListbox(asButtons(FEW));
    const list = await listbox(view);
    expect(highlighted(list)).toBe("pick-alpha");

    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(highlighted(list)).toBe("pick-beta");
    for (let i = 0; i < 5; i++) fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(highlighted(list)).toBe("pick-gamma");

    for (let i = 0; i < 5; i++) fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(highlighted(list)).toBe("pick-alpha");
  });

  it("jumps to either end with Home and End", async () => {
    const view = renderListbox(asButtons(FEW));
    const list = await listbox(view);
    fireEvent.keyDown(list, { key: "End" });
    expect(highlighted(list)).toBe("pick-gamma");
    fireEvent.keyDown(list, { key: "Home" });
    expect(highlighted(list)).toBe("pick-alpha");
  });

  it("hands the highlighted row back on Enter", async () => {
    const onSelect = vi.fn();
    const view = renderListbox(asButtons(FEW), { onSelect });
    const list = await listbox(view);
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        project: expect.objectContaining({ slug: "beta" }),
      }),
    );
  });
});

describe("ProjectListbox filtering", () => {
  it("hides the search box below the threshold and shows it at it", async () => {
    const few = renderListbox(asButtons(FEW));
    await listbox(few);
    expect(within(few.container).queryByRole("combobox")).toBeNull();

    const many = renderListbox(asButtons(MANY));
    await listbox(many);
    expect(within(many.container).getByRole("combobox")).toBeTruthy();
  });

  it("filters by name and says so when nothing matches", async () => {
    const view = renderListbox(asButtons(MANY));
    const list = await listbox(view);
    const input = within(view.container).getByRole("combobox");

    fireEvent.change(input, { target: { value: "p7" } });
    await waitFor(() =>
      expect(within(list).getAllByRole("option")).toHaveLength(1),
    );

    fireEvent.change(input, { target: { value: "no-such" } });
    await waitFor(() =>
      expect(
        within(view.container).getByText("No matching project."),
      ).toBeTruthy(),
    );
  });

  it("moves the highlight onto the search box while there is one", async () => {
    const view = renderListbox(asButtons(MANY));
    const list = await listbox(view);
    const input = within(view.container).getByRole("combobox");
    // Focus is in the box, so that is where the walking has to be announced.
    expect(highlighted(list)).toBeNull();
    fireEvent.keyDown(input, { key: "End" });
    expect(highlighted(input)).toBe("pick-p8");
  });

  it("pulls the highlight back in when the list shrinks under it", async () => {
    function Shrinkable() {
      const [all, setAll] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setAll(false)}>
            shrink
          </button>
          <ProjectListbox
            options={asButtons(all ? MANY : FEW)}
            label="Pick a project"
            idPrefix="pick"
            searchPlaceholder="Search projects…"
            emptyText="No matching project."
          />
        </>
      );
    }
    const view = renderWithProviders(<Shrinkable />);
    const input = await waitFor(() =>
      within(view.container).getByRole("combobox"),
    );
    fireEvent.keyDown(input, { key: "End" });
    expect(highlighted(input)).toBe("pick-p8");

    fireEvent.click(within(view.container).getByText("shrink"));
    const list = await waitFor(() =>
      within(view.container).getByRole("listbox"),
    );
    await waitFor(() =>
      expect(within(list).getAllByRole("option")).toHaveLength(3),
    );
    expect(highlighted(list)).toBe("pick-gamma");
  });
});

describe("ProjectListbox filtering by REF", () => {
  /** A directory in which `homelab` holds `CH`, and nothing is contested. */
  const withPrefix = () => {
    const client = testQueryClient();
    const directory: ReferenceDirectory = {
      entries: [
        {
          prefix: "CH",
          slug: "homelab",
          from: "2020-01-01T00:00:00.000Z",
          to: null,
        },
      ],
      contested: [],
    };
    client.setQueryData(referenceDirectoryQuery.queryKey, directory);
    return client;
  };

  const search = async (client: QueryClient, query: string) => {
    const view = renderWithProviders(
      <ProjectListbox
        options={asButtons([...MANY, project("homelab")])}
        label="Pick a project"
        idPrefix="pick"
        searchPlaceholder="Search projects…"
        emptyText="No matching project."
      />,
      client,
    );
    const input = await waitFor(() =>
      within(view.container).getByRole("combobox"),
    );
    fireEvent.change(input, { target: { value: query } });
    return view;
  };

  it("reaches a project by its REF prefix", async () => {
    // The whole complaint behind this card: `CH` used to match nothing.
    const view = await search(withPrefix(), "CH");
    const list = await listbox(view);
    await waitFor(() =>
      expect(within(list).getAllByRole("option")).toHaveLength(1),
    );
    const row = within(list).getByRole("option");
    expect(row.textContent).toContain("homelab");
    // The token at the row's end is the bare REF, and the hit is painted on
    // it. (The square icon beside the name also falls back to the REF, so
    // "CH" is on this row twice — hence the precise query.)
    const token = row.querySelector('[data-slot="project-spelling"]');
    expect(token?.textContent).toBe("CH");
    expect(token?.querySelector("mark")?.textContent).toBe("CH");
  });

  it("takes a prefix that still has its card hyphen attached", async () => {
    const view = await search(withPrefix(), "ch-");
    const list = await listbox(view);
    await waitFor(() =>
      expect(within(list).getAllByRole("option")).toHaveLength(1),
    );
  });

  it("finds nothing by REF while the directory is unavailable", async () => {
    // No directory means no prefix for any project, which is what the list
    // looked like before this card — name and slug only.
    const view = await search(testQueryClient(), "CH");
    const list = await listbox(view);
    await waitFor(() =>
      expect(within(list).queryAllByRole("option")).toHaveLength(0),
    );
  });
});
