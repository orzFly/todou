import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import type {
  CommandInput,
  Label,
  Me,
  Member,
  Status,
  TimelineComment,
  TimelineItem,
} from "@todou/shared";
import { describe, expect, it, vi } from "vitest";
import {
  api,
  labelsQuery,
  membersQuery,
  meQuery,
  statusesQuery,
} from "../src/api/queries.ts";
import { allCommentsQuery } from "../src/api/timeline.ts";

vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  toast: { success: vi.fn(), error: vi.fn() },
}));
const { toast } = await import("sonner");

import {
  Composer,
  submitLabel,
  type Target,
  useCommentComposer,
} from "../src/components/timeline/composer.tsx";
import { cmFocus, cmGetValue, cmSetValue, cmView } from "./cm.ts";
import { testQueryClient } from "./render.tsx";

describe("submitLabel", () => {
  const base = {
    uploading: false,
    running: false,
    broken: 0,
    summaries: [] as string[],
    withComment: true,
  };

  it("names the comment alone when there are no commands", () => {
    expect(submitLabel(base)).toBe("Comment");
  });

  it("joins one command with an and, several with a comma", () => {
    expect(submitLabel({ ...base, summaries: ["close"] })).toBe(
      "Comment and close",
    );
    expect(submitLabel({ ...base, summaries: ["label bug", "close"] })).toBe(
      "Comment, label bug and close",
    );
  });

  it("drops the comment wording for a commands-only draft", () => {
    expect(
      submitLabel({ ...base, summaries: ["close"], withComment: false }),
    ).toBe("Run: close");
  });

  it("asks for a fix instead of advertising a blocked action", () => {
    expect(submitLabel({ ...base, broken: 1, summaries: ["close"] })).toBe(
      "Fix the command",
    );
    expect(submitLabel({ ...base, broken: 2 })).toBe("Fix 2 commands");
  });

  it("reports work in flight ahead of everything else", () => {
    expect(submitLabel({ ...base, uploading: true, broken: 1 })).toBe(
      "Uploading…",
    );
    expect(submitLabel({ ...base, running: true, summaries: ["close"] })).toBe(
      "Running…",
    );
  });
});

const status = (
  id: number,
  name: string,
  category: "open" | "closed",
  position: number,
  is_default = false,
): Status => ({ id, name, category, color: "#000000", position, is_default });

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

const MEMBERS: Member[] = [
  { user: ME, role: "writer", created_at: "2026-01-01T00:00:00.000Z" },
];
const LABELS: Label[] = [{ id: 10, name: "bug", color: "#ff0000" }];
const STATUSES: Status[] = [
  status(1, "Todo", "open", 0, true),
  status(2, "In Progress", "open", 1),
  status(3, "Done", "closed", 2),
];

