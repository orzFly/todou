import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  act,
  fireEvent,
  type RenderResult,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  Attachment,
  CommentCreateResult,
  Issue,
  Me,
  TimelineComment,
} from "@todou/shared";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { CommentItem } from "../src/components/timeline/comment-item.tsx";
import {
  Composer,
  useCommentComposer,
} from "../src/components/timeline/composer.tsx";
import { BodyBlock } from "../src/pages/issue-detail.tsx";
import { cmPressKey, cmSetValue, cmView } from "./cm.ts";
import { renderWithProviders } from "./render.tsx";

const me: Me = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human",
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: false,
  created_at: "2026-01-01T00:00:00Z",
};

const SLUG = "p";

const shot = () => new File(["bytes"], "shot.png", { type: "image/png" });

const uploaded = (): Attachment => ({
  id: 11,
  filename: "shot.png",
  content_type: "image/png",
  size: 5,
  url: "/x/shot.png",
  uploader: {
    id: me.id,
    login: me.login,
    display_name: me.display_name,
    kind: me.kind,
    avatar_url: null,
    owner: null,
  },
  created_at: "2026-01-01T00:00:00Z",
  aliases: [],
});

/**
 * A promise the test releases by hand, so the window inside an `await` stays
 * open while the page moves underneath it — which is what a real reader does
 * by dismissing the guard's dialog.
 */
function held<T>() {
  let release: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * [A writer's note] The event loop has to run between the press and the jump,
 * because the guard's dialog is its own task. Dropping the rerender into the
 * microtask right after `mutate()` passes for a reason a browser never has.
 */
async function letTheLoopRun() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Mutations retry by default; a held write must not be sent twice. */
function queryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

afterEach(() => {
  // The manager is module-global: leaving it offline hangs every later file.
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
});

describe("a comment aimed at a card the page then left", () => {
  it("resumes a paused send onto the card it was written on", async () => {
    const createComment = vi
      .spyOn(api, "createComment")
      .mockResolvedValue({} as CommentCreateResult);
    onlineManager.setOnline(false);
    const hook = renderHook(
      ({ issueNumber }: { issueNumber: number }) =>
        useCommentComposer(SLUG, issueNumber, me),
      { initialProps: { issueNumber: 7 }, wrapper: wrapperFor(queryClient()) },
    );

    act(() =>
      hook.result.current.send("written on card 7", {
        slug: SLUG,
        issueNumber: 7,
      }),
    );
    await letTheLoopRun();
    // Offline: the retryer pauses before `mutationFn` is ever called, which is
    // the whole window — the callback is read when the send resumes.
    expect(createComment).not.toHaveBeenCalled();

    hook.rerender({ issueNumber: 8 });
    act(() => onlineManager.setOnline(true));

    await waitFor(() => expect(createComment).toHaveBeenCalled());
    expect(createComment.mock.calls[0]?.[1]).toBe(7);
  });

  it("invalidates the timeline of the card the request reached", async () => {
    const write = held<CommentCreateResult>();
    const createComment = vi
      .spyOn(api, "createComment")
      .mockReturnValue(write.promise);
    const client = queryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const hook = renderHook(
      ({ issueNumber }: { issueNumber: number }) =>
        useCommentComposer(SLUG, issueNumber, me),
      { initialProps: { issueNumber: 7 }, wrapper: wrapperFor(client) },
    );

    act(() =>
      hook.result.current.send("written on card 7", {
        slug: SLUG,
        issueNumber: 7,
      }),
    );
    await letTheLoopRun();
    expect(createComment.mock.calls[0]?.[1]).toBe(7);

    hook.rerender({ issueNumber: 8 });
    write.release({} as CommentCreateResult);

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["timeline", SLUG, 7],
      }),
    );
  });
});

/** The page as `issue-detail.tsx` builds it: the hook above a keyed composer. */
function Page() {
  const [issueNumber, setIssueNumber] = useState(7);
  const composer = useCommentComposer(SLUG, issueNumber, me);
  return (
    <>
      <button type="button" onClick={() => setIssueNumber(8)}>
        the next card
      </button>
      <Composer
        key={issueNumber}
        slug={SLUG}
        issueNumber={issueNumber}
        onSend={composer.send}
        onSendWithCommands={composer.sendWithCommands}
        failed={[]}
        onRetry={composer.retry}
      />
    </>
  );
}

const dropBox = (container: HTMLElement) =>
  fireEvent.drop(cmView(container).contentDOM, {
    dataTransfer: {
      files: [shot()],
      types: [],
      items: [],
      getData: () => "",
    } as unknown as DataTransfer,
  });

