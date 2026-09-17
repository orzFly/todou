import type { QueryClient } from "@tanstack/react-query";
import { fireEvent, waitFor, within } from "@testing-library/react";
import type { Attachment } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { attachmentsQuery } from "../src/api/attachments.ts";
import { AttachmentList } from "../src/components/issue/attachment-list.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

/**
 * The folded attachment section (T-369): a long list shows its newest five
 * and hides the head behind one toggle. The list itself stays ascending —
 * the fold moves, not the order — so the numbers below are about which end
 * of the array survives.
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
  // Ascending, one minute apart, matching the order the server now promises.
  created_at: `2026-09-01T00:0${n}:00Z`,
  aliases: [],
});

function seeded(count: number, issueNumber = 7): QueryClient {
  const client = testQueryClient();
  client.setQueryData(
    attachmentsQuery("demo", issueNumber).queryKey,
    Array.from({ length: count }, (_, i) => attachment(i + 1)),
  );
  return client;
}

const filenames = (container: HTMLElement) =>
  [...container.querySelectorAll("li")].map(
    (li) => li.querySelector("span")?.textContent,
  );

describe("the attachment section folds a long list", () => {
  it("keeps the newest five and hides the head behind a toggle", async () => {
    const view = renderWithProviders(
      <AttachmentList slug="demo" issueNumber={7} />,
      seeded(8),
    );
    await waitFor(() =>
      expect(view.container.querySelectorAll("li")).toHaveLength(5),
    );
    // The tail, in the list's own order — not the head, and not reversed.
    expect(filenames(view.container)).toEqual([
      "shot-4.png",
      "shot-5.png",
      "shot-6.png",
      "shot-7.png",
      "shot-8.png",
    ]);

    // Above the list, where it reads as a continuation of the header rather
    // than as a ninth row.
    const toggle = view.getByTestId("attachment-fold-toggle");
    const list = view.container.querySelector("ul") as HTMLUListElement;
    expect(
      toggle.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(toggle.textContent).toContain("展开其余 3 个");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("expands in place and folds back", async () => {
    const view = renderWithProviders(
      <AttachmentList slug="demo" issueNumber={7} />,
      seeded(8),
    );
    const toggle = await view.findByTestId("attachment-fold-toggle");

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(view.container.querySelectorAll("li")).toHaveLength(8),
    );
    expect(filenames(view.container)[0]).toBe("shot-1.png");
    expect(toggle.textContent).toContain("收起");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(view.container.querySelectorAll("li")).toHaveLength(5),
    );
    expect(toggle.textContent).toContain("展开其余 3 个");
  });

  it("leaves seven files alone — folding them would save nothing", async () => {
    const view = renderWithProviders(
      <AttachmentList slug="demo" issueNumber={7} />,
      seeded(7),
    );
    await waitFor(() =>
      expect(view.container.querySelectorAll("li")).toHaveLength(7),
    );
    expect(view.queryByTestId("attachment-fold-toggle")).toBeNull();
  });

  it("opens the viewer on the file that was clicked, not on its row number", async () => {
    const view = renderWithProviders(
      <AttachmentList slug="demo" issueNumber={7} />,
      seeded(8),
    );
    const firstRow = await waitFor(() => {
      const el = view.container.querySelector("li a") as HTMLAnchorElement;
      expect(el).not.toBeNull();
      return el;
    });
    // Folded, the first row is the list's fourth file. A viewer paging from
    // index 0 would open shot-1.png, which is not even on screen.
    fireEvent.click(firstRow);
    const dialog = await view.findByRole("dialog");
    expect(within(dialog).getByText("shot-4.png")).toBeTruthy();
  });

  it("prints each file's upload time", async () => {
    const view = renderWithProviders(
      <AttachmentList slug="demo" issueNumber={7} />,
      seeded(3),
    );
    const row = await waitFor(() => {
      const el = view.container.querySelector("li");
      expect(el).not.toBeNull();
      return el as HTMLLIElement;
    });
    const stamp = row.querySelector("span[title]") as HTMLSpanElement;
    expect(stamp.getAttribute("title")).toBe("2026-09-01T00:01:00Z");
    expect(stamp.textContent).toBe(
      new Date("2026-09-01T00:01:00Z").toLocaleString(),
    );
  });
});
