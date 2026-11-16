import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { Attachment } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachmentsQuery,
  deletedAttachmentsQuery,
} from "../src/api/attachments.ts";
import { api, meQuery, projectQuery } from "../src/api/queries.ts";
import { AttachmentList } from "../src/components/issue/attachment-list.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const person = (id: number, login: string) => ({
  id,
  login,
  display_name: login,
  kind: "human" as const,
  avatar_url: null,
  owner: null,
});

const file = (id: number, filename: string, body = "x"): Attachment => ({
  id,
  filename,
  content_type: "application/octet-stream",
  size: body.length,
  url: `/api/projects/b/attachments/${id}/download/${filename}`,
  uploader: person(1, "alice"),
  created_at: "2026-11-16T00:00:00Z",
  aliases: [],
});

function seeded(live: Attachment[], role = "writer") {
  const client = testQueryClient();
  client.setQueryData(attachmentsQuery("b", 7).queryKey, live);
  client.setQueryData(deletedAttachmentsQuery("b", 7).queryKey, []);
  client.setQueryData(meQuery.queryKey, { id: 1 } as never);
  client.setQueryData(projectQuery("b").queryKey, {
    viewer_role: role,
  } as never);
  return client;
}

/** Downloads go through anchors the page clicks; record where they point. */
function captureDownloads() {
  const clicked: { href: string; download: string }[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push({
      href: this.getAttribute("href") ?? "",
      download: this.download,
    });
  });
  return clicked;
}

function stubFetch(bodies: Record<string, string>) {
  const fetched: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      // The list query refetches through the same stub; only file reads count.
      if (/\/attachments\/\d+\//.test(url)) fetched.push(url);
      return new Response(bodies[url] ?? "", {
        status: url in bodies ? 200 : 404,
      });
    }),
  );
  return fetched;
}

describe("attachment multi-select (T-699)", () => {
  it("offers no selection for a single file", async () => {
    renderWithProviders(
      <AttachmentList slug="b" issueNumber={7} />,
      seeded([file(1, "only.txt")]),
    );
    await screen.findByText("only.txt");
    expect(screen.queryByLabelText("select all attachments")).toBeNull();
    expect(screen.queryByTestId("attachment-bulk-download")).toBeNull();
  });

  it("archives every file, fetched from /view, when nothing is selected", async () => {
    const blobs: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return "blob:bundle";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const clicked = captureDownloads();
    const fetched = stubFetch({
      "/api/projects/b/attachments/1/view/a.txt": "aa",
      "/api/projects/b/attachments/2/view/b.txt": "bbb",
    });
    renderWithProviders(
      <AttachmentList slug="b" issueNumber={7} />,
      seeded([file(1, "a.txt", "aa"), file(2, "b.txt", "bbb")]),
    );
    const button = await screen.findByTestId("attachment-bulk-download");
    expect(button.textContent).toBe("Download all");
    fireEvent.click(button);

    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(clicked[0]).toEqual({
      href: "blob:bundle",
      download: "b-7-attachments.tar",
    });
    expect(fetched).toEqual([
      "/api/projects/b/attachments/1/view/a.txt",
      "/api/projects/b/attachments/2/view/b.txt",
    ]);
    // Two entries of one header and one padded block each, then the end.
    expect(blobs[0].size).toBe(2 * 1024 + 1024);
  });

  it("downloads one selected file as itself, not as an archive", async () => {
    const clicked = captureDownloads();
    const fetched = stubFetch({});
    renderWithProviders(
      <AttachmentList slug="b" issueNumber={7} />,
      seeded([file(1, "a.txt"), file(2, "b.txt")]),
    );
    fireEvent.click(await screen.findByLabelText("select b.txt"));
    const button = screen.getByTestId("attachment-bulk-download");
    expect(button.textContent).toBe("Download 1");
    fireEvent.click(button);
    expect(clicked).toEqual([
      {
        href: "/api/projects/b/attachments/2/download/b.txt",
        download: "b.txt",
      },
    ]);
    expect(fetched).toEqual([]);
  });

  it("shift-click selects the run between two rows", async () => {
    renderWithProviders(
      <AttachmentList slug="b" issueNumber={7} />,
      seeded([file(1, "a"), file(2, "b"), file(3, "c"), file(4, "d")]),
    );
    fireEvent.click(await screen.findByLabelText("select a"));
    fireEvent.click(screen.getByLabelText("select c"), { shiftKey: true });
    const checked = (name: string) =>
      (screen.getByLabelText(`select ${name}`) as HTMLInputElement).checked;
    expect(["a", "b", "c", "d"].map(checked)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    const all = screen.getByLabelText(
      "select all attachments",
    ) as HTMLInputElement;
    expect(all.checked).toBe(false);
    expect(all.indeterminate).toBe(true);
  });

  it("deletes the selected files after one confirmation", async () => {
    vi.spyOn(api, "listAttachmentReferences").mockResolvedValue([]);
    const remove = vi.spyOn(api, "deleteAttachment").mockResolvedValue();
    renderWithProviders(
      <AttachmentList slug="b" issueNumber={7} />,
      seeded([file(1, "a"), file(2, "b"), file(3, "c")]),
    );
    fireEvent.click(await screen.findByLabelText("select a"));
    fireEvent.click(screen.getByLabelText("select c"));
    fireEvent.click(screen.getByTestId("attachment-bulk-delete"));
    expect(await screen.findByText("Delete 2 files?")).not.toBeNull();
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
    expect(remove.mock.calls).toEqual([
      ["b", 1],
      ["b", 3],
    ]);
  });

  it("names each linking place once, with the files it links", async () => {
    vi.spyOn(api, "listAttachmentReferences").mockImplementation(
      async (_slug, id) =>
        id === 3 ? [] : [{ issue_number: 7, issue_ref: "#7", comment_id: 41 }],
    );
    renderWithProviders(
      <AttachmentList slug="b" issueNumber={7} />,
      seeded([file(1, "a"), file(2, "b"), file(3, "c")]),
    );
    fireEvent.click(await screen.findByLabelText("select all attachments"));
    fireEvent.click(screen.getByTestId("attachment-bulk-delete"));
    const list = await screen.findByTestId("attachment-references");
    await waitFor(() => expect(list.textContent).toContain("a, b"));
    expect(list.querySelectorAll("li")).toHaveLength(1);
    expect(list.textContent).toContain("#comment-41");
  });

  it("will not delete a selection that holds someone else's file", async () => {
    renderWithProviders(
      <AttachmentList slug="b" issueNumber={7} />,
      seeded(
        [
          file(1, "mine"),
          { ...file(2, "theirs"), uploader: person(5, "carol") },
        ],
        "reporter",
      ),
    );
    fireEvent.click(await screen.findByLabelText("select mine"));
    expect(
      (screen.getByTestId("attachment-bulk-delete") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    fireEvent.click(screen.getByLabelText("select theirs"));
    expect(
      (screen.getByTestId("attachment-bulk-delete") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("offers no delete to a reader", async () => {
    renderWithProviders(
      <AttachmentList slug="b" issueNumber={7} />,
      seeded([file(1, "a"), file(2, "b")], "reader"),
    );
    fireEvent.click(await screen.findByLabelText("select a"));
    expect(screen.queryByTestId("attachment-bulk-delete")).toBeNull();
    expect(screen.getByTestId("attachment-bulk-download")).not.toBeNull();
  });
});
