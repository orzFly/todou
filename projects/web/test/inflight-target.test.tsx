import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
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
  IssueMetadataEntry,
  Me,
  Project,
  QuestionsComponent,
  SpecCommentComponent,
  SpecComments,
  SpecFiles,
  SpecInfo,
  TimelineComment,
} from "@todou/shared";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueMetadataQuery } from "../src/api/metadata.ts";
import { api, projectQuery } from "../src/api/queries.ts";
import { MarkAllReadButton } from "../src/components/issue/mark-all-read-button.tsx";
import { MarkReadButton } from "../src/components/issue/mark-read-button.tsx";
import { MarkReadOnView } from "../src/components/issue/mark-read-on-view.tsx";
import { MetadataSection } from "../src/components/issue/metadata-section.tsx";
import { CommentItem } from "../src/components/timeline/comment-item.tsx";
import {
  Composer,
  useCommentComposer,
} from "../src/components/timeline/composer.tsx";
import { QuestionsCard } from "../src/components/timeline/questions-card.tsx";
import { SpecCommentAnchorCard } from "../src/components/timeline/spec-comment-card.tsx";
import { parseSpecSearch } from "../src/lib/spec-search.ts";
import { BodyBlock } from "../src/pages/issue-detail.tsx";
import { SpecViewPage } from "../src/pages/spec-view.tsx";
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
  // A failing case must not leave the fake clock behind either.
  vi.useRealTimers();
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

/** An anchor the card row can resolve without a file version query. */
const specComponent = (path: string): SpecCommentComponent => ({
  type: "spec_comment",
  anchor: {
    path,
    version: 2,
    line_start: 3,
    line_end: 4,
    col_start: null,
    col_end: null,
    quote: "Anchors point at…\nResolve is one-way.",
  },
});

/**
 * The card row re-pointed at another card, the way a page does it when the
 * route moves: same instance, new props. No `key` — a key would unmount the
 * row and leave its closure standing on the card it was built for, which is
 * the situation the sealing exists for, not the one it has to survive.
 */
function CardRow() {
  const [onNext, setOnNext] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOnNext(true)}>
        the next card
      </button>
      <SpecCommentAnchorCard
        slug={onNext ? "q" : SLUG}
        issueNumber={onNext ? 8 : 7}
        commentId={11}
        component={specComponent(onNext ? "other.md" : "design.md")}
        resolvedAt={null}
        canResolve
      />
    </>
  );
}

describe("a spec comment resolve aimed at a card the row then left", () => {
  it("resolves on the card the button was pressed on", async () => {
    const resolveSpecComments = vi
      .spyOn(api, "resolveSpecComments")
      .mockResolvedValue({} as never);
    // Offline: the retryer pauses before `mutationFn` is ever called, so the
    // window is the whole pause — the options are read when it resumes.
    onlineManager.setOnline(false);
    const view = renderWithProviders(<CardRow />);

    fireEvent.click(await view.findByText("Resolve"));
    await letTheLoopRun();
    expect(resolveSpecComments).not.toHaveBeenCalled();

    fireEvent.click(view.getByText("the next card"));
    act(() => onlineManager.setOnline(true));

    await waitFor(() => expect(resolveSpecComments).toHaveBeenCalled());
    expect(resolveSpecComments.mock.calls[0]?.slice(0, 3)).toEqual([
      SLUG,
      7,
      [11],
    ]);
    // Not merely aimed right: the request still went out, after the jump.
    expect(resolveSpecComments).toHaveBeenCalledTimes(1);
  });
});

const questionsOf = (
  keys: ReadonlyArray<[string, string]>,
): QuestionsComponent => ({
  type: "questions",
  questions: keys.map(([key, label]) => ({
    key,
    header: key,
    question: `Which ${key}?`,
    multiple: false,
    options: [{ label }],
  })),
});

/**
 * The questions row re-pointed at another card under a project whose question
 * keys are all different — a second project's questions are written from
 * scratch, so nothing lines up with the drafts still sitting in this row.
 *
 * One instance, new props: no `key`, for the reason given on `CardRow`.
 */
