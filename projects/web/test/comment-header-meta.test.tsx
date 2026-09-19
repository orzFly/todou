import { fireEvent, waitFor } from "@testing-library/react";
import type { SpecCommentItem, TimelineComment } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { CommentHoverCard } from "../src/components/shared/comment-hover-card.tsx";
import { SpecAnnotationHoverCard } from "../src/components/shared/spec-annotation-hover-card.tsx";
import {
  CommentItem,
  type Viewer,
} from "../src/components/timeline/comment-item.tsx";
import { expectHeaderMeta, metaLinks } from "./header-meta.ts";
import { renderWithProviders } from "./render.tsx";

/**
 * The `#comment-N` and creation time every comment's own header carries
 * (T-435), on the entry points that mount a header directly. The spec
 * document's four are in comment-header-meta-spec.test.tsx, and the
 * optimistic states in comment-header-meta-optimistic.test.tsx.
 *
 * `CREATED` and `EDITED` differ on purpose: a header reading `edited_at`
 * would still show a plausible date, and only two distinct dates can tell
 * the two apart.
 */
const CREATED = "2026-08-12T00:00:00Z";
const EDITED = "2026-09-01T07:30:00Z";

const author = {
  id: 1,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const commentOf = (
  id: number,
  extra: Partial<TimelineComment> = {},
): TimelineComment => ({
  type: "comment",
  id,
  author,
  body: "the comment body",
  created_at: CREATED,
  component: null,
  edited_at: null,
  resolved_at: null,
  hidden_at: null,
  agent_context: null,
  ...extra,
});

const annotationOf = (commentId: number): SpecCommentItem => ({
  comment_id: commentId,
  author,
  created_at: CREATED,
  body: "why not a column?",
  hidden_at: null,
  anchor: {
    path: "design.md",
    version: 2,
    line_start: 42,
    line_end: 48,
    col_start: null,
    col_end: null,
    quote: "one read-time count",
  },
  resolved: null,
  outdated: false,
  current_line_start: 42,
  current_line_end: 48,
});

describe("a timeline comment's own header (T-435)", () => {
  it("shows the short id and then the creation time", async () => {
    const view = renderWithProviders(
      <CommentItem slug="p" issueNumber={7} comment={commentOf(12)} />,
    );
    await waitFor(() => {
      expect(
        view.container.querySelectorAll(
          "a[href='/projects/p/issues/7#comment-12']",
        ),
      ).toHaveLength(2);
    });
    expectHeaderMeta(
      view.container,
      "/projects/p/issues/7#comment-12",
      12,
      CREATED,
    );
  });

  it("reads the creation time, never the edit time", async () => {
    const view = renderWithProviders(
      <CommentItem
        slug="p"
        issueNumber={7}
        comment={commentOf(12, { edited_at: EDITED })}
      />,
    );
    const { stamp } = await waitFor(() => {
      const found = metaLinks(
        view.container,
        "/projects/p/issues/7#comment-12",
      );
      expect(found.stamp).toBeDefined();
      return found;
    });
    expect(stamp?.textContent).toBe(new Date(CREATED).toLocaleString());
    expect(stamp?.textContent).not.toBe(new Date(EDITED).toLocaleString());
    expect(stamp?.querySelector("time")?.getAttribute("datetime")).toBe(
      CREATED,
    );
    // The edited marker keeps its own place beside the meta.
    expect(view.container.textContent).toContain("edited");
  });

  it.each([
    ["a reader who may not edit", null, false],
    ["the author", { id: 1, isAdmin: false, role: "writer" }, true],
    ["a project admin", { id: 99, isAdmin: true, role: "admin" }, true],
  ] as const)("shows the id and time to %s", async (_who, viewer, mayEdit) => {
    const view = renderWithProviders(
      <CommentItem
        slug="p"
        issueNumber={7}
        comment={commentOf(12)}
        viewer={viewer as Viewer | null}
      />,
    );
    await waitFor(() => {
      expect(
        view.container.querySelectorAll(
          "a[href='/projects/p/issues/7#comment-12']",
        ),
      ).toHaveLength(2);
    });
    expectHeaderMeta(
      view.container,
      "/projects/p/issues/7#comment-12",
      12,
      CREATED,
    );
    // The action matrix is untouched by the meta that moved in beside it.
    expect(
      view.container.querySelector("[aria-label='edit comment']") !== null,
    ).toBe(mayEdit);
    expect(
      view.container.querySelector("[aria-label='comment actions']"),
    ).not.toBeNull();
  });

  it("navigates to the comment when the id is clicked", async () => {
    const view = renderWithProviders(
      <CommentItem slug="p" issueNumber={7} comment={commentOf(12)} />,
    );
    const { id } = await waitFor(() => {
      const found = metaLinks(
        view.container,
        "/projects/p/issues/7#comment-12",
      );
      expect(found.id).toBeDefined();
      return found;
    });
    fireEvent.click(id as HTMLAnchorElement);
    await waitFor(() => {
      expect(view.router.state.location.pathname).toBe("/projects/p/issues/7");
    });
    expect(view.router.state.location.hash).toBe("comment-12");
  });

  it("leaves a modified click to the browser, as any link does", async () => {
    const view = renderWithProviders(
      <CommentItem slug="p" issueNumber={7} comment={commentOf(12)} />,
    );
    const { id } = await waitFor(() => {
      const found = metaLinks(
        view.container,
        "/projects/p/issues/7#comment-12",
      );
      expect(found.id).toBeDefined();
      return found;
    });
    const before = view.router.state.location.pathname;
    // ⌘/Ctrl-click opens a background tab; the router must not swallow it, or
    // the href would be decoration over a handler.
    fireEvent.click(id as HTMLAnchorElement, { metaKey: true, button: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(view.router.state.location.pathname).toBe(before);
  });

  it("keeps the id and time on a hidden comment a reader revealed", async () => {
    const view = renderWithProviders(
      <CommentItem
        slug="p"
        issueNumber={7}
        comment={commentOf(12, { hidden_at: "2026-08-13T00:00:00Z" })}
        viewer={{ id: 1, isAdmin: false, role: "writer" }}
      />,
    );
    await waitFor(() => {
      expect(
        view.container.querySelectorAll(
          "a[href='/projects/p/issues/7#comment-12']",
        ),
      ).toHaveLength(2);
    });
    expectHeaderMeta(
      view.container,
      "/projects/p/issues/7#comment-12",
      12,
      CREATED,
    );
    const unhide = view.container.querySelector<HTMLButtonElement>(
      "[aria-label='unhide comment']",
    );
    expect(unhide).not.toBeNull();
    expect(unhide?.disabled).toBe(false);
  });
});

/**
 * A preview opened from another card — the case where reading the target off
 * the address bar would still produce a working-looking link, because comment
 * ids repeat across projects.
 */
describe("a comment preview's header (T-435)", () => {
  it("points at the previewed comment's own issue, not the page's", async () => {
    const view = renderWithProviders(
      <CommentHoverCard
        slug="elsewhere"
        issueNumber={99}
        comment={commentOf(12)}
      >
        <a href="/projects/elsewhere/issues/99#comment-12">preview</a>
      </CommentHoverCard>,
    );
    const card = await waitFor(() => {
      const el = view.container.querySelector(
        "[data-slot='hover-card-trigger']",
      );
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    card.dispatchEvent(
      new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }),
    );
    const content = await waitFor(() => {
      const el = document.querySelector("[data-slot='hover-card-content']");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expectHeaderMeta(
      content,
      "/projects/elsewhere/issues/99#comment-12",
      12,
      CREATED,
    );
    // Nothing on the card points at the page the preview was opened from.
    expect(content.querySelector("a[href^='/projects/p/']")).toBeNull();
  });

  it("gives a spec annotation preview the same pair, above its file row", async () => {
    const view = renderWithProviders(
      <SpecAnnotationHoverCard
        slug="elsewhere"
        issueNumber={99}
        annotation={annotationOf(4631)}
      >
        <a href="/projects/elsewhere/issues/99#comment-4631">preview</a>
      </SpecAnnotationHoverCard>,
    );
    const trigger = await waitFor(() => {
      const el = view.container.querySelector(
        "[data-slot='hover-card-trigger']",
      );
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    trigger.dispatchEvent(
      new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }),
    );
    const content = await waitFor(() => {
      const el = document.querySelector("[data-slot='hover-card-content']");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expectHeaderMeta(
      content,
      "/projects/elsewhere/issues/99#comment-4631",
      4631,
      CREATED,
    );
    // The anchor row the card exists for is still under the header, and the
    // file/line it names did not become the id's destination.
    expect(content.textContent).toContain("design.md");
    expect(content.textContent).toContain("L42–48");
    expect(content.querySelector("a[href*='/spec']")).toBeNull();
  });
});
