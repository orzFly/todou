import { undo } from "@codemirror/commands";
import { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { Attachment, DeletedAttachment } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachmentsQuery,
  deletedAttachmentsQuery,
} from "../src/api/attachments.ts";
import { api, meQuery, projectQuery } from "../src/api/queries.ts";
import { canDeleteAttachment } from "../src/components/issue/attachment-delete.tsx";
import {
  AttachmentEventLink,
  AttachmentList,
} from "../src/components/issue/attachment-list.tsx";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";
import { mountStaging } from "./staging.tsx";

vi.mock("@pierre/diffs/react", () => ({
  CodeView: () => null,
  MultiFileDiff: () => null,
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const person = (id: number, login: string) => ({
  id,
  login,
  display_name: login,
  kind: "human" as const,
  avatar_url: null,
  owner: null,
});
const uploader = person(1, "alice");

const file = (id: number, filename: string): Attachment => ({
  id,
  filename,
  content_type: "image/png",
  size: 12,
  url: `/api/projects/b/attachments/${id}/download/${filename}`,
  uploader,
  created_at: "2026-10-24T00:00:00Z",
  aliases: [],
});

const gone = (id: number, filename: string): DeletedAttachment => ({
  id,
  filename,
  deleted_by: person(2, "bot-one"),
  deleted_at: "2026-10-24T01:00:00Z",
});

function seeded(
  live: Attachment[],
  deleted: DeletedAttachment[],
  viewer?: { id: number; role: string },
): QueryClient {
  const client = testQueryClient();
  client.setQueryData(attachmentsQuery("b", 7).queryKey, live);
  client.setQueryData(deletedAttachmentsQuery("b", 7).queryKey, deleted);
  if (viewer !== undefined) {
    client.setQueryData(meQuery.queryKey, { id: viewer.id } as never);
    client.setQueryData(projectQuery("b").queryKey, {
      viewer_role: viewer.role,
    } as never);
  }
  return client;
}

describe("who sees a delete button (T-567)", () => {
  it("mirrors the server: own at reporter, anyone's at writer", () => {
    expect(canDeleteAttachment("reporter", 1, 1)).toBe(true);
    expect(canDeleteAttachment("reporter", 2, 1)).toBe(false);
    expect(canDeleteAttachment("writer", 2, 1)).toBe(true);
    expect(canDeleteAttachment("admin", 2, 1)).toBe(true);
    expect(canDeleteAttachment("reader", 1, 1)).toBe(false);
    expect(canDeleteAttachment(null, 1, 1)).toBe(false);
  });

  it("puts one on the uploader's row and not on someone else's", async () => {
    const view = renderWithProviders(
      <AttachmentList slug="b" issueNumber={7} />,
      seeded(
        [
          file(3, "mine.png"),
          { ...file(4, "theirs.png"), uploader: person(5, "carol") },
        ],
        [],
        { id: 1, role: "reporter" },
      ),
    );
    await waitFor(() => {
      expect(view.container.textContent).toContain("theirs.png");
    });
    expect(screen.queryByLabelText("delete mine.png")).not.toBeNull();
    expect(screen.queryByLabelText("delete theirs.png")).toBeNull();
  });

  it("lists where the file is linked before deleting it", async () => {
    vi.spyOn(api, "listAttachmentReferences").mockResolvedValue([
      { issue_number: 7, issue_ref: "#7", comment_id: 41 },
      { issue_number: 9, issue_ref: "#9", comment_id: null },
    ]);
    const remove = vi.spyOn(api, "deleteAttachment").mockResolvedValue();
    renderWithProviders(
      <AttachmentList slug="b" issueNumber={7} />,
      seeded([file(3, "mine.png")], [], { id: 1, role: "reporter" }),
    );
    fireEvent.click(await screen.findByLabelText("delete mine.png"));

    const list = await screen.findByTestId("attachment-references");
    expect(list.textContent).toContain("#comment-41");
    expect(list.textContent).toContain("#9 description");
    expect(remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("b", 3));
  });
});

describe("a file deleted from this card (T-567)", () => {
  it("marks a body's image of it as deleted instead of a broken image", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="b" issueNumber={7}>
        {"![](/api/projects/b/attachments/9/download/shot.png)"}
      </MarkdownView>,
      seeded([], [gone(9, "shot.png")]),
    );
    const mark = await waitFor(() => {
      const el = view.container.querySelector("[data-attachment-deleted]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(mark.textContent).toContain("shot.png");
    expect(mark.textContent).toContain("deleted");
    expect(view.container.querySelector("img")).toBeNull();
  });

  it("leaves a link to a file that is still here alone", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="b" issueNumber={7}>
        {"![](/api/projects/b/attachments/3/download/live.png)"}
      </MarkdownView>,
      seeded([file(3, "live.png")], [gone(9, "shot.png")]),
    );
    await waitFor(() => {
      expect(view.container.querySelector("img")).not.toBeNull();
    });
    expect(
      view.container.querySelector("[data-attachment-deleted]"),
    ).toBeNull();
  });

  it("strikes the name out of the event that attached it", async () => {
    const view = renderWithProviders(
      <AttachmentEventLink
        slug="b"
        issueNumber={7}
        attachmentId={9}
        filename="shot.png"
      />,
      seeded([], [gone(9, "shot.png")]),
    );
    await waitFor(() => {
      expect(
        view.container.querySelector("[data-attachment-deleted]"),
      ).not.toBeNull();
    });
    expect(view.container.querySelector("a")).toBeNull();
  });
});

async function stagedAndUploaded() {
  const upload = vi
    .spyOn(api, "uploadAttachment")
    .mockResolvedValue(file(813, "shot.png"));
  const remove = vi.spyOn(api, "deleteAttachment").mockResolvedValue();
  const mounted = mountStaging();
  act(() => {
    mounted.hook().stage([new File(["bytes"], "shot.png")]);
  });
  await act(async () => {
    await mounted.hook().resolve(mounted.text(), "b", 7);
  });
  return { ...mounted, upload, remove };
}

describe("an editor's uploads are drafts until sent (T-568)", () => {
  it("uploads as a draft", async () => {
    const { upload } = await stagedAndUploaded();
    expect(upload).toHaveBeenCalledWith("b", 7, expect.any(File), {
      draft: true,
    });
  });

  it("deletes the draft when its file is taken out of the tray", async () => {
    const { hook, remove } = await stagedAndUploaded();
    const key = hook().staged[0]?.key as string;
    act(() => hook().remove(key));
    expect(remove).toHaveBeenCalledWith("b", 813);
  });

  it("deletes the drafts when the text is discarded", async () => {
    const { hook, remove } = await stagedAndUploaded();
    act(() => hook().discard());
    expect(remove).toHaveBeenCalledWith("b", 813);
  });

  it("deletes the drafts when the editor goes away unsent", async () => {
    const { unmount, remove } = await stagedAndUploaded();
    unmount();
    expect(remove).toHaveBeenCalledWith("b", 813);
  });

  it("keeps the files of a text that was sent, even if the editor unmounts at once", async () => {
    const { hook, unmount, remove } = await stagedAndUploaded();
    act(() => hook().clear());
    unmount();
    expect(remove).not.toHaveBeenCalled();
  });

  it("deletes the draft of a file whose token went before the next send", async () => {
    const { hook, cm, text, remove } = await stagedAndUploaded();
    act(() => {
      cm().dispatch({
        changes: { from: 0, to: text().length, insert: "no file" },
      });
    });
    let sent = "";
    await act(async () => {
      sent = await hook().resolve(text(), "b", 7);
    });
    expect(sent).toBe("no file");
    expect(remove).toHaveBeenCalledWith("b", 813);
  });

  it("uploads again a file whose draft a send deleted, once undo brings it back", async () => {
    const { hook, cm, text, upload } = await stagedAndUploaded();
    const token = text();
    act(() => {
      cm().dispatch({ changes: { from: 0, to: token.length, insert: "x" } });
    });
    const invalidate = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    await act(async () => {
      await hook().resolve(text(), "b", 7);
    });
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["attachments", "b", 7],
      }),
    );
    act(() => {
      undo(cm());
    });
    expect(text()).toBe(token);
    upload.mockResolvedValue(file(814, "shot.png"));
    let sent = "";
    await act(async () => {
      sent = await hook().resolve(text(), "b", 7);
    });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(sent).toBe(`![shot.png](${file(814, "shot.png").url})`);
  });

  it("uploads again a file that undo brought back after × deleted its draft", async () => {
    const { hook, cm, text, upload, remove } = await stagedAndUploaded();
    const key = hook().staged[0]?.key as string;
    act(() => hook().remove(key));
    expect(remove).toHaveBeenCalledWith("b", 813);
    act(() => {
      undo(cm());
    });
    upload.mockResolvedValue(file(814, "shot.png"));
    let sent = "";
    await act(async () => {
      sent = await hook().resolve(text(), "b", 7);
    });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(sent).toBe(`![shot.png](${file(814, "shot.png").url})`);
  });
});