function QuestionsRow({
  nextKeys,
}: {
  nextKeys: ReadonlyArray<[string, string]>;
}) {
  const [onNext, setOnNext] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOnNext(true)}>
        the next card
      </button>
      <QuestionsCard
        slug={onNext ? "q" : SLUG}
        issueNumber={onNext ? 8 : 7}
        commentId={11}
        component={questionsOf(
          onNext
            ? nextKeys
            : [
                ["schema", "New entity"],
                ["scope", "dev"],
              ],
        )}
      />
    </>
  );
}

/**
 * Route-table stub. Option labels and question text go through `MarkdownView`,
 * which resolves issue refs against the project's config — without that reply
 * the second option's label never renders and its click has nothing to land on.
 */
function stubAnswers() {
  vi.stubGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? "GET") !== "GET") {
      return new Response(null, { status: 204 });
    }
    if (url.includes("/questions")) {
      return Response.json({
        items: [
          {
            comment_id: 11,
            author: me,
            created_at: "2026-09-08T09:00:00Z",
            questions: [],
            answer: null,
          },
        ],
        open: 2,
      });
    }
    if (url.includes("/references/config")) {
      return Response.json({
        format: { prefix: "T", history: [] },
        autolinks: [],
      });
    }
    if (url.includes("/reference-directory")) {
      return Response.json({
        entries: [],
        contested: [],
        slug_entries: [],
      });
    }
    return Response.json([]);
  }) as unknown as typeof fetch);
}

const optionButton = (view: RenderResult, label: string) =>
  view.getByText(label).closest("button") as HTMLButtonElement;

