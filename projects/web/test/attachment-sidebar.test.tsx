import type { QueryClient } from "@tanstack/react-query";
import { waitFor, within } from "@testing-library/react";
import type { Attachment } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { attachmentsQuery } from "../src/api/attachments.ts";
import {
  AttachmentList,
  AttachmentSidebarSection,
} from "../src/components/issue/attachment-list.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

/**
 * The sidebar attachment section (T-369): the newest four files, and a way
 * down to the full list in the body.
 */

const uploader = {
  id: 1,
  login: "bot-one",
  display_name: "bot-one",
  kind: "machine" as const,
  avatar_url: null,
  owner: null,
};

const attachment = (n: number): Attachment => ({
  id: n,
  filename: `shot-${n}.png`,
  content_type: "image/png",
  size: 512,
  url: `/api/projects/demo/attachments/${n}/download/shot-${n}.png`,
  uploader,
  created_at: `2026-09-01T00:0${n}:00Z`,
  aliases: [],
});

function seeded(count: number): QueryClient {
  const client = testQueryClient();
  client.setQueryData(
    attachmentsQuery("demo", 7).queryKey,
    Array.from({ length: count }, (_, i) => attachment(i + 1)),
  );
  return client;
}

describe("the sidebar attachment section", () => {
  it("shows the newest four, in the list's own order", async () => {
    const view = renderWithProviders(
      <AttachmentSidebarSection slug="demo" issueNumber={7} />,
      seeded(8),
    );
    const section = await view.findByTestId("attachment-sidebar");
    await waitFor(() => expect(section.querySelectorAll("li")).toHaveLength(4));
    expect(
      [...section.querySelectorAll("li")].map((li) => li.textContent),
    ).toEqual(["shot-5.png", "shot-6.png", "shot-7.png", "shot-8.png"]);
    // The heading still says how many there are in total.
    expect(within(section).getByText("8")).toBeTruthy();
  });

  it("lands its jump on the body section, as a real link", async () => {
    const view = renderWithProviders(
      <>
        <AttachmentSidebarSection slug="demo" issueNumber={7} />
        <AttachmentList slug="demo" issueNumber={7} />
      </>,
      seeded(8),
    );
    const section = await view.findByTestId("attachment-sidebar");
    const jump = within(section).getByText("All 8 ↓");
    expect(jump.tagName).toBe("A");
    expect(jump.getAttribute("href")).toBe("#attachments");
    // The target exists and is the body list, not this section.
    const target = view.container.querySelector("#attachments");
    expect(target).not.toBeNull();
    expect(target?.contains(section)).toBe(false);
    expect(target?.querySelectorAll("li")).toHaveLength(5);
  });

  // Both halves are needed: with only the first, deleting the row outright
  // would pass; with only the second, drawing it always would.
  it("drops the jump row once it has listed every file", async () => {
    const view = renderWithProviders(
      <AttachmentSidebarSection slug="demo" issueNumber={7} />,
      seeded(4),
    );
    const section = await view.findByTestId("attachment-sidebar");
    await waitFor(() => expect(section.querySelectorAll("li")).toHaveLength(4));
    expect(within(section).queryByText(/^All \d+/)).toBeNull();
  });

  it("keeps the jump row while files are missing from it", async () => {
    // Five is the case the body panel's own fold does not cover: it stays
    // unfolded until eight, while the sidebar has already dropped one.
    const view = renderWithProviders(
      <AttachmentSidebarSection slug="demo" issueNumber={7} />,
      seeded(5),
    );
    const section = await view.findByTestId("attachment-sidebar");
    await waitFor(() => expect(section.querySelectorAll("li")).toHaveLength(4));
    expect(within(section).getByText(/^All \d+/)).toBeTruthy();
  });

  it("makes the heading itself the way down to the body list", async () => {
    const view = renderWithProviders(
      <AttachmentSidebarSection slug="demo" issueNumber={7} />,
      seeded(4),
    );
    const section = await view.findByTestId("attachment-sidebar");
    const heading = section.querySelector("h3") as HTMLElement;
    const link = within(heading).getByRole("link");
    expect(link.getAttribute("href")).toBe("#attachments");
    // The count is inside the link, not stranded beside it.
    expect(link.textContent).toContain("4");
  });

  it("renders nothing when the card has no files", async () => {
    const view = renderWithProviders(
      <AttachmentSidebarSection slug="demo" issueNumber={7} />,
      seeded(0),
    );
    await waitFor(() =>
      expect(view.queryByTestId("attachment-sidebar")).toBeNull(),
    );
  });

  it("opens the viewer on the file the row names", async () => {
    const view = renderWithProviders(
      <AttachmentSidebarSection slug="demo" issueNumber={7} />,
      seeded(8),
    );
    const section = await view.findByTestId("attachment-sidebar");
    const firstRow = section.querySelector("li a") as HTMLAnchorElement;
    firstRow.click();
    const dialog = await view.findByRole("dialog");
    // Fifth of eight, not first of four — the viewer pages the whole list.
    expect(within(dialog).getByText("shot-5.png")).toBeTruthy();
  });
});
