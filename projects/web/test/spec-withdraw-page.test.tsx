import type { QueryClient } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  Me,
  SpecFiles,
  SpecInfo,
  SpecReviewSubmitInput,
} from "@todou/shared";
import { toast } from "sonner";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { SpecReviewDraft } from "../src/lib/spec-drafts.ts";
import { router } from "../src/router.tsx";
import {
  renderOnTheAppRouter,
  restoreAppRouterPage,
  teardownAppRouter,
} from "./app-router.tsx";
import { cmGetValue, cmSetValue } from "./cm.ts";
import { testQueryClient } from "./render.tsx";
import { reviewViewport } from "./review-viewport.ts";

const ME: Me = {
  id: 9,
  login: "user",
  display_name: "User",
  kind: "human",
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: false,
  created_at: "2026-01-01T00:00:00Z",
};
const AUTHOR = {
  id: 2,
  login: "bot-one",
  display_name: "Bot One",
  kind: "machine" as const,
  avatar_url: null,
  owner: null,
};
const SUMMARY = "Keep this review summary\nincluding its second line";
const DRAFT: SpecReviewDraft = {
  id: "withdrawal-review-draft",
  anchor: {
    path: "design.md",
    version: 1,
    line_start: 3,
    line_end: 3,
    col_start: null,
    col_end: null,
  },
  quote: "A reviewable paragraph.",
  body: "Keep this staged annotation\nincluding its second line",
};
const COMMENTS = [
  {
    anchor: { path: "design.md", version: 1, line_start: 3, line_end: 3 },
    body: DRAFT.body,
  },
];

// Unique identities also isolate the production draft store's in-memory cache.
let nextIssue = 42800;
type FixtureOptions = {
  role?: "writer" | "reader" | "reporter";
  pusher?: boolean;
  status?: SpecInfo["review_status"];
  version?: number;
  viewedVersion?: number;
  staged?: boolean;
};

function pageFixture(options: FixtureOptions = {}) {
  const issueNumber = ++nextIssue;
  const base = `/projects/demo/issues/${issueNumber}`;
  const storageKey = `todou-spec-review:demo:${issueNumber}`;
  const project = {
    id: 1,
    slug: "demo",
    name: "Demo",
    description: "",
    created_at: "2026-01-01T00:00:00Z",
    viewer_role: options.role ?? "writer",
    former_slugs: [],
  };
  const version = options.version ?? 1;
  let spec: SpecInfo = {
    current_version: version,
    current_version_cursor: `c${version}`,
    review_status: options.status ?? "unreviewed",
    unresolved_comments: 0,
    unresolved_carried_comments: 0,
    files: [{ path: "design.md", size: 50 }],
    versions: Array.from({ length: version }, (_, index) => ({
      number: index + 1,
      author: options.pusher ? ME : AUTHOR,
      message: null,
      created_at: "2026-01-01T00:00:00Z",
    })),
  };
  const reads: string[] = [];
  const writes: Array<{ path: string; body: unknown }> = [];
  const reviews: SpecReviewSubmitInput[] = [];
  let reviewConflict: "withdrawn" | "newer" | null = null;

  function advance() {
    spec = {
      ...spec,
      current_version: 2,
      current_version_cursor: "c2",
      review_status: "unreviewed",
      versions: [
        ...spec.versions,
        {
          number: 2,
          author: AUTHOR,
          message: null,
          created_at: "2026-01-02T00:00:00Z",
        },
      ],
    };
  }
  const conflict = () =>
    Response.json(
      { error: { code: "conflict", message: "Spec changed during review" } },
      { status: 409 },
    );

  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw =
      typeof input === "string" || input instanceof URL
        ? String(input)
        : input.url;
    const url = new URL(raw, "http://localhost");
    const path = url.pathname.replace(/^\/api/, "");
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      const body: unknown = JSON.parse(String(init?.body));
      writes.push({ path, body });
      if (path === `${base}/spec/reviews`) {
        const review = body as SpecReviewSubmitInput;
        reviews.push(review);
        if (reviewConflict !== null) {
          if (reviewConflict === "newer") advance();
          else spec = { ...spec, review_status: "withdrawn" };
          reviewConflict = null;
          return conflict();
        }
        return Response.json(
          {
            event_id: 12,
            version: review.version,
            verdict: review.verdict,
            summary_comment_id: review.body ? 13 : null,
            comment_ids: review.comments.map((_, index) => 14 + index),
          },
          { status: 201 },
        );
      }
      throw new Error(`Unexpected write: ${method} ${path}`);
    }

    reads.push(`${path}${url.search}`);
    if (path === "/me") return Response.json(ME);
    if (path === "/version") return Response.json({ version: "test" });
    if (path === "/auth/mode") return Response.json({ mode: "local" });
    if (path === "/projects") return Response.json([project]);
    if (path === "/projects/demo") return Response.json(project);
    if (path === "/me/preferences" || path === "/me/prefs") {
      return Response.json({});
    }
    if (path === "/me/inbox") {
      return Response.json({ items: [], unread_count: 0, next_cursor: null });
    }
    if (path === "/me/reference-directory") {
      return Response.json({ entries: [], projects: [], users: [] });
    }
    if (path === "/me/unread-count" || path === "/inbox/count") {
      return Response.json({ count: 0 });
    }
    if (/\/(reference-config|references\/config)$/.test(path)) {
      return Response.json({
        format: { prefix: "T-", history: [] },
        autolinks: [],
      });
    }
    if (/\/(members|labels|statuses)$/.test(path)) return Response.json([]);
    if (path === base) {
      return Response.json({
        number: issueNumber,
        title: "Withdrawal regression fixture",
        spec_version: spec.current_version,
      });
    }
    if (path === `${base}/spec`) return Response.json(spec);
    if (path === `${base}/spec/comments`) {
      return Response.json({
        current_version: spec.current_version,
        items: [],
      });
    }
    if (path === `${base}/spec/files`) {
      const requestedVersion = Number(
        url.searchParams.get("version") ?? spec.current_version,
      );
      const files: SpecFiles = {
        version: requestedVersion,
        files: [
          {
            path: "design.md",
            body: `# Version ${requestedVersion}\n\nA reviewable paragraph.\n`,
            size: 50,
          },
        ],
      };
      return Response.json(files);
    }
    throw new Error(`Unexpected read: ${path}${url.search}`);
  });

  return {
    issueNumber,
    base,
    storageKey,
    fetch,
    reads,
    writes,
    reviews,
    advance,
    setStatus(review_status: SpecInfo["review_status"]) {
      spec = { ...spec, review_status };
    },
    specReads: () => reads.filter((path) => path === `${base}/spec`).length,
    conflictOnReview(next: "withdrawn" | "newer") {
      reviewConflict = next;
    },
  };
}