describe("a question answer aimed at a card the row then left", () => {
  /**
   * The option rows refuse a click that lands inside a live text selection
   * (the copy guard), and a range left standing by an earlier case in this
   * file would make every pick below a no-op.
   */
  afterEach(() => window.getSelection()?.removeAllRanges());

  it("submits to the card the reader answered on", async () => {
    stubAnswers();
    const submitAnswers = vi
      .spyOn(api, "submitAnswers")
      .mockResolvedValue({} as never);
    // Same question keys on the next card: this case is about the target
    // alone, and the payload case below is the one that moves the keys.
    const view = renderWithProviders(
      <QuestionsRow
        nextKeys={[
          ["schema", "New entity"],
          ["scope", "dev"],
        ]}
      />,
    );
    await view.findByText("awaiting answer");

    // The form starts working before the window opens: `ready` is the answer
    // query's `isSuccess`, and a client that is already offline never fires it
    // — every click below would be inert. Offline here is about the write.
    fireEvent.click(optionButton(view, "New entity"));
    fireEvent.click(optionButton(view, "dev"));
    const submit = await view.findByText("Submit answers");
    expect((submit.closest("button") as HTMLButtonElement).disabled).toBe(
      false,
    );

    onlineManager.setOnline(false);
    fireEvent.click(submit);
    await letTheLoopRun();
    expect(submitAnswers).not.toHaveBeenCalled();

    fireEvent.click(view.getByText("the next card"));
    act(() => onlineManager.setOnline(true));

    await waitFor(() => expect(submitAnswers).toHaveBeenCalled());
    expect(submitAnswers.mock.calls[0]?.slice(0, 3)).toEqual([SLUG, 7, 11]);
    expect(submitAnswers).toHaveBeenCalledTimes(1);
  });

  it("sends the answers the reader gave, not the next card's blank ones", async () => {
    stubAnswers();
    const submitAnswers = vi
      .spyOn(api, "submitAnswers")
      .mockResolvedValue({} as never);
    // The next card shares no question key with card 7. Sealed target alone
    // would submit this payload to card 7 accurately: `component` moves with
    // the props while `drafts` is state that does not reset, so the answers
    // have to be read at `mutate()` rather than inside `mutationFn`.
    const view = renderWithProviders(
      <QuestionsRow nextKeys={[["ship", "Yes"]]} />,
    );
    await view.findByText("awaiting answer");

    fireEvent.click(optionButton(view, "New entity"));
    fireEvent.click(optionButton(view, "dev"));
    const submit = await view.findByText("Submit answers");
    expect((submit.closest("button") as HTMLButtonElement).disabled).toBe(
      false,
    );

    onlineManager.setOnline(false);
    fireEvent.click(submit);
    await letTheLoopRun();
    expect(submitAnswers).not.toHaveBeenCalled();

    fireEvent.click(view.getByText("the next card"));
    await act(async () => {
      onlineManager.setOnline(true);
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(submitAnswers).toHaveBeenCalled());
    const answers = submitAnswers.mock.calls[0]?.[3].answers;
    expect(answers.map((a) => a.key)).toEqual(["schema", "scope"]);
    expect(answers[0]?.selected).toEqual([0]);
    expect(answers[1]?.selected).toEqual([0]);
  });
});

/**
 * Seed for the metadata block below: both cards resolve, because the write
 * must be aimed from a dialog that stayed mounted while the card changed.
 */
function seedMetadata(client: QueryClient, slugParam: string = SLUG) {
  const project = {
    id: 1,
    slug: slugParam,
    name: "Project",
    viewer_role: "writer",
  } as unknown as Project;
  const entries = {
    entries: [
      {
        namespace: "ci",
        key: "url",
        value: "x",
        updated_at: "2026-01-01T00:00:00Z",
        updated_by: {
          id: me.id,
          login: me.login,
          display_name: me.display_name,
          kind: me.kind,
          avatar_url: null,
          owner: null,
        },
      } satisfies IssueMetadataEntry,
    ],
  };
  client.setQueryData(projectQuery(slugParam).queryKey, project);
  client.setQueryData(issueMetadataQuery(slugParam, 7).queryKey, entries);
  client.setQueryData(issueMetadataQuery(slugParam, 8).queryKey, entries);
}

describe("a read write aimed at a card the page then left", () => {
  it("marks read on the card the view was mounted on", async () => {
    const markIssueRead = vi
      .spyOn(api, "markIssueRead")
      .mockResolvedValue(undefined);
    vi.useFakeTimers();
    function MarkReadOnViewRow() {
      const [onNext, setOnNext] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOnNext(true)}>
            the next card
          </button>
          <MarkReadOnView slug={onNext ? "q" : SLUG} number={onNext ? 8 : 7} />
        </>
      );
    }

    onlineManager.setOnline(false);
    renderWithProviders(<MarkReadOnViewRow />);

    // The mount write is already in flight; the pause is the window.
    await act(async () => {});
    expect(markIssueRead).not.toHaveBeenCalled();

    // The re-point re-runs the effect and queues a second, debounced write.
    // Freezing the clock here keeps both writes queued for one resume, so
    // the first call is the mount's — assert the aim, never the call count.
    fireEvent.click(screen.getByText("the next card"));
    await act(async () => {});
    act(() => onlineManager.setOnline(true));

    await act(async () => {});
    expect(markIssueRead.mock.calls[0]?.slice(0, 2)).toEqual([SLUG, 7]);
  });
});

describe("a read write aimed at a card the row then left", () => {
  it("marks read on the card the button was pressed on", async () => {
    const markIssueRead = vi
      .spyOn(api, "markIssueRead")
      .mockResolvedValue(undefined);
    function MarkReadButtonRow() {
      const [onNext, setOnNext] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOnNext(true)}>
            the next card
          </button>
          <MarkReadButton
            slug={onNext ? "q" : SLUG}
            number={onNext ? 8 : 7}
            unread
            unreadComments={0}
          />
        </>
      );
    }
    const client = queryClient();
    client.setQueryData(["me-prefs"], { show_weak_unread: true });

    onlineManager.setOnline(false);
    const view = renderWithProviders(<MarkReadButtonRow />, client);

    fireEvent.click(await view.findByTitle("new activity — mark as read"));
    await letTheLoopRun();
    expect(markIssueRead).not.toHaveBeenCalled();

    fireEvent.click(view.getByText("the next card"));
    act(() => onlineManager.setOnline(true));

    await waitFor(() => expect(markIssueRead).toHaveBeenCalled());
    expect(markIssueRead.mock.calls[0]?.slice(0, 2)).toEqual([SLUG, 7]);
  });
});

