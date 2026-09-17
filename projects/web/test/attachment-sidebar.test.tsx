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
    const jump = within(section).getByText("全部 8 个 ↓");
    expect(jump.tagName).toBe("A");
    expect(jump.getAttribute("href")).toBe("#attachments");
    // The target exists and is the body list, not this section.
    const target = view.container.querySelector("#attachments");
    expect(target).not.toBeNull();
    expect(target?.contains(section)).toBe(false);
    expect(target?.querySelectorAll("li")).toHaveLength(5);
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
