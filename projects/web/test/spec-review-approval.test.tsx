import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { SpecInfo, UserRef } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { meQuery } from "../src/api/queries.ts";
import { specQuery, viewerApprovedCurrentRound } from "../src/api/spec.ts";
import { ReviewSubmitDialog } from "../src/components/spec/review-submit.tsx";
import type { SpecReviewDraft } from "../src/lib/spec-drafts.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";
import { reviewViewport } from "./review-viewport.ts";

// Same reader, pusher, version and staged comment as spec-review-web.test.tsx.
const READER: UserRef = {
  id: 5,
  login: "user",
  display_name: "User",
  kind: "human",
  avatar_url: null,
  owner: null,
};
const PUSHER: UserRef = {
  id: 7,
  login: "claude-agent",
  display_name: "Claude Agent",
  kind: "machine",
  avatar_url: null,
  owner: null,
};
const DRAFT: SpecReviewDraft = {
  id: "d1",
  anchor: {
    path: "design.md",
    version: 3,
    line_start: 3,
    line_end: 4,
    col_start: null,
    col_end: null,
  },
  quote: "…",
  body: "Which diff library?",
};
const APPROVED_TITLE =
  "You already approved this spec in the current review round";
const PUSHER_TITLE =
  "You pushed this version — its verdict has to come from someone else";
const WITHDRAWN_TITLE = "This spec has been withdrawn";
const STALE_TITLE =
  "Spec v3 is no longer current. Your review draft has been kept.";