describe("a staged upload aimed at a card the page then left", () => {
  it("lands the attachment and the comment it rides on on the same card", async () => {
    const attachment = held<Attachment>();
    const uploadAttachment = vi
      .spyOn(api, "uploadAttachment")
      .mockReturnValue(attachment.promise);
    const createComment = vi
      .spyOn(api, "createComment")
      .mockResolvedValue({} as CommentCreateResult);
    const view = render(
      <QueryClientProvider client={queryClient()}>
        <Page />
      </QueryClientProvider>,
    );

    dropBox(view.container);
    cmSetValue(view.container, "a reply for card 7");
    await waitFor(() => expect(uploadAttachment).not.toHaveBeenCalled());

    const submit = view.container.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    if (submit === null) throw new Error("no submit button");
    fireEvent.click(submit);

    // The upload is what holds the submission open: the composer unmounts
    // here, but the closure inside its own `submit()` keeps running.
    await waitFor(() => expect(uploadAttachment).toHaveBeenCalled());
    fireEvent.click(view.getByText("the next card"));
    attachment.release(uploaded());

    await waitFor(() => expect(createComment).toHaveBeenCalled());
    expect(uploadAttachment.mock.calls[0]?.[1]).toBe(7);
    expect(createComment.mock.calls[0]?.[1]).toBe(7);
    // And the comment names the attachment that went to card 7.
    expect(createComment.mock.calls[0]?.[2]).toContain("/x/shot.png");
  });
});

const issue = (number: number, body: string): Issue => ({
  id: 1,
  number,
  title: `Card ${number}`,
  body,
  status: {
    id: 1,
    name: "Todo",
    category: "open",
    color: "#6b7280",
    position: 0,
    is_default: true,
  },
  author: {
    id: 9,
    login: "alice",
    display_name: "Alice",
    kind: "human",
    avatar_url: null,
    owner: null,
  },
  assignees: [],
  labels: [],
  created_at: "2026-09-08T09:00:00Z",
  updated_at: "2026-09-08T09:00:00Z",
  body_edited_at: null,
  open_questions: 0,
  spec_version: null,
  spec_review_status: null,
  spec_unresolved_comments: 0,
  deleted_at: null,
  deleted_by: null,
  unread: false,
  unread_comments: 0,
  moves: [],
});

/** The page's history of card numbers is the card number itself. */
function BodyPage() {
  const [n, setN] = useState(7);
  return (
    <>
      <button type="button" onClick={() => setN(8)}>
        the next card
      </button>
      <BodyBlock
        slug={SLUG}
        issue={n === 7 ? issue(7, "card 7 body") : issue(8, "card 8 body")}
      />
    </>
  );
}

describe("a body edit aimed at a card the page then left", () => {
  it("saves onto the card the editor was opened on", async () => {
    const attachment = held<Attachment>();
    const uploadAttachment = vi
      .spyOn(api, "uploadAttachment")
      .mockReturnValue(attachment.promise);
    const updateIssue = vi
      .spyOn(api, "updateIssue")
      .mockResolvedValue(issue(7, "rewritten"));
    const view = renderWithProviders(<BodyPage />);

    fireEvent.click(await view.findByLabelText("edit body"));
    await waitFor(() => expect(cmView(view.container)).toBeDefined());
    cmSetValue(view.container, "card 7, rewritten");
    dropBox(view.container);
    cmPressKey(view.container, "Enter", { ctrlKey: true });

    await waitFor(() => expect(uploadAttachment).toHaveBeenCalled());
    fireEvent.click(view.getByText("the next card"));
    attachment.release(uploaded());

    await waitFor(() => expect(updateIssue).toHaveBeenCalled());
    expect(uploadAttachment.mock.calls[0]?.[1]).toBe(7);
    expect(updateIssue.mock.calls[0]?.[1]).toBe(7);
  });
});

/**
 * The row's own worth, below the page: `Timeline` is keyed by card, so a real
 * page no longer re-points a mounted row — these render `CommentItem` directly
 * and change its props, which is what the sealing has to survive on its own.
 * That is the half that holds if the key is ever lost.
 */
const comment = (id: number, body: string): TimelineComment => ({
  type: "comment",
  id,
  author: {
    id: me.id,
    login: me.login,
    display_name: me.display_name,
    kind: "human",
    avatar_url: null,
    owner: null,
  },
  body,
  component: null,
  created_at: "2026-09-08T09:00:00Z",
  edited_at: null,
  resolved_at: null,
  hidden_at: null,
  agent_context: null,
});

