import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { TimelineComment } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { CommentItem } from "../src/components/timeline/comment-item.tsx";
import { inlineActionSource } from "../src/lib/action-text.ts";
import { renderWithProviders } from "./render.tsx";

/** `/me` lines on the timeline (T-575). */

const author = {
  id: 2,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const ACTION: TimelineComment = {
  type: "comment",
  id: 4321,
  author,
  body: "is reviewing `the diff`.",
  kind: "action",
  component: null,
  created_at: "2026-08-11T00:00:00Z",
  edited_at: null,
  resolved_at: null,
  hidden_at: null,
  agent_context: null,
};

afterEach(() => {
  vi.restoreAllMocks();
});

/** Radix opens on pointerdown, not on click. */
const openMenu = async (container: HTMLElement) => {
  const trigger = await waitFor(() =>
    within(container).getByRole("button", { name: "action actions" }),
  );
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
  return trigger;
};

const row = (container: HTMLElement) => {
  const found = container.querySelector(`[data-comment-id="${ACTION.id}"]`);
  if (found === null) throw new Error("no row");
  return found as HTMLElement;
};

describe("an action on the timeline", () => {
  it("reads as one sentence after its author's name, not as a comment card", async () => {
    const view = renderWithProviders(
      <CommentItem slug="todou" issueNumber={7} comment={ACTION} />,
    );
    await view.findByText("Alice");
    const el = row(view.container);
    expect(el.dataset.commentKind).toBe("action");
    expect(el.id).toBe(`comment-${ACTION.id}`);
    expect(el.textContent).toMatch(/^\s*AAlice\s+is reviewing the diff\./);
    expect(el.querySelector("code")?.textContent).toBe("the diff");
    // No card: a comment's border and header are what an action is not.
    expect(el.className).not.toContain("border");
    expect(el.querySelector("p")?.closest("[class*='[&_p]:inline']")).not.toBe(
      null,
    );
  });

  it("keeps a line that opens like a list as text", async () => {
    const view = renderWithProviders(
      <CommentItem
        slug="todou"
        issueNumber={7}
        comment={{ ...ACTION, body: "- checks the list" }}
      />,
    );
    await view.findByText("Alice");
    expect(row(view.container).querySelector("li")).toBeNull();
    expect(row(view.container).textContent).toContain("- checks the list");
  });

  it("stays a comment when the kind is absent or unknown", async () => {
    for (const kind of [undefined, "shout"]) {
      const view = renderWithProviders(
        <CommentItem
          slug="todou"
          issueNumber={7}
          comment={{ ...ACTION, kind }}
        />,
      );
      await view.findByText("Alice");
      expect(row(view.container).dataset.commentKind).toBeUndefined();
      view.unmount();
    }
  });

  it("shows no control but the … and the time, which links like an event's (T-579)", async () => {
    const view = renderWithProviders(
      <CommentItem
        slug="todou"
        issueNumber={7}
        comment={{ ...ACTION, hidden_at: "2026-08-12T00:00:00Z" }}
        viewer={{ id: author.id, isAdmin: false, role: "writer" }}
      />,
    );
    await view.findByText("Alice");
    const el = row(view.container);
    expect(
      [...el.querySelectorAll("button")].map((b) =>
        b.getAttribute("aria-label"),
      ),
    ).toEqual(["action actions"]);
    expect(el.textContent).not.toContain("#comment-");
    const time = el.querySelector("time")?.closest("a");
    expect(time?.getAttribute("href")).toBe(
      `/projects/todou/issues/7#comment-${ACTION.id}`,
    );
    // The time is what lines up with an event's, so it is the last thing on a
    // wide row even though the … follows it in the source.
    expect(time?.className).toContain("sm:order-last");

    await openMenu(view.container);
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(
      expect.arrayContaining([
        "Edit action",
        "Unhide action",
        "Delete action…",
      ]),
    );
  });

  it("edits on one line and refuses a second", async () => {
    const updateComment = vi
      .spyOn(api, "updateComment")
      .mockResolvedValue(ACTION);
    const view = renderWithProviders(
      <CommentItem
        slug="todou"
        issueNumber={7}
        comment={ACTION}
        viewer={{ id: author.id, isAdmin: false }}
      />,
    );
    const trigger = await openMenu(view.container);
    fireEvent.click(screen.getByRole("menuitem", { name: /Edit action/ }));
    const input = view.getByLabelText("Edit action") as HTMLInputElement;
    expect(input.value).toBe(ACTION.body);
    // The menu that opened it is gone; the focus must not go with it.
    await waitFor(() => expect(document.activeElement).toBe(input));

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await openMenu(view.container);
    fireEvent.click(screen.getByRole("menuitem", { name: /Edit action/ }));

    fireEvent.change(view.getByLabelText("Edit action"), {
      target: { value: "x".repeat(501) },
    });
    expect(view.getByText("Save").closest("button")?.disabled).toBe(true);
    expect(view.container.textContent).toContain("at most 500 characters");

    fireEvent.change(view.getByLabelText("Edit action"), {
      target: { value: " is testing. " },
    });
    fireEvent.click(view.getByText("Save"));
    await waitFor(() => expect(updateComment).toHaveBeenCalledOnce());
    expect(updateComment.mock.calls[0]?.[3]).toBe("is testing.");
  });
});

describe("inlineActionSource", () => {
  it.each([
    ["- checks the list", "\\- checks the list"],
    ["1. reads the spec", "1\\. reads the spec"],
    ["# of tests: 4", "\\# of tests: 4"],
    ["> quotes", "\\> quotes"],
    ["```js", "\\```js"],
    ["---", "\\---"],
    ["is *very* sure", "is *very* sure"],
    ["*waves*", "*waves*"],
    ["-1 degrees outside", "-1 degrees outside"],
  ])("keeps %j inline", (text, escaped) => {
    expect(inlineActionSource(text)).toBe(escaped);
  });
});
