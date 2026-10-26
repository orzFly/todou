import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Attachment } from "@todou/shared";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachmentsQuery } from "../src/api/attachments.ts";
import { AttachmentDocumentEmbed } from "../src/components/issue/attachment-embed.tsx";
import { AttachmentViewerDialog } from "../src/components/issue/attachment-viewer.tsx";
import {
  TEXT_PREVIEW_HARD_MAX_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
} from "../src/lib/attachment-preview.ts";

/** Text attachments past the preview size (T-582): asked for, then plain. */

vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({
    items,
  }: {
    items: Array<{ file: { contents: string; lang?: string } }>;
  }) => (
    <pre data-lang={items[0]?.file.lang ?? ""}>
      <code>{items.map((item) => item.file.contents).join("\n")}</code>
    </pre>
  ),
  MultiFileDiff: () => null,
}));

const uploader = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const file = (id: number, filename: string, type: string, size: number) =>
  ({
    id,
    filename,
    content_type: type,
    size,
    url: `/api/projects/a/attachments/${id}/download/${filename}`,
    uploader,
    created_at: "2026-01-01T00:00:00.000Z",
    aliases: [],
  }) satisfies Attachment;

const ASK = TEXT_PREVIEW_MAX_BYTES + 1;
const REFUSE = TEXT_PREVIEW_HARD_MAX_BYTES + 1;

/** Download GETs answer with text; anything else (a list refetch) is out
 * of scope and gets an empty list. Returns the downloads requested. */
function stubText(attachments: Attachment[] = []) {
  const gets: string[] = [];
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input);
    if (!url.includes("/download/")) return Response.json(attachments);
    gets.push(url);
    return Response.json(`text of ${url.split("/").pop()}\n`);
  });
  return gets;
}

function mount(ui: ReactElement, attachments: Attachment[] = []) {
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queries.setQueryData(attachmentsQuery("a", 7).queryKey, attachments);
  return render(
    <QueryClientProvider client={queries}>{ui}</QueryClientProvider>,
  );
}

function viewer(items: Attachment[], onNavigate = () => {}, index = 0) {
  return (
    <AttachmentViewerDialog
      state={{ items, index }}
      onNavigate={onNavigate}
      onClose={() => {}}
      slug="a"
      issueNumber={7}
    />
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the attachment viewer past the preview size", () => {
  it("fetches nothing until asked, then shows plain text", async () => {
    const gets = stubText();
    mount(viewer([file(1, "app.log", "text/plain", ASK)]));
    const ask = screen.getByRole("button", { name: "Preview anyway" });
    expect(gets).toEqual([]);
    fireEvent.click(ask);
    await waitFor(() =>
      expect(document.body.textContent).toContain("text of app.log"),
    );
    await waitFor(() =>
      expect(
        document.querySelector("pre[data-lang]")?.getAttribute("data-lang"),
      ).toBe("text"),
    );
  });

  it("says why past the hard limit, and offers nothing to load", () => {
    const gets = stubText();
    mount(viewer([file(1, "app.log", "text/plain", REFUSE)]));
    expect(screen.getByText("This file is too large to preview.")).toBeTruthy();
    expect(screen.getByText("Previews stop at 10 MB.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Preview anyway" })).toBeNull();
    // The way out stays in the footer.
    expect(screen.getByRole("link", { name: "Download" })).toBeTruthy();
    expect(gets).toEqual([]);
  });

  it("loads a patch past the preview size without asking", async () => {
    stubText();
    mount(viewer([file(1, "big.patch", "text/x-patch", ASK)]));
    expect(screen.queryByRole("button", { name: "Preview anyway" })).toBeNull();
    await waitFor(() =>
      expect(document.body.textContent).toContain("text of big.patch"),
    );
  });

  it("asks again for the next file when paging on", () => {
    stubText();
    const items = [
      file(1, "a.log", "text/plain", ASK),
      file(2, "b.log", "text/plain", ASK),
    ];
    const view = mount(viewer(items));
    fireEvent.click(screen.getByRole("button", { name: "Preview anyway" }));
    expect(screen.queryByRole("button", { name: "Preview anyway" })).toBeNull();
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        {viewer(items, () => {}, 1)}
      </QueryClientProvider>,
    );
    expect(screen.getByRole("button", { name: "Preview anyway" })).toBeTruthy();
  });
});

describe("the embedded document past the preview size", () => {
  const embed = (id: number, name: string) => (
    <AttachmentDocumentEmbed
      slug="a"
      issueNumber={7}
      attachmentId={id}
      href={`/download/${name}`}
      fallbackName={name}
    />
  );

  it("waits to be asked, then shows plain text", async () => {
    const log = file(1, "app.log", "text/plain", ASK);
    const gets = stubText([log]);
    mount(embed(1, "app.log"), [log]);
    fireEvent.click(screen.getByRole("button", { name: "Preview anyway" }));
    await waitFor(() =>
      expect(document.body.textContent).toContain("text of app.log"),
    );
    expect(gets).toHaveLength(1);
  });

  it("stays a card with a reason past the hard limit", () => {
    const log = file(1, "app.log", "text/plain", REFUSE);
    const gets = stubText([log]);
    mount(embed(1, "app.log"), [log]);
    expect(screen.getByText("This file is too large to preview.")).toBeTruthy();
    expect(gets).toEqual([]);
  });

  it("does not call a file that is not text too large", () => {
    const pdf = file(1, "notes.md", "application/pdf", 10);
    stubText([pdf]);
    mount(embed(1, "notes.md"), [pdf]);
    expect(
      screen.getByText("No inline preview for this file type."),
    ).toBeTruthy();
  });
});
