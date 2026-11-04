import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { Attachment, CommentCreateResult, Me } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  labelsQuery,
  membersQuery,
  meQuery,
  statusesQuery,
} from "../src/api/queries.ts";
import {
  Composer,
  useCommentComposer,
} from "../src/components/timeline/composer.tsx";
import { cmFocus, cmPasteFiles, cmSetValue, cmView } from "./cm.ts";
import { testQueryClient } from "./render.tsx";

afterEach(() => {
  vi.restoreAllMocks();
});

const ME: Me = {
  id: 100,
  login: "alice",
  display_name: "Alice",
  kind: "human",
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: false,
  created_at: "2026-01-01T00:00:00.000Z",
};

const SHOT: Attachment = {
  id: 5,
  filename: "shot.png",
  content_type: "image/png",
  size: 3,
  url: "/api/projects/todou/attachments/5/download/shot.png",
  uploader: ME,
  created_at: "2026-01-01T00:00:00.000Z",
  aliases: [],
};

/** The composer as the card page wires it: sends go through the real hook. */
function Page() {
  const composer = useCommentComposer("todou", 7, ME);
  return (
    <Composer
      slug="todou"
      issueNumber={7}
      onSend={composer.send}
      onSendWithCommands={composer.sendWithCommands}
      failed={[]}
      onRetry={composer.retry}
    />
  );
}

describe("a file pasted into a comment", () => {
  it("is sent linked where it was pasted", async () => {
    vi.spyOn(api, "uploadAttachment").mockResolvedValue(SHOT);
    const createComment = vi
      .spyOn(api, "createComment")
      .mockResolvedValue({} as CommentCreateResult);
    const client = testQueryClient();
    client.setQueryData(statusesQuery("todou").queryKey, []);
    client.setQueryData(labelsQuery("todou").queryKey, []);
    client.setQueryData(membersQuery("todou").queryKey, []);
    client.setQueryData(meQuery.queryKey, ME);
    const view = render(
      <QueryClientProvider client={client}>
        <Page />
      </QueryClientProvider>,
    );

    cmFocus(view.container);
    cmSetValue(view.container, "first paragraph\n\nsecond paragraph");
    act(() => {
      cmView(view.container).dispatch({
        selection: { anchor: "first paragraph".length },
      });
    });
    cmPasteFiles(view.container, [
      new File(["png"], "shot.png", { type: "image/png" }),
    ]);
    const submit = view.container.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    if (submit === null) throw new Error("no submit button");
    fireEvent.click(submit);

    await waitFor(() => expect(createComment).toHaveBeenCalledOnce());
    expect(createComment).toHaveBeenCalledWith(
      "todou",
      7,
      `first paragraph ![shot.png](${SHOT.url}) \n\nsecond paragraph`,
    );
  });
});
