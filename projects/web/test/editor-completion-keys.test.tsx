import { completionStatus, startCompletion } from "@codemirror/autocomplete";
import { QueryClient } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import type {
  IssueListItem,
  IssueListPage,
  Label,
  Member,
  Project,
  ReferenceConfig,
  ReferenceDirectory,
  Status,
} from "@todou/shared";
import { describe, expect, it, vi } from "vitest";
import { issueCompletionQuery } from "../src/api/issues.ts";
import { projectsQuery } from "../src/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import { MarkdownEditor } from "../src/components/shared/markdown-editor.tsx";
import { ReviewSubmitDialog } from "../src/components/spec/review-submit.tsx";
import {
  completionWith,
  refCompletionSource,
} from "../src/lib/editor/ref-completion.ts";
import { commandCompletionSource } from "../src/lib/editor/slash-commands.ts";
import { buildCommandRegistry } from "../src/lib/slash-commands.ts";
import { cmGetValue, cmInput, cmPressKey, cmType, cmView } from "./cm.ts";
import { renderWithProviders } from "./render.tsx";

/**
 * Which keys the completion panel owns, and which ones it leaves to the
 * browser. Asserted through `defaultPrevented`, because focus movement is a
 * browser default action that happy-dom does not perform.
 */

const item = (number: number, title: string): IssueListItem => ({
  number,
  id: number,
  title,
  status: {
    id: 1,
    name: "Todo",
    category: "open",
    color: "#000000",
    position: 0,
    is_default: true,
  },
  author: {
    id: 1,
    login: "alice",
    display_name: "Alice",
    kind: "human",
    avatar_url: null,
    owner: null,
  },
  assignees: [],
  labels: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  body_edited_at: null,
  open_questions: 0,
  spec_version: null,
  spec_review_status: null,
  spec_unresolved_comments: 0,
  deleted_at: null,
  deleted_by: null,
  unread: false,
  unread_comments: 0,
  muted: null,
  blocked_by: [],
  blocks: [],
  moves: [],
});

function seededClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const config: ReferenceConfig = {
    format: { prefix: "T", history: [] },
    autolinks: [],
  };
  const directory: ReferenceDirectory = {
    entries: [
      {
        prefix: "M",
        slug: "mirror",
        from: "2020-01-01T00:00:00.000Z",
        to: null,
      },
    ],
    contested: [],
  };
  for (const slug of ["todou", "mirror"]) {
    client.setQueryData(referenceConfigQuery(slug).queryKey, config);
    client.setQueryData(issueCompletionQuery(slug).queryKey, {
      items: [item(1, "First")],
      next_cursor: null,
    } satisfies IssueListPage);
  }
  client.setQueryData(referenceDirectoryQuery.queryKey, directory);
  client.setQueryData(
    projectsQuery.queryKey,
    ["todou", "mirror"].map(
      (slug): Project => ({
        id: 1,
        slug,
        name: `The ${slug} project`,
        description: "",
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    ),
  );
  return client;
}

const editor = () => {
  const client = seededClient();
  return render(
    <MarkdownEditor
      ariaLabel="Body"
      extensions={completionWith([refCompletionSource("todou", client)])}
    />,
  );
};

/**
 * Long enough to cover both of upstream's delays: `activateOnTypingDelay`
 * before the panel opens, and the `interactionDelay` within which
 * `acceptCompletion` refuses so that a fast typist accepts nothing by
 * accident.
 */
const UPSTREAM_DELAYS = 200;

const settle = () =>
  new Promise((resolve) => setTimeout(resolve, UPSTREAM_DELAYS));

async function panelFor(root: ParentNode, text: string): Promise<void> {
  act(() => cmType(root, text));
  await waitFor(() =>
    expect(completionStatus(cmView(root).state)).toBe("active"),
  );
  await settle();
}

describe("the completion panel's keys", () => {
  it("accepts a card candidate on Tab", async () => {
    const view = editor();
    await panelFor(view.container, "see T-");
    const event = cmPressKey(view.container, "Tab");
    expect(cmGetValue(view.container)).toBe("see T-1 ");
    expect(event.defaultPrevented).toBe(true);
  });

  it("keeps the pending space through completion's effect transactions", async () => {
    const view = editor();
    await panelFor(view.container, "see T-");
    cmPressKey(view.container, "Tab");
    await waitFor(() =>
      expect(completionStatus(cmView(view.container).state)).toBeNull(),
    );
    await settle();
    startCompletion(cmView(view.container));

    const handled = cmInput(view.container, "，");
    expect(cmGetValue(view.container)).toBe("see T-1，");
    expect(handled).toBe(true);
  });

  it("leaves Tab to the browser with no panel open", async () => {
    const view = editor();
    cmType(view.container, "plain prose");
    // Waiting out the delays first, so this is a source that ran and found
    // nothing rather than one that had not started yet.
    await settle();
    expect(completionStatus(cmView(view.container).state)).toBeNull();
    const event = cmPressKey(view.container, "Tab");
    expect(cmGetValue(view.container)).toBe("plain prose");
    expect(event.defaultPrevented).toBe(false);
  });

  it("leaves Shift-Tab alone, so focus still walks backwards", async () => {
    const view = editor();
    await panelFor(view.container, "see T-");
    const event = cmPressKey(view.container, "Tab", { shiftKey: true });
    expect(cmGetValue(view.container)).toBe("see T-");
    expect(event.defaultPrevented).toBe(false);
  });

  it("keeps the project row space-free and reopens on mirror's cards", async () => {
    const view = editor();
    await panelFor(view.container, "see mir");
    cmPressKey(view.container, "Tab");
    expect(cmGetValue(view.container)).toBe("see mirror/");
    await waitFor(() =>
      expect(completionStatus(cmView(view.container).state)).toBe("active"),
    );
    await settle();
    cmPressKey(view.container, "Enter");
    expect(cmGetValue(view.container)).toBe("see mirror/1 ");
  });

  it("accepts a project candidate on Enter, exactly as a card is", async () => {
    // The chosen rule: one Enter for both kinds of row. Writing a project
    // name in prose therefore needs Escape before the newline.
    const view = editor();
    await panelFor(view.container, "see mir");
    cmPressKey(view.container, "Enter");
    expect(cmGetValue(view.container)).toBe("see mirror/");
  });

  it("lets the open panel consume Enter without inserting a newline", async () => {
    const view = editor();
    await panelFor(view.container, "see T-");
    const event = cmPressKey(view.container, "Enter");
    expect(event.defaultPrevented).toBe(true);
    expect(cmGetValue(view.container)).toBe("see T-1 ");
    expect(cmGetValue(view.container)).not.toContain("\n");
    cmPressKey(view.container, "Enter");
    expect(cmGetValue(view.container)).toBe("see T-1\n");
  });

  it("spends the first Escape on the panel, not on the dialog around it", async () => {
    const onClose = vi.fn();
    const view = renderWithProviders(
      <ReviewSubmitDialog
        slug="todou"
        issueNumber={23}
        currentVersion={3}
        drafts={[]}
        open
        onClose={onClose}
        onSubmitted={() => {}}
      />,
      seededClient(),
    );
    await view.findByRole("button", { name: "Comment" });
    await panelFor(view.baseElement, "see T-");

    cmPressKey(view.baseElement, "Escape");
    expect(onClose).not.toHaveBeenCalled();
    expect(cmGetValue(view.baseElement)).toBe("see T-");
    expect(completionStatus(cmView(view.baseElement).state)).toBeNull();

    cmPressKey(view.baseElement, "Escape");
    expect(onClose).toHaveBeenCalledOnce();
  });
});

const commandRegistry = buildCommandRegistry({
  statuses: [
    {
      id: 1,
      name: "Todo",
      category: "open",
      color: "#000000",
      position: 0,
      is_default: true,
    } satisfies Status,
    {
      id: 2,
      name: "Done",
      category: "closed",
      color: "#000000",
      position: 1,
      is_default: false,
    } satisfies Status,
  ],
  labels: [] as Label[],
  members: [] as Member[],
  me: undefined,
  surface: "comment",
});

const commandExtensions = completionWith([
  commandCompletionSource(() => commandRegistry),
]);

describe("the slash panel's keys", () => {
  it("ends the command on Enter rather than reaching force", async () => {
    const view = render(
      <MarkdownEditor ariaLabel="Body" extensions={commandExtensions} />,
    );
    await panelFor(view.container, "/hide-all ");
    cmPressKey(view.container, "Enter");
    expect(cmGetValue(view.container)).toBe("/hide-all \n");
  });

  it("reaches force one row down, so nothing was dropped", async () => {
    const view = render(
      <MarkdownEditor ariaLabel="Body" extensions={commandExtensions} />,
    );
    await panelFor(view.container, "/hide-all ");
    cmPressKey(view.container, "ArrowDown");
    cmPressKey(view.container, "Enter");
    expect(cmGetValue(view.container)).toBe("/hide-all force");
  });
});