function specInfo(overrides: Partial<SpecInfo> = {}): SpecInfo {
  return {
    current_version: 3,
    current_version_cursor: "cv3",
    review_status: "approved",
    viewer_review: { user_id: READER.id, approved_in_current_round: true },
    unresolved_comments: 0,
    unresolved_carried_comments: 0,
    files: [{ path: "design.md", size: 10 }],
    versions: [
      {
        number: 3,
        author: PUSHER,
        message: null,
        created_at: "2026-09-07T00:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function pushedByReader(): SpecInfo["versions"] {
  return specInfo().versions.map((version) => ({ ...version, author: READER }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function mount(
  info: SpecInfo,
  {
    drafts = [DRAFT],
    summary = "",
  }: { drafts?: SpecReviewDraft[]; summary?: string } = {},
) {
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && url.endsWith("/api/me")) {
      return Response.json(READER);
    }
    if (method === "GET" && url.endsWith("/issues/23/spec")) {
      // JSON serialization really omits viewer_review for old-server fixtures.
      return Response.json(info);
    }
    throw new Error(`unstubbed request: ${method} ${url}`);
  });
  const client = testQueryClient();
  // Finish the real query functions before mounting: enabled assertions must
  // not win a race against the reads which supply the two approval identities.
  await Promise.all([
    client.fetchQuery(meQuery),
    client.fetchQuery(specQuery("p", 23)),
  ]);
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  renderWithProviders(
    <ReviewSubmitDialog
      slug="p"
      issueNumber={23}
      currentVersion={3}
      drafts={drafts}
      summary={summary}
      open
      onClose={onClose}
      onSubmit={onSubmit}
    />,
    client,
  );
  await screen.findByRole("dialog");
  return { onSubmit, onClose };
}

async function actions(width: number) {
  if (width < 640 && screen.queryByRole("menu") === null) {
    const trigger = screen.getByRole("button", { name: "Submit" });
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    await screen.findByRole("menu");
  }
  const role = width < 640 ? "menuitem" : "button";
  return {
    approve: screen.getByRole(role, { name: "Approve" }),
    request: screen.getByRole(role, { name: "Request changes" }),
    comment: screen.getByRole(role, {
      name: width < 640 ? "Comment only" : "Comment",
    }),
  };
}

function expectDisabled(element: HTMLElement, disabled: boolean) {
  if (element.getAttribute("role") === "menuitem") {
    expect(element.getAttribute("aria-disabled") === "true").toBe(disabled);
    expect(element.hasAttribute("data-disabled")).toBe(disabled);
  } else {
    expect(element.tagName).toBe("BUTTON");
    expect((element as HTMLButtonElement).disabled).toBe(disabled);
  }
}

// These are mutation counterexamples, not just helper checks:
// - Folding personal approval into verdictDisabled breaks request_changes.
// - Treating review_status as personal approval breaks both disagreeing states.
// - Removing desktop buttons (or keeping only the menu) fails the 640/1280 cases.
// Exercise both layouts and both sides of the sm boundary with visible roles.
describe.each([390, 639, 640, 1280])("personal approval at %ipx", (width) => {
  it("preserves the visible verdict controls for this breakpoint", async () => {
    reviewViewport(width);
    const { onClose } = await mount(specInfo());
    if (width < 640) {
      expect(screen.getByRole("button", { name: "Submit" })).toBeTruthy();
      for (const name of ["Cancel", "Comment", "Request changes", "Approve"]) {
        expect(screen.queryByRole("button", { name })).toBeNull();
      }
      await actions(width);
      expect(
        screen.getAllByRole("menuitem").map((item) => item.textContent),
      ).toEqual(["Comment only", "Request changes", "Approve"]);
    } else {
      for (const name of ["Cancel", "Comment", "Request changes", "Approve"]) {
        expect(screen.getByRole("button", { name })).toBeTruthy();
      }
      expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
      expect(screen.queryByRole("menuitem")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onClose).toHaveBeenCalledTimes(1);
    }
  });

  it.each(["approved", "unreviewed"] as const)(
    "personal true disables only Approve when global status is %s",
    async (review_status) => {
      reviewViewport(width);
      const { onSubmit } = await mount(specInfo({ review_status }));
      const { approve, request, comment } = await actions(width);
      expectDisabled(approve, true);
      expect(approve.title).toBe(APPROVED_TITLE);
      expectDisabled(request, false);
      expect(request.title).toBe("");
      expectDisabled(comment, false);
      expect(comment.title).toBe("");

      fireEvent.click(approve);
      await act(async () => {});
      expect(onSubmit).not.toHaveBeenCalled();

      // A real activation must reach the session seam even after approval.
      fireEvent.click(request);
      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledExactlyOnceWith("request_changes"),
      );
      const reopened = await actions(width);
      fireEvent.click(reopened.comment);
      await waitFor(() =>
        expect(onSubmit.mock.calls).toEqual([["request_changes"], ["comment"]]),
      );
    },
  );

  it.each([
    {
      name: "the current viewer has not approved this round",
      viewer_review: { user_id: READER.id, approved_in_current_round: false },
    },
    {
      name: "approval belongs to another viewer",
      viewer_review: { user_id: PUSHER.id, approved_in_current_round: true },
    },
    { name: "an older response omits viewer_review", viewer_review: undefined },
  ])(
    "global approved still permits Approve when $name",
    async ({ viewer_review }) => {
      reviewViewport(width);
      const { onSubmit } = await mount(specInfo({ viewer_review }));
      const { approve, request, comment } = await actions(width);
      expectDisabled(approve, false);
      expect(approve.title).toBe("");
      expectDisabled(request, false);
      expectDisabled(comment, false);
      fireEvent.click(approve);
      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledExactlyOnceWith("approve"),
      );
    },
  );

  it("a current-version mismatch still rejects every action through the stale gate", async () => {
    reviewViewport(width);
    const { onSubmit } = await mount(specInfo({ current_version: 4 }));
    expect(screen.getByRole("status").textContent).toBe(STALE_TITLE);
    const { approve, request, comment } = await actions(width);
    for (const control of [approve, request, comment]) {
      expectDisabled(control, true);
      expect(control.title).toBe(STALE_TITLE);
      fireEvent.click(control);
    }
    await act(async () => {});
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe.each([390, 640])("T-428 title precedence at %ipx", (width) => {
  it.each([
    {
      name: "withdrawn",
      withdrawn: true,
      pusher: false,
      title: WITHDRAWN_TITLE,
    },
    { name: "pusher", withdrawn: false, pusher: true, title: PUSHER_TITLE },
    {
      name: "withdrawn pusher",
      withdrawn: true,
      pusher: true,
      title: WITHDRAWN_TITLE,
    },
  ])(
    "$name takes precedence over personal approval and allows comments",
    async ({ withdrawn, pusher, title }) => {
      reviewViewport(width);
      const { onSubmit } = await mount(
        specInfo({
          review_status: withdrawn ? "withdrawn" : "approved",
          versions: pusher ? pushedByReader() : specInfo().versions,
        }),
      );
      const { approve, request, comment } = await actions(width);
      for (const control of [approve, request]) {
        expectDisabled(control, true);
        expect(control.title).toBe(title);
        fireEvent.click(control);
      }
      await act(async () => {});
      expect(onSubmit).not.toHaveBeenCalled();
      expectDisabled(comment, false);
      expect(comment.title).toBe("");
      fireEvent.click(comment);
      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledExactlyOnceWith("comment"),
      );
    },
  );

  it("allows a summary-only comment from an approved pusher on a withdrawn spec", async () => {
    reviewViewport(width);
    const { onSubmit } = await mount(
      specInfo({ review_status: "withdrawn", versions: pushedByReader() }),
      { drafts: [], summary: "Please keep this clarification." },
    );
    const { comment } = await actions(width);
    expectDisabled(comment, false);
    fireEvent.click(comment);
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith("comment"),
    );
  });

  it("an approved viewer still cannot submit an empty comment", async () => {
    reviewViewport(width);
    const { onSubmit } = await mount(specInfo(), {
      drafts: [],
      summary: "   ",
    });
    const { comment, request } = await actions(width);
    expectDisabled(comment, true);
    expect(comment.title).toBe("Write a summary or stage a comment first");
    fireEvent.click(comment);
    await act(async () => {});
    expect(onSubmit).not.toHaveBeenCalled();
    expectDisabled(request, false);
    fireEvent.click(request);
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith("request_changes"),
    );
  });
});

describe("viewerApprovedCurrentRound", () => {
  it("requires the current version as well as the current viewer", () => {
    const info = specInfo();
    expect(viewerApprovedCurrentRound(info, READER.id, 3)).toBe(true);
    // The dialog's stale gate disables Approve here, so its disabled state
    // alone cannot prove that the personal-approval derivation rejected v4.
    expect(viewerApprovedCurrentRound(info, READER.id, 4)).toBe(false);
    expect(
      viewerApprovedCurrentRound(
        specInfo({ current_version: 4 }),
        READER.id,
        3,
      ),
    ).toBe(false);
    expect(viewerApprovedCurrentRound(info, PUSHER.id, 3)).toBe(false);
    expect(viewerApprovedCurrentRound(info, undefined, 3)).toBe(false);
  });

  it("does not infer personal approval from a global approved status or absent data", () => {
    expect(
      viewerApprovedCurrentRound(
        specInfo({ viewer_review: undefined }),
        READER.id,
        3,
      ),
    ).toBe(false);
    expect(
      viewerApprovedCurrentRound(
        specInfo({
          viewer_review: {
            user_id: READER.id,
            approved_in_current_round: false,
          },
        }),
        READER.id,
        3,
      ),
    ).toBe(false);
    expect(viewerApprovedCurrentRound(null, READER.id, 3)).toBe(false);
    expect(viewerApprovedCurrentRound(undefined, READER.id, 3)).toBe(false);
  });
});