/** `MarkdownView` resolves issue refs against the project's config. */
function stubCommentFetch() {
  vi.stubGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (init?.method !== undefined && init.method !== "GET") {
      return new Response(null, { status: 204 });
    }
    if (url.includes("/references/config")) {
      return new Response(
        JSON.stringify({ format: { prefix: "T", history: [] }, autolinks: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/reference-directory")) {
      return new Response(
        JSON.stringify({ entries: [], contested: [], slug_entries: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
}

afterEach(() => vi.unstubAllGlobals());

/** The row on card 7 in project `p`, then on card 8 in project `q`: the jump
 *  whose comment id collides, because another project's database counts its
 *  comments from 1 as well. */
function Row({ hidden = false }: { hidden?: boolean } = {}) {
  const [onNext, setOnNext] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOnNext(true)}>
        the next card
      </button>
      <CommentItem
        slug={onNext ? "q" : SLUG}
        issueNumber={onNext ? 8 : 7}
        comment={{
          ...comment(11, onNext ? "card 8 body" : "card 7 body"),
          hidden_at: hidden ? "2026-09-08T11:00:00Z" : null,
        }}
        viewer={{ id: me.id, isAdmin: false, role: "writer" }}
      />
    </>
  );
}

describe("a comment edit aimed at a card the page then left", () => {
  /** Radix opens the menu on pointerdown, not on click. */
  const openMenu = async (view: RenderResult) => {
    const trigger = await waitFor(() =>
      within(view.container).getByLabelText("comment actions"),
    );
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
    return trigger;
  };

  const editButton = (view: RenderResult) =>
    waitFor(() => within(view.container).getByLabelText("edit comment"));

  it("lands the attachment and the edit on the card the editor was opened on", async () => {
    stubCommentFetch();
    const attachment = held<Attachment>();
    const uploadAttachment = vi
      .spyOn(api, "uploadAttachment")
      .mockReturnValue(attachment.promise);
    const updateComment = vi
      .spyOn(api, "updateComment")
      .mockResolvedValue(comment(11, "card 7, rewritten"));
    const view = renderWithProviders(<Row />);

    fireEvent.click(await editButton(view));
    await waitFor(() => expect(cmView(view.container)).toBeDefined());
    cmSetValue(view.container, "card 7, rewritten");
    dropBox(view.container);
    fireEvent.click(view.getByText("Save"));

    // The upload is what holds the edit open: the row's props move to the
    // other project while the write is still in flight.
    await waitFor(() => expect(uploadAttachment).toHaveBeenCalled());
    fireEvent.click(view.getByText("the next card"));
    attachment.release(uploaded());

    await waitFor(() => expect(updateComment).toHaveBeenCalled());
    expect(uploadAttachment.mock.calls[0]?.[1]).toBe(7);
    expect(updateComment.mock.calls[0]?.slice(0, 3)).toEqual([SLUG, 7, 11]);
  });

  it("hides on the card the reader was looking at", async () => {
    stubCommentFetch();
    const setCommentsHidden = vi
      .spyOn(api, "setCommentsHidden")
      .mockResolvedValue({ hidden: [], unchanged: [] });
    // Offline: the retryer pauses before `mutationFn` is ever called, so the
    // window is the whole pause — the options are read when it resumes.
    onlineManager.setOnline(false);
    // The unhide control rather than the menu's Hide: it is the same mutation
    // with the same closure, and a plain button that needs no popper to open.
    const client = queryClient();
    const view = renderWithProviders(<Row hidden />, client);

    fireEvent.click(
      await waitFor(() =>
        within(view.container).getByLabelText("unhide comment"),
      ),
    );
    await letTheLoopRun();
    expect(setCommentsHidden).not.toHaveBeenCalled();

    fireEvent.click(view.getByText("the next card"));
    await act(async () => {
      onlineManager.setOnline(true);
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(setCommentsHidden).toHaveBeenCalled());
    expect(setCommentsHidden.mock.calls[0]?.slice(0, 2)).toEqual([SLUG, 7]);
    // Not merely aimed right: the request still went out, after the jump.
    expect(setCommentsHidden).toHaveBeenCalledTimes(1);
  });

  it("deletes on the card the reader was looking at", async () => {
    stubCommentFetch();
    const deleteComment = vi
      .spyOn(api, "deleteComment")
      .mockResolvedValue(undefined);
    onlineManager.setOnline(false);
    const view = renderWithProviders(<Row />);

    await openMenu(view);
    fireEvent.click(await view.findByText("Delete comment…"));
    fireEvent.click(await view.findByText("Delete"));
    await letTheLoopRun();
    fireEvent.click(view.getByText("the next card"));
    act(() => onlineManager.setOnline(true));

    await waitFor(() => expect(deleteComment).toHaveBeenCalled());
    expect(deleteComment.mock.calls[0]?.slice(0, 2)).toEqual([SLUG, 7]);
  });

  it("refreshes the timeline of the card the request reached", async () => {
    stubCommentFetch();
    const write = held<TimelineComment>();
    vi.spyOn(api, "updateComment").mockReturnValue(write.promise);
    const client = queryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const view = renderWithProviders(<Row />, client);

    fireEvent.click(await editButton(view));
    await waitFor(() => expect(cmView(view.container)).toBeDefined());
    cmSetValue(view.container, "card 7, rewritten");
    fireEvent.click(view.getByText("Save"));
    await waitFor(() => expect(api.updateComment).toHaveBeenCalled());

    fireEvent.click(view.getByText("the next card"));
    write.release(comment(11, "card 7, rewritten"));

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["timeline", SLUG, 7],
      }),
    );
  });
});