describe("a sweep aimed at a scope the header then left", () => {
  it("sweeps the scope the button was pressed on", async () => {
    const markAllRead = vi
      .spyOn(api, "markAllRead")
      .mockResolvedValue(undefined);
    function MarkAllReadButtonRow() {
      const [onNext, setOnNext] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOnNext(true)}>
            the next card
          </button>
          <MarkAllReadButton slug={onNext ? "q" : SLUG} />
        </>
      );
    }

    onlineManager.setOnline(false);
    const view = renderWithProviders(<MarkAllReadButtonRow />);

    fireEvent.click(await view.findByTitle("Mark p as read"));
    await letTheLoopRun();
    expect(markAllRead).not.toHaveBeenCalled();

    fireEvent.click(view.getByText("the next card"));
    act(() => onlineManager.setOnline(true));

    await waitFor(() => expect(markAllRead).toHaveBeenCalled());
    expect(markAllRead.mock.calls[0]?.[0]).toEqual({ projects: [SLUG] });
  });
});

describe("a metadata write aimed at a card the dialog then left", () => {
  it("writes to the card the dialog was opened on", async () => {
    const writeIssueMetadata = vi
      .spyOn(api, "writeIssueMetadata")
      .mockResolvedValue({} as never);
    function MetadataDialogRow() {
      const [onNext, setOnNext] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOnNext(true)}>
            the next card
          </button>
          <MetadataSection
            slug={onNext ? "q" : SLUG}
            issueNumber={onNext ? 8 : 7}
          />
        </>
      );
    }
    const client = queryClient();
    seedMetadata(client, SLUG);
    seedMetadata(client, "q");

    onlineManager.setOnline(false);
    const view = renderWithProviders(<MetadataDialogRow />, client);

    fireEvent.click(await view.findByTestId("metadata-open"));
    fireEvent.click(await view.findByTitle("Edit this value"));
    fireEvent.change(await view.findByLabelText("ci/url"), {
      target: { value: "impl" },
    });
    fireEvent.click(view.getByText("Save"));
    await letTheLoopRun();
    expect(writeIssueMetadata).not.toHaveBeenCalled();

    // The dialog lives in a portal: its own subtree is what re-points, and
    // the write the resume picks up must read the props from before it.
    fireEvent.click(view.getByText("the next card"));
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(writeIssueMetadata).toHaveBeenCalled());
    expect(writeIssueMetadata.mock.calls[0]?.slice(0, 2)).toEqual([SLUG, 7]);
  });
});

/**
 * The spec page's own resolve, which the route params feed. It is the one
 * place here that needs a router: `SpecViewBody` reads them through
 * `useParams`/`useSearch`, and `load-bearing` is that the in-flight write
 * keeps the params it started under.
 */