const OTHER = {
  id: 200,
  login: "bob",
  display_name: "Bob",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const comment = (
  id: number,
  over: {
    hidden?: boolean;
    component?: TimelineComment["component"];
    resolved_at?: string | null;
    author?: TimelineComment["author"];
  } = {},
): TimelineItem => ({
  type: "comment",
  id,
  author: over.author ?? ME,
  body: `body ${id}`,
  component: over.component ?? null,
  created_at: "2026-09-08T12:00:00.000Z",
  edited_at: null,
  resolved_at: over.resolved_at ?? null,
  hidden_at: over.hidden === true ? "2026-09-08T13:00:00.000Z" : null,
  agent_context: null,
});

const QUESTIONS: TimelineComment["component"] = {
  type: "questions",
  questions: [
    {
      key: "q1",
      multiple: false,
      question: "Which?",
      options: [{ label: "a" }, { label: "b" }],
    },
  ],
};

const ANCHOR: TimelineComment["component"] = {
  type: "spec_comment",
  anchor: {
    path: "design.md",
    version: 1,
    line_start: 4,
    line_end: 4,
    col_start: null,
    col_end: null,
    quote: "a sentence",
  },
};

function mount(
  handlers: {
    onSend?: (body: string, target: Target) => void;
    onSendWithCommands?: (
      body: string,
      commands: CommandInput[],
      target: Target,
    ) => Promise<unknown>;
    /** What the composer's timeline drain finds, seeded (T-307). */
    timeline?: TimelineItem[];
  } = {},
) {
  const client = new QueryClient({
    defaultOptions: {
      // The drain is read through `fetchQuery` at submit time, which refetches
      // a stale entry; the seed below is the whole card as far as these tests
      // are concerned, and no fetch is wired up.
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
  client.setQueryData(statusesQuery("todou").queryKey, STATUSES);
  client.setQueryData(labelsQuery("todou").queryKey, LABELS);
  client.setQueryData(membersQuery("todou").queryKey, MEMBERS);
  client.setQueryData(meQuery.queryKey, ME);
  client.setQueryData(
    allCommentsQuery("todou", 7).queryKey,
    handlers.timeline ?? [],
  );
  const onSend = handlers.onSend ?? vi.fn();
  const onSendWithCommands =
    handlers.onSendWithCommands ?? vi.fn(async () => undefined);
  const tree = (issueNumber: number) => (
    <QueryClientProvider client={client}>
      <Composer
        // Exactly what issue-detail.tsx passes: the card number, so the
        // router's reused route subtree still gets a fresh composer.
        key={issueNumber}
        slug="todou"
        issueNumber={issueNumber}
        onSend={onSend}
        onSendWithCommands={onSendWithCommands}
        failed={[]}
        onRetry={vi.fn()}
      />
    </QueryClientProvider>
  );
  const view = render(tree(7));
  return { ...view, onSend, onSendWithCommands, tree };
}

const submitButton = (view: { container: HTMLElement }) => {
  const button = view.container.querySelector('button[type="submit"]');
  if (button === null) throw new Error("no submit button");
  return button as HTMLButtonElement;
};

/**
 * The card the composer was mounted on (T-321). Every submission carries it,
 * sealed in before the first `await`, so a send that outlives its composer
 * still names the card it was written on.
 */
const ON_CARD_7: Target = { slug: "todou", issueNumber: 7 };

describe("Composer with slash commands", () => {
  it("says what the submit is about to do", async () => {
    const view = mount();
    // Nothing typed yet, so the buttons are only there once the box is entered.
    cmFocus(view.container);
    await waitFor(() => expect(submitButton(view).disabled).toBe(true));
    expect(submitButton(view).textContent).toContain("Comment");

    cmSetValue(view.container, "just talking");
    await waitFor(() => expect(submitButton(view).disabled).toBe(false));
    expect(submitButton(view).textContent).toContain("Comment");

    cmSetValue(view.container, "shipping this\n/close");
    await waitFor(() =>
      expect(submitButton(view).textContent).toContain("Comment and close"),
    );

    cmSetValue(view.container, "/close");
    await waitFor(() =>
      expect(submitButton(view).textContent).toContain("Run: close"),
    );

    cmSetValue(view.container, "/in-progress\n/label bug");
    await waitFor(() =>
      expect(submitButton(view).textContent).toContain(
        "Run: move to In Progress and label bug",
      ),
    );
  });

  it("sends a plain comment down the optimistic path", async () => {
    const view = mount();
    cmSetValue(view.container, "no commands here");
    await waitFor(() => expect(submitButton(view).disabled).toBe(false));
    submitButton(view).click();
    await waitFor(() =>
      expect(view.onSend).toHaveBeenCalledWith("no commands here", ON_CARD_7),
    );
    expect(view.onSendWithCommands).not.toHaveBeenCalled();
  });

  it("strips the command lines out of the body it submits", async () => {
    const view = mount();
    cmSetValue(view.container, "shipping this\n/close\n/label bug");
    await waitFor(() => expect(submitButton(view).disabled).toBe(false));
    submitButton(view).click();
    await waitFor(() =>
      expect(view.onSendWithCommands).toHaveBeenCalledWith(
        "shipping this",
        [
          { type: "status", status_id: 3 },
          { type: "label_add", label_id: 10 },
        ],
        ON_CARD_7,
      ),
    );
    expect(view.onSend).not.toHaveBeenCalled();
  });

  it("submits commands with no body at all", async () => {
    const view = mount();
    cmSetValue(view.container, "/close");
    await waitFor(() => expect(submitButton(view).disabled).toBe(false));
    submitButton(view).click();
    await waitFor(() =>
      expect(view.onSendWithCommands).toHaveBeenCalledWith(
        "",
        [{ type: "status", status_id: 3 }],
        ON_CARD_7,
      ),
    );
  });

  it("blocks the submit and says why when an argument names nothing", async () => {
    const view = mount();
    cmSetValue(view.container, "/label nope");
    await waitFor(() => expect(submitButton(view).disabled).toBe(true));
    expect(view.container.textContent).toContain('no label named "nope"');
    expect(submitButton(view).textContent).toContain("Fix the command");
    submitButton(view).click();
    expect(view.onSendWithCommands).not.toHaveBeenCalled();
    expect(view.onSend).not.toHaveBeenCalled();
  });

  it("keeps the draft verbatim when the server refuses", async () => {
    const view = mount({
      onSendWithCommands: vi.fn(async () => {
        throw new Error("no");
      }),
    });
    cmSetValue(view.container, "shipping this\n/close");
    await waitFor(() => expect(submitButton(view).disabled).toBe(false));
    submitButton(view).click();
    await waitFor(() => expect(view.onSendWithCommands).toHaveBeenCalled());
    // Command lines included — the draft is the only copy of the submission.
    expect(cmGetValue(view.container)).toBe("shipping this\n/close");
  });

  it("clears the draft once the submission lands", async () => {
    const view = mount();
    cmSetValue(view.container, "shipping this\n/close");
    await waitFor(() => expect(submitButton(view).disabled).toBe(false));
    submitButton(view).click();
    await waitFor(() => expect(cmGetValue(view.container)).toBe(""));
  });

  it("highlights the command lines and leaves prose alone", async () => {
    const view = mount();
    cmSetValue(view.container, "prose\n/close\n/label nope\n```\n/close\n```");
    await waitFor(() =>
      expect(
        view.container.querySelectorAll(".cm-command-line").length,
      ).toBeGreaterThan(0),
    );
    const lines = [...view.container.querySelectorAll(".cm-line")].map(
      (line) => ({
        text: line.textContent,
        command: line.classList.contains("cm-command-line"),
        broken: line.classList.contains("cm-command-line-broken"),
      }),
    );
    expect(lines.filter((l) => l.command).map((l) => l.text)).toEqual([
      "/close",
      "/label nope",
    ]);
    expect(lines.filter((l) => l.broken).map((l) => l.text)).toEqual([
      "/label nope",
    ]);
  });
});

/**
 * `/hide-all` (T-307). The ids come from a drain of the whole timeline, not
 * from the rendered items, because the page folds its middle away.
 */
describe("Composer hiding every comment", () => {
  /** Plain, unanswered questions, unresolved annotation by someone else. */
  const CARD = [
    comment(101),
    comment(102),
    comment(103, { component: QUESTIONS }),
    comment(104, { component: ANCHOR, author: OTHER }),
  ];

  it("keeps the unsettled comments back and says which, and why", async () => {
    const view = mount({ timeline: CARD });
    cmSetValue(view.container, "/hide-all");
    await waitFor(() =>
      expect(view.container.textContent).toContain("hides 2 comments"),
    );
    expect(view.container.textContent).toContain("keeps 2");
    expect(view.container.textContent).toContain("#comment-103");
    expect(view.container.textContent).toContain("question unanswered");
    expect(view.container.textContent).toContain("#comment-104");
    expect(view.container.textContent).toContain("spec annotation unresolved");

    submitButton(view).click();
    await waitFor(() =>
      expect(view.onSendWithCommands).toHaveBeenCalledWith(
        "",
        [{ type: "comments_hide", hidden: true, comment_ids: [101, 102] }],
        ON_CARD_7,
      ),
    );
  });

  it("names what force will settle, then hides those too", async () => {
    const view = mount({ timeline: CARD });
    cmSetValue(view.container, "/hide-all force");
    await waitFor(() =>
      expect(view.container.textContent).toContain("hides 4 comments"),
    );
    // The irreversible half, before the press — and the annotation is Bob's.
    expect(view.container.textContent).toContain(
      "declines 1 unanswered question",
    );
    expect(view.container.textContent).toContain("resolves 1 annotation");
    expect(view.container.textContent).not.toContain("keeps");

    submitButton(view).click();
    await waitFor(() =>
      expect(view.onSendWithCommands).toHaveBeenCalledWith(
        "",
        [
          {
            type: "comments_hide",
            hidden: true,
            comment_ids: [101, 102, 103, 104],
          },
        ],
        ON_CARD_7,
      ),
    );
  });

  it("puts back exactly what is hidden now", async () => {
    const view = mount({
      timeline: [
        comment(101, { hidden: true }),
        comment(102),
        comment(103, { hidden: true, component: QUESTIONS }),
      ],
    });
    cmSetValue(view.container, "/unhide-all");
    await waitFor(() =>
      expect(view.container.textContent).toContain("restores 2 comments"),
    );

    submitButton(view).click();
    await waitFor(() =>
      expect(view.onSendWithCommands).toHaveBeenCalledWith(
        "",
        [{ type: "comments_hide", hidden: false, comment_ids: [101, 103] }],
        ON_CARD_7,
      ),
    );
  });

  it("carries the prose and the other commands with it", async () => {
    const view = mount({ timeline: CARD });
    cmSetValue(view.container, "the conclusion\n/hide-all\n/close");
    await waitFor(() => expect(submitButton(view).disabled).toBe(false));
    expect(submitButton(view).textContent).toContain(
      "Comment, hide every comment and close",
    );

    submitButton(view).click();
    await waitFor(() =>
      expect(view.onSendWithCommands).toHaveBeenCalledWith(
        "the conclusion",
        [
          { type: "comments_hide", hidden: true, comment_ids: [101, 102] },
          { type: "status", status_id: 3 },
        ],
        ON_CARD_7,
      ),
    );
  });

  it("blocks the submit when there is nothing left to hide", async () => {
    const view = mount({
      timeline: [
        comment(101, { hidden: true }),
        comment(102, { hidden: true }),
      ],
    });
    cmSetValue(view.container, "/hide-all");
    await waitFor(() =>
      expect(view.container.querySelector('[role="alert"]')).not.toBeNull(),
    );
    expect(view.container.textContent).toContain("nothing to hide");
    expect(submitButton(view).disabled).toBe(true);
    submitButton(view).click();
    expect(view.onSendWithCommands).not.toHaveBeenCalled();
  });

  it("says what the hide settled once the server has answered", async () => {
    const view = mount({
      timeline: CARD,
      onSendWithCommands: vi.fn(async () => ({
        comment: null,
        issue: {},
        hide: {
          hidden: [103, 104],
          unchanged: [],
          settled: { declined_questions: [103], resolved_annotations: [104] },
        },
      })),
    });
    cmSetValue(view.container, "/hide-all force");
    await waitFor(() => expect(submitButton(view).disabled).toBe(false));
    submitButton(view).click();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(vi.mocked(toast.success).mock.calls[0]?.[0]).toBe(
      "Hiding also declined 1 unanswered question(s) and resolved 1 annotation(s).",
    );
  });
});

const attachButton = (view: { container: HTMLElement }) =>
  view.container.querySelector('button[aria-label="Attach files"]');
const maybeSubmit = (view: { container: HTMLElement }) =>
  view.container.querySelector('button[type="submit"]');
const actionRow = (view: { container: HTMLElement }) =>
  view.container.querySelector('form > div:not([data-slot="markdown-editor"])');

/** A DataTransfer stand-in complete enough for CodeMirror's own drop handler. */
const carrying = (...files: File[]) =>
  ({
    files,
    types: [],
    items: [],
    getData: () => "",
  }) as unknown as DataTransfer;

describe("Composer buttons", () => {
  it("shows neither button until the box is entered", () => {
    const view = mount();
    expect(maybeSubmit(view)).toBeNull();
    expect(attachButton(view)).toBeNull();
  });

  it("shows both on focus, with the submit still disabled", async () => {
    const view = mount();
    cmFocus(view.container);
    await waitFor(() => expect(maybeSubmit(view)).not.toBeNull());
    expect(attachButton(view)).not.toBeNull();
    expect(submitButton(view).disabled).toBe(true);
  });

  it("keeps them once shown, even after the focus leaves", async () => {
    const view = mount();
    cmFocus(view.container);
    await waitFor(() => expect(maybeSubmit(view)).not.toBeNull());
    fireEvent.focusOut(cmView(view.container).contentDOM);
    expect(maybeSubmit(view)).not.toBeNull();
    expect(attachButton(view)).not.toBeNull();
  });

  it("hides them again once a submission lands", async () => {
    const view = mount();
    cmFocus(view.container);
    cmSetValue(view.container, "hello");
    await waitFor(() => expect(submitButton(view).disabled).toBe(false));
    submitButton(view).click();
    await waitFor(() => expect(maybeSubmit(view)).toBeNull());
    expect(attachButton(view)).toBeNull();
  });

  it("keeps them when the submission is refused", async () => {
    const view = mount({
      onSendWithCommands: vi.fn(async () => {
        throw new Error("no");
      }),
    });
    cmFocus(view.container);
    cmSetValue(view.container, "x\n/close");
    await waitFor(() => expect(submitButton(view).disabled).toBe(false));
    submitButton(view).click();
    await waitFor(() => expect(view.onSendWithCommands).toHaveBeenCalled());
    expect(maybeSubmit(view)).not.toBeNull();
    expect(cmGetValue(view.container)).toBe("x\n/close");
  });

  it("shows them for a file dropped in, which never focuses anything", async () => {
    const view = mount();
    fireEvent.drop(cmView(view.container).contentDOM, {
      dataTransfer: carrying(
        new File(["bytes"], "shot.png", { type: "image/png" }),
      ),
    });
    await waitFor(() => expect(maybeSubmit(view)).not.toBeNull());
    expect(attachButton(view)).not.toBeNull();
  });

  it("arrives empty on the next card, which reuses this route", async () => {
    const view = mount();
    cmFocus(view.container);
    await waitFor(() => expect(maybeSubmit(view)).not.toBeNull());
    // What `issue-detail.tsx` puts on the Composer: the card number, so a
    // changed param mounts a fresh one rather than reusing this instance.
    view.rerender(view.tree(8));
    expect(maybeSubmit(view)).toBeNull();
    expect(attachButton(view)).toBeNull();
  });

  it("sends the draft and the tray with the buttons on the next card", async () => {
    const view = mount();
    cmFocus(view.container);
    fireEvent.drop(cmView(view.container).contentDOM, {
      dataTransfer: carrying(
        new File(["bytes"], "shot.png", { type: "image/png" }),
      ),
    });
    cmSetValue(view.container, "a reply for card 7");
    await waitFor(() => expect(submitButton(view).disabled).toBe(false));

    view.rerender(view.tree(8));
    // Card 7's own text must not sit in card 8's box, one click from being
    // posted to the wrong card.
    expect(cmGetValue(view.container)).toBe("");
    expect(attachButton(view)).toBeNull();

    // Card 8's own draft is its own: typing here is unaffected.
    cmFocus(view.container);
    cmSetValue(view.container, "for card 8");
    await waitFor(() => expect(submitButton(view).disabled).toBe(false));
    expect(cmGetValue(view.container)).toBe("for card 8");
  });

  it("keeps the draft while it is still the same card", async () => {
    const view = mount();
    cmFocus(view.container);
    cmSetValue(view.container, "still card 7");
    await waitFor(() => expect(submitButton(view).disabled).toBe(false));
    view.rerender(view.tree(7));
    expect(cmGetValue(view.container)).toBe("still card 7");
  });

  it("never leaves a command error standing on its own", async () => {
    const view = mount();
    cmFocus(view.container);
    cmSetValue(view.container, "/label nope");
    await waitFor(() =>
      expect(view.container.querySelector('[role="alert"]')).not.toBeNull(),
    );
    // A broken line parses to neither body nor command, so it is the one way
    // the error block can outlive the buttons that explain what to do about
    // it — and a broken line is text on this card, which the next card drops.
    view.rerender(view.tree(8));
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(maybeSubmit(view)).toBeNull();
  });

  it("gives the buttons their own row at every width", async () => {
    const view = mount();
    cmFocus(view.container);
    await waitFor(() => expect(maybeSubmit(view)).not.toBeNull());
    const form = view.container.querySelector("form");
    expect(form?.className).not.toContain("sm:flex-row");
    expect(actionRow(view)?.className).not.toContain("sm:contents");
  });

  it("grows the row in rather than snapping it open", async () => {
    const view = mount();
    cmFocus(view.container);
    await waitFor(() => expect(maybeSubmit(view)).not.toBeNull());
    expect(actionRow(view)?.className).toContain("composer-actions-in");
  });
});

/**
 * `useCommentComposer` belongs to the page, above the keyed `Composer`, so the
 * key cannot reach its `pending` list. A failure from card 7 that survived the
 * jump would render its "sending failed" row on card 8 with a Retry that posts
 * card 7's body to card 8 (T-317).
 */
describe("a failed comment across a card change", () => {
  it("does not follow the reader to the next card", async () => {
    const createComment = vi
      .spyOn(api, "createComment")
      .mockRejectedValue(new Error("offline"));
    const hook = renderHook(
      ({ issueNumber }: { issueNumber: number }) =>
        useCommentComposer("p", issueNumber, ME),
      {
        initialProps: { issueNumber: 7 },
        wrapper: ({ children }) => (
          <QueryClientProvider client={testQueryClient()}>
            {children}
          </QueryClientProvider>
        ),
      },
    );

    act(() =>
      hook.result.current.send("a comment for card 7", {
        slug: "p",
        issueNumber: 7,
      }),
    );
    await waitFor(() =>
      expect(hook.result.current.pending[0]?.failed).toBe(true),
    );

    hook.rerender({ issueNumber: 8 });
    expect(hook.result.current.pending).toEqual([]);

    // And there is nothing left to retry into the wrong card.
    createComment.mockClear();
    act(() => hook.result.current.retry(0));
    expect(createComment).not.toHaveBeenCalled();
  });
});
