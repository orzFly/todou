import type { QueryClient } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import type { Attachment } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { attachmentsQuery } from "../src/api/attachments.ts";
import {
  AttachmentEventLink,
  AttachmentList,
  AttachmentRichLink,
} from "../src/components/issue/attachment-list.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

/**
 * Where the three attachment anchors point (T-201): viewable types at /view
 * so a middle-click shows the file, everything else at /download.
 */

const uploader = {
  id: 1,
  login: "bot-one",
  display_name: "bot-one",
  kind: "machine" as const,
  avatar_url: null,
  owner: null,
};

const attachment = (
  id: number,
  filename: string,
  content_type: string,
): Attachment => ({
  id,
  filename,
  content_type,
  size: 512,
  url: `/api/projects/demo/attachments/${id}/download/${filename}`,
  uploader,
  created_at: "2026-09-01T00:00:00Z",
  aliases: [],
});

const ITEMS = [
  attachment(1, "demo.html", "text/html"),
  attachment(2, "archive.zip", "application/zip"),
];

function seeded(): QueryClient {
  const client = testQueryClient();
  client.setQueryData(attachmentsQuery("demo", 7).queryKey, ITEMS);
  return client;
}

const hrefs = (container: HTMLElement) =>
  [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));

describe("attachment list rows", () => {
  it("points a viewable row at /view and keeps a download action beside it", async () => {
    const view = renderWithProviders(
      <AttachmentList slug="demo" issueNumber={7} />,
      seeded(),
    );
    const row = await waitFor(() => {
      const el = view.container.querySelector("li");
      expect(el).not.toBeNull();
      return el as HTMLLIElement;
    });
    expect(hrefs(row)).toEqual([
      "/api/projects/demo/attachments/1/view/demo.html",
      "/api/projects/demo/attachments/1/download/demo.html",
    ]);
    const download = row.querySelector("a[download]");
    expect(download?.getAttribute("download")).toBe("demo.html");
    expect(download?.getAttribute("aria-label")).toBe("download demo.html");
  });

  it("leaves a non-viewable row on /download", async () => {
    const view = renderWithProviders(
      <AttachmentList slug="demo" issueNumber={7} />,
      seeded(),
    );
    const row = await waitFor(() => {
      const rows = view.container.querySelectorAll("li");
      expect(rows).toHaveLength(2);
      return rows[1] as HTMLLIElement;
    });
    expect(hrefs(row)).toEqual([
      "/api/projects/demo/attachments/2/download/archive.zip",
      "/api/projects/demo/attachments/2/download/archive.zip",
    ]);
  });
});

describe("timeline attached-event link", () => {
  it("resolves the type from the attachments query and points at /view", async () => {
    const view = renderWithProviders(
      <AttachmentEventLink
        slug="demo"
        issueNumber={7}
        attachmentId={1}
        filename="demo.html"
      />,
      seeded(),
    );
    await waitFor(() => {
      expect(hrefs(view.container)).toEqual([
        "/api/projects/demo/attachments/1/view/demo.html",
      ]);
    });
  });

  it("falls back to the download URL for an unresolvable id", async () => {
    // Nothing seeded: the query 404s offline, so the event payload is all
    // there is — and it says nothing about the content type.
    const view = renderWithProviders(
      <AttachmentEventLink
        slug="demo"
        issueNumber={7}
        attachmentId={9}
        filename="gone.html"
      />,
    );
    await waitFor(() => {
      expect(hrefs(view.container)).toEqual([
        "/api/projects/demo/attachments/9/download/gone.html",
      ]);
    });
  });
});

describe("markdown rich link", () => {
  it("upgrades a /download literal in old comment bodies to /view", async () => {
    const view = renderWithProviders(
      <AttachmentRichLink
        slug="demo"
        issueNumber={7}
        attachmentId={1}
        href="/api/projects/demo/attachments/1/download/demo.html"
        fallbackName="demo.html"
      />,
      seeded(),
    );
    await waitFor(() => {
      expect(hrefs(view.container)).toEqual([
        "/api/projects/demo/attachments/1/view/demo.html",
      ]);
    });
  });

  it("keeps the markdown literal while the type is unknown", async () => {
    const view = renderWithProviders(
      <AttachmentRichLink
        slug="demo"
        issueNumber={7}
        attachmentId={1}
        href="/api/projects/demo/attachments/1/download/demo.html"
        fallbackName="demo.html"
      />,
    );
    await waitFor(() => {
      expect(hrefs(view.container)).toEqual([
        "/api/projects/demo/attachments/1/download/demo.html",
      ]);
    });
  });
});