describe("a spec resolve aimed at a page the router then left", () => {
  /** Mounted on the issue the case then navigates away from. */
  function renderSpec() {
    vi.spyOn(api, "getSpec").mockResolvedValue({
      current_version: 1,
      current_version_cursor: "c1",
      review_status: "unreviewed",
      unresolved_comments: 1,
      unresolved_carried_comments: 0,
      files: [{ path: "design.md", size: 20 }],
      versions: [
        {
          number: 1,
          author: me,
          message: "v1",
          created_at: "2026-09-08T09:00:00Z",
        },
      ],
    } satisfies SpecInfo);
    vi.spyOn(api, "getSpecFiles").mockResolvedValue({
      version: 1,
      files: [
        {
          path: "design.md",
          body: "line one\nline two\nline three\nline four\n",
          size: 40,
        },
      ],
    } satisfies SpecFiles);
    vi.spyOn(api, "getSpecComments").mockResolvedValue({
      current_version: 1,
      items: [
        {
          comment_id: 11,
          author: me,
          created_at: "2026-09-08T10:00:00Z",
          body: "is this right?",
          // File-level: it renders in the "File comments" strip, which is the
          // one resolve affordance that does not need the markdown blocks to
          // carry their source-line stamps.
          anchor: {
            path: "design.md",
            version: 1,
            line_start: null,
            line_end: null,
            col_start: null,
            col_end: null,
            quote: "",
          },
          resolved: null,
          outdated: false,
          current_line_start: null,
          current_line_end: null,
        },
      ],
    } satisfies SpecComments);
    vi.spyOn(api, "getReferenceConfig").mockResolvedValue({
      format: { prefix: "T", history: [] },
      autolinks: [],
    });

    const rootRoute = createRootRoute();
    const authedRoute = createRoute({
      getParentRoute: () => rootRoute,
      id: "authed",
    });
    const projectRoute = createRoute({
      getParentRoute: () => authedRoute,
      path: "/projects/$slug",
    });
    const issueRoute = createRoute({
      getParentRoute: () => projectRoute,
      path: "issues/$number",
      component: () => <div>the next card</div>,
    });
    const specRoute = createRoute({
      getParentRoute: () => projectRoute,
      path: "issues/$number/spec",
      component: SpecViewPage,
      validateSearch: parseSpecSearch,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        authedRoute.addChildren([
          projectRoute.addChildren([issueRoute, specRoute]),
        ]),
      ]),
      history: createMemoryHistory({
        initialEntries: ["/projects/p/issues/7/spec"],
      }),
      defaultPendingMs: 0,
    });
    const view = render(
      <QueryClientProvider client={queryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    return { ...view, router };
  }

  it("resolves on the card the page was showing", async () => {
    const resolveSpecComments = vi
      .spyOn(api, "resolveSpecComments")
      .mockResolvedValue({} as never);
    const view = renderSpec();

    // The whole toolbar has settled once Finish review is on screen; the
    // comment strip lands with the same commit.
    const settled = () => view.findByRole("button", { name: /finish review/i });

    // Warm the destination first. A cold navigation suspends, which unmounts
    // the page and leaves its closures standing on the card they were built
    // for — the mutation would then reach the right card with or without the
    // seal, and this case would assert nothing. Cached, the jump is a plain
    // re-render of the same instance with new params: the option swap the
    // design is about. The mock answers every slug alike, so warming q/8 is
    // the same navigation twice.
    await settled();
    await act(async () => {
      await view.router.navigate({
        to: "/projects/$slug/issues/$number/spec",
        params: { slug: "q", number: "8" },
      });
    });
    await settled();
    await act(async () => {
      await view.router.navigate({
        to: "/projects/$slug/issues/$number/spec",
        params: { slug: SLUG, number: "7" },
      });
    });
    await settled();

    const resolve = await view.findByRole("button", { name: /^resolve$/i });
    onlineManager.setOnline(false);
    fireEvent.click(resolve);
    await letTheLoopRun();
    expect(resolveSpecComments).not.toHaveBeenCalled();

    // Leave through the router for another card's spec: the same route, new
    // params. `SpecViewBody` reads them through `useParams`, so this is what
    // re-points every closure the page mounted with.
    await act(async () => {
      await view.router.navigate({
        to: "/projects/$slug/issues/$number/spec",
        params: { slug: "q", number: "8" },
      });
    });
    act(() => onlineManager.setOnline(true));

    await waitFor(() => expect(resolveSpecComments).toHaveBeenCalled());
    expect(resolveSpecComments.mock.calls[0]?.slice(0, 3)).toEqual([
      SLUG,
      7,
      [11],
    ]);
    expect(resolveSpecComments).toHaveBeenCalledTimes(1);
  });
});