const mountedPages: Array<{
  unmount: () => void;
  clear: () => void;
  storageKey: string;
}> = [];

afterEach(() => {
  for (const page of mountedPages.splice(0)) {
    page.unmount();
    page.clear();
    localStorage.removeItem(page.storageKey);
  }
  restoreAppRouterPage();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(teardownAppRouter);

async function mountPage(options: FixtureOptions = {}) {
  const fixture = pageFixture(options);
  vi.stubGlobal("fetch", fixture.fetch);
  if (options.staged) {
    localStorage.setItem(fixture.storageKey, JSON.stringify([DRAFT]));
  }
  const client = testQueryClient();
  // A new dialog observer or close/reopen must not accidentally rescue missing
  // 409 invalidation with a stale-on-mount refetch.
  client.setDefaultOptions({
    queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    mutations: { retry: false },
  });
  // The singleton app router can leave navigate pending between unmounted
  // trees. As in startAtDraftPage, mount first and await the rendered page.
  void router
    .navigate({
      to: "/projects/$slug/issues/$number/spec",
      params: { slug: "demo", number: String(fixture.issueNumber) },
      search: { file: "design.md", v: options.viewedVersion },
      replace: true,
      ignoreBlocker: true,
    })
    .catch(() => undefined);
  const mounted = renderOnTheAppRouter(client);
  mountedPages.push({
    unmount: mounted.unmount,
    clear: () => client.clear(),
    storageKey: fixture.storageKey,
  });
  await screen.findByRole(
    "button",
    { name: /finish review/i },
    { timeout: 4000 },
  );
  await waitFor(() =>
    expect(client.getQueryState(["project", "demo"])?.status).toBe("success"),
  );
  return { ...fixture, client };
}

async function openReview() {
  fireEvent.click(screen.getByRole("button", { name: /finish review/i }));
  return screen.findByRole("dialog", { name: "Finish review — spec v1" });
}

function expectDrafts(dialog: HTMLElement, storageKey: string) {
  expect(
    dialog.isConnected,
    "failed review must retain its open draft dialog",
  ).toBe(true);
  expect(cmGetValue(dialog)).toBe(SUMMARY);
  expect(within(dialog).getByText(DRAFT.body.split("\n")[0])).toBeTruthy();
  expect(JSON.parse(localStorage.getItem(storageKey) ?? "null")).toEqual([
    DRAFT,
  ]);
}

function controls(width: number) {
  const dialog = within(
    screen.getByRole("dialog", { name: "Finish review — spec v1" }),
  );
  if (width >= 640) {
    expect(dialog.getByRole("button", { name: "Cancel" })).toBeTruthy();
  } else {
    expect(dialog.queryByRole("button", { name: "Cancel" })).toBeNull();
  }
  return {
    comment: dialog.getByRole("button", { name: "Comment" }),
    changes: dialog.getByRole("button", { name: "Request changes" }),
    approve: dialog.getByRole("button", { name: "Approve" }),
  };
}

function expectDisabled(element: HTMLElement, disabled: boolean) {
  expect(
    element.hasAttribute("disabled") ||
      element.getAttribute("aria-disabled") === "true",
  ).toBe(disabled);
}

type RefreshedPage = {
  client: QueryClient;
  issueNumber: number;
  specReads: () => number;
};

async function expectRefreshed(
  page: RefreshedPage,
  before: number,
  version: number,
  status: SpecInfo["review_status"],
) {
  await waitFor(() => {
    expect(page.specReads()).toBeGreaterThan(before);
    expect(
      page.client.getQueryData(["spec", "demo", page.issueNumber]),
    ).toMatchObject({
      current_version: version,
      review_status: status,
    });
    expect(page.client.isFetching()).toBe(0);
  });
}

describe("withdrawal on the actual SpecViewPage and review session", () => {
  it.each([true, false])(
    "does not offer withdrawal to a writer (pusher=%s)",
    async (pusher) => {
      const page = await mountPage({ pusher });
      expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
      expect(page.writes).toHaveLength(0);
    },
  );

  it.each(["reader", "reporter"] as const)(
    "does not offer withdrawal to a %s, even the pusher",
    async (role) => {
      const page = await mountPage({ role, pusher: true });
      expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
      expect(page.writes).toHaveLength(0);
    },
  );

  it.each([
    { status: "approved" as const },
    { status: "withdrawn" as const },
    { status: "changes_requested" as const },
    { version: 2, viewedVersion: 1 },
  ])("has no withdrawal entry for spec state %j", async (options) => {
    await mountPage(options);
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
  });

  for (const width of [639, 640]) {
    it.each(["empty", "summary", "annotation"] as const)(
      `at ${width}px withdrawn review disables both verdicts; Comment requires content (%s)`,
      async (content) => {
        reviewViewport(width);
        const page = await mountPage({
          status: "withdrawn",
          staged: content === "annotation",
        });
        const dialog = await openReview();
        act(() => cmSetValue(dialog, content === "summary" ? SUMMARY : " \n "));
        const actions = controls(width);
        expectDisabled(actions.comment, content === "empty");
        for (const verdict of [actions.changes, actions.approve]) {
          expectDisabled(verdict, true);
          expect(verdict.title).toBe("This spec has been withdrawn");
          fireEvent.click(verdict);
          fireEvent.keyDown(verdict, { key: "Enter" });
        }
        if (content === "empty") fireEvent.click(actions.comment);
        await act(async () => {});
        expect(page.writes).toHaveLength(0);
      },
    );

    it(`at ${width}px a server-driven withdrawal updates an open review and retains both drafts`, async () => {
      reviewViewport(width);
      const page = await mountPage({ staged: true });
      const dialog = await openReview();
      act(() => cmSetValue(dialog, SUMMARY));
      const before = page.specReads();
      page.setStatus("withdrawn");
      await act(async () => {
        await page.client.invalidateQueries({
          queryKey: ["spec", "demo", page.issueNumber],
        });
      });
      await expectRefreshed(page, before, 1, "withdrawn");
      expectDrafts(dialog, page.storageKey);
      const actions = controls(width);
      expectDisabled(actions.comment, false);
      for (const verdict of [actions.changes, actions.approve]) {
        expectDisabled(verdict, true);
        expect(verdict.title).toBe("This spec has been withdrawn");
        fireEvent.click(verdict);
      }
      await act(async () => {});
      expect(page.writes).toHaveLength(0);
    });

    it(`at ${width}px the real provider refreshes on 409, retains both drafts, and Comments on the withdrawn version`, async () => {
      reviewViewport(width);
      const page = await mountPage({ staged: true });
      const errorToast = vi.spyOn(toast, "error");
      const dialog = await openReview();
      act(() => cmSetValue(dialog, SUMMARY));
      expectDrafts(dialog, page.storageKey);
      const before = page.specReads();
      page.conflictOnReview("withdrawn");
      const initial = controls(width);
      const verdict = width < 640 ? "request_changes" : "approve";
      fireEvent.click(width < 640 ? initial.changes : initial.approve);
      await expectRefreshed(page, before, 1, "withdrawn");
      expect(errorToast).toHaveBeenCalledWith("Spec changed during review");
      expectDrafts(dialog, page.storageKey);
      expect(page.reviews).toEqual([
        { version: 1, verdict, body: SUMMARY, comments: COMMENTS },
      ]);

      const refreshed = controls(width);
      expectDisabled(refreshed.changes, true);
      expectDisabled(refreshed.approve, true);
      expectDisabled(refreshed.comment, false);
      const beforeComment = page.specReads();
      fireEvent.click(refreshed.comment);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await expectRefreshed(page, beforeComment, 1, "withdrawn");
      expect(page.reviews).toEqual([
        { version: 1, verdict, body: SUMMARY, comments: COMMENTS },
        { version: 1, verdict: "comment", body: SUMMARY, comments: COMMENTS },
      ]);
      expect(page.writes.map((write) => write.path)).toEqual([
        `${page.base}/spec/reviews`,
        `${page.base}/spec/reviews`,
      ]);
      expect(localStorage.getItem(page.storageKey)).toBeNull();
      const empty = await openReview();
      expect(cmGetValue(empty)).toBe("");
      expect(within(empty).queryByText(DRAFT.body.split("\n")[0])).toBeNull();
    });

    it(`at ${width}px a newer-version 409 cannot retarget retained drafts, even after close/reopen`, async () => {
      reviewViewport(width);
      const page = await mountPage({ staged: true });
      const errorToast = vi.spyOn(toast, "error");
      let dialog = await openReview();
      act(() => cmSetValue(dialog, SUMMARY));
      const before = page.specReads();
      page.conflictOnReview("newer");
      fireEvent.click(controls(width).approve);
      await expectRefreshed(page, before, 2, "unreviewed");
      expect(errorToast).toHaveBeenCalledWith("Spec changed during review");
      // Without a pinned session version the refreshed page silently offers a
      // v2 review with the v1 summary and annotation; closing must not reset it.
      dialog = await screen.findByRole("dialog", {
        name: "Finish review — spec v1",
      });
      expectDrafts(dialog, page.storageKey);
      expect(within(dialog).getByRole("status").textContent).toContain(
        "Spec v1 is no longer current",
      );
      fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      dialog = await openReview();
      expectDrafts(dialog, page.storageKey);
      expect(within(dialog).getByRole("status").textContent).toContain(
        "Spec v1 is no longer current",
      );
      const actions = controls(width);
      for (const action of [
        actions.comment,
        actions.changes,
        actions.approve,
      ]) {
        expectDisabled(action, true);
        fireEvent.click(action);
        fireEvent.keyDown(action, { key: "Enter" });
      }
      await act(async () => {});
      expect(page.reviews).toEqual([
        { version: 1, verdict: "approve", body: SUMMARY, comments: COMMENTS },
      ]);
      expect(page.writes).toHaveLength(1);
      expectDrafts(dialog, page.storageKey);
    });

    it(`at ${width}px a live newer-version refresh disables an open review before any submission`, async () => {
      reviewViewport(width);
      const page = await mountPage({ staged: true });
      const dialog = await openReview();
      act(() => cmSetValue(dialog, SUMMARY));
      const before = page.specReads();
      page.advance();
      // Model the cache invalidation performed by SSE. The 409 cases above
      // deliberately never invalidate from test code.
      await act(async () => {
        await page.client.invalidateQueries({
          queryKey: ["spec", "demo", page.issueNumber],
        });
      });
      await expectRefreshed(page, before, 2, "unreviewed");
      const retained = await screen.findByRole("dialog", {
        name: "Finish review — spec v1",
      });
      expectDrafts(retained, page.storageKey);
      const actions = controls(width);
      for (const action of [
        actions.comment,
        actions.changes,
        actions.approve,
      ]) {
        expectDisabled(action, true);
        fireEvent.click(action);
      }
      await act(async () => {});
      expect(page.writes).toHaveLength(0);
    });
  }
});
