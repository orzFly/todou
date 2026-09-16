import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { Attachment } from "@todou/shared";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachmentsQuery } from "../src/api/attachments.ts";
import { AttachmentDocumentEmbed } from "../src/components/issue/attachment-embed.tsx";
import { AttachmentViewerDialog } from "../src/components/issue/attachment-viewer.tsx";

/** The failure branches of the two attachment text surfaces: the inline
 * embed (T-376) and the viewer dialog's text pane. Neither had any failure
 * case before — attachment-refs-stored.test.tsx always seeds the text
 * query, so the error path was unobservable. */

vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({ items }: { items: Array<{ file: { contents: string } }> }) => (
    <pre>
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
const doc: Attachment = {
  id: 1,
  filename: "notes.txt",
  content_type: "text/plain",
  size: 26,
  url: "/api/projects/a/attachments/1/download/notes.txt",
  uploader,
  created_at: "2026-01-01T00:00:00.000Z",
  aliases: [],
};

const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

function mount(ui: ReactElement, queries: QueryClient) {
  queries.setQueryData(attachmentsQuery("a", 7).queryKey, [doc]);
  return render(
    <QueryClientProvider client={queries}>{ui}</QueryClientProvider>,
  );
}

/** One fetch stub shared by both suites: the first GET 500s, later ones
 * return `text`. Each test owns its `failed` flag so Retry's second call
 * succeeds. `gets` counts requests so the refetch itself is observable. */
const textFetch = (text: string) => {
  const gets: string[] = [];
  let failed = true;
  vi.stubGlobal("fetch", async (input: unknown) => {
    gets.push(String(input));
    if (failed) {
      return Response.json({ error: "text unavailable" }, { status: 500 });
    }
    return Response.json(text);
  });
  return {
    gets,
    succeed() {
      failed = false;
    },
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the embedded document when its text fails to load (T-376)", () => {
  it("retries the text query alone and renders the document", async () => {
    const { gets, succeed } = textFetch("hello from notes.txt\n");
    const view = mount(
      <AttachmentDocumentEmbed
        slug="a"
        issueNumber={7}
        attachmentId={1}
        href={doc.url}
        fallbackName="notes.txt"
      />,
      client(),
    );

    expect(await view.findByText(/Failed to load: /)).toBeTruthy();
    expect(view.container.textContent).not.toContain("hello from notes.txt");
    succeed();
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(view.container.textContent).toContain("hello from notes.txt"),
    );
    expect(gets.filter((u) => u.includes("/download/")).length).toBe(2);
  });
});

describe("the attachment viewer's text pane when loading fails (T-376)", () => {
  it("retries and shows the document", async () => {
    const { gets, succeed } = textFetch("viewer text\n");
    const view = mount(
      <AttachmentViewerDialog
        state={{
          items: [
            {
              filename: "notes.txt",
              url: doc.url,
              content_type: "text/plain",
              size: 26,
            },
          ],
          index: 0,
        }}
        onNavigate={() => {}}
        onClose={() => {}}
        slug="a"
        issueNumber={7}
      />,
      client(),
    );

    expect(await view.findByText(/Failed to load notes.txt: /)).toBeTruthy();
    succeed();
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(document.body.textContent).toContain("viewer text"),
    );
    expect(gets.filter((u) => u.includes("/download/")).length).toBe(2);
  });
});
