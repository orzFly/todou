import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { IssueReferences, Project } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, projectsQuery } from "../src/api/queries.ts";
import {
  applyInvalidation,
  invalidationsFor,
} from "../src/api/useUserEvents.ts";
import { IssueReferencesDialog } from "../src/components/issue/references-dialog.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const SLUG = "p";
const AT = "2026-09-01T00:00:00.000Z";

const projects: Project[] = ["p", "q"].map((slug, index) => ({
  id: index + 1,
  slug,
  name: slug,
  description: "",
  created_at: AT,
}));

const entry = (
  project_id: number,
  number: number,
  comment_id: number | null = null,
  more = 0,
) => ({ project_id, number, comment_id, more, created_at: AT });

const REFS: IssueReferences = {
  linked_from: [entry(1, 5, 501), entry(9, 3), entry(1, 7)],
  links_to: [entry(1, 7, 601, 2), entry(2, 8)],
};

function mount(refs: IssueReferences = REFS) {
  const fetch = vi.spyOn(api, "getIssueReferences").mockResolvedValue(refs);
  const onOpenChange = vi.fn();
  const client = testQueryClient();
  client.setQueryData(projectsQuery.queryKey, projects);
  renderWithProviders(
    <IssueReferencesDialog
      slug={SLUG}
      issueNumber={16}
      open
      onOpenChange={onOpenChange}
    />,
    client,
  );
  return { fetch, onOpenChange, client };
}

const section = async (name: string) =>
  screen.findByRole("region", { name }).then((el) => within(el));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("IssueReferencesDialog", () => {
  it("lists both directions with their counts", async () => {
    const { fetch } = mount();
    expect(await screen.findByText("All references")).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith(SLUG, 16);

    const from = await section("Linked from");
    await waitFor(() => expect(from.getAllByRole("listitem")).toHaveLength(3));
    expect(from.getByRole("heading").textContent).toBe("Linked from 3");
    const to = await section("Links to");
    expect(to.getAllByRole("listitem")).toHaveLength(2);
    expect(to.getByRole("heading").textContent).toBe("Links to 2");
  });

  it("says None for an empty direction", async () => {
    mount({ linked_from: REFS.linked_from, links_to: [] });
    const to = await section("Links to");
    expect(await to.findByText("None")).toBeTruthy();
  });

  it("marks a card on both sides, on both sides", async () => {
    mount();
    await screen.findAllByRole("listitem");
    const marks = screen.getAllByRole("img", { name: "Links both ways" });
    expect(marks).toHaveLength(2);
    for (const mark of marks) {
      expect(mark.closest("li")?.textContent).toContain("7");
    }
  });

  it("links each comment on the card that holds it", async () => {
    mount();
    const from = await section("Linked from");
    const fromRow = (await from.findAllByRole("listitem"))[0] as HTMLElement;
    expect(
      within(fromRow)
        .getByRole("link", { name: "comment" })
        .getAttribute("href"),
    ).toBe("/projects/p/issues/5#comment-501");

    const to = await section("Links to");
    const toRow = to.getAllByRole("listitem")[0] as HTMLElement;
    expect(
      within(toRow).getByRole("link", { name: "comment" }).getAttribute("href"),
    ).toBe("/projects/p/issues/16#comment-601");
    expect(toRow.textContent).toContain("comment +2");
    expect(to.getAllByRole("listitem")[1]?.textContent).toContain("body");
  });

  it("does not name a card in a project the reader cannot see", async () => {
    mount();
    const from = await section("Linked from");
    const rows = await from.findAllByRole("listitem");
    expect(rows[1]?.textContent).toContain("a card you cannot see");
  });

  it("closes on a plain click through, not on a modified one", async () => {
    const { onOpenChange } = mount();
    const to = await section("Links to");
    const link = (await to.findAllByRole("link", { name: "comment" }))[0];
    if (!link) throw new Error("no comment link");

    fireEvent.click(link, { button: 0, ctrlKey: true });
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(link, { button: 0 });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("refetches when the card's timeline changes", async () => {
    const { fetch, client } = mount();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    for (const invalidation of invalidationsFor(
      { entity: "timeline", id: 1, action: "created", issue_number: 16 },
      SLUG,
    )) {
      applyInvalidation(client, invalidation);
    }
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });
});
