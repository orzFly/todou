import type { QueryClient } from "@tanstack/react-query";
import type { HistoryState } from "@tanstack/react-router";
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
  /** The baseline the address pins, read in the rendered view. */
  compare?: number;
  staged?: boolean;
  /** `GET …/spec` answers 404 until the first `advance()`, which pushes v1. */
  absent?: boolean;
  /** History state the page is opened with, as a link's return state is. */
  state?: Record<string, unknown>;
  /**
   * The test client's cache already holds the spec at this version when the
   * page is opened, as a visit earlier in the session would have left it.
   */
  cached?: number;
  /** The cached spec is stale, so opening the page refetches it. */
  staleCache?: boolean;
  /** `GET …/spec` answers 500. */
  specFails?: boolean;
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
  const specAt = (version: number): SpecInfo => ({
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
  });
  let spec = specAt(options.version ?? 1);
  let absent = options.absent ?? false;
  const reads: string[] = [];
  const writes: Array<{ path: string; body: unknown }> = [];
  const reviews: SpecReviewSubmitInput[] = [];
  let reviewConflict: "withdrawn" | "newer" | null = null;

  /** An agent pushes the next version. */
  function advance() {
    if (absent) {
      absent = false;
      return;
    }
    const next = spec.current_version + 1;
    spec = {
      ...spec,
      current_version: next,
      current_version_cursor: `c${next}`,
      review_status: "unreviewed",
      versions: [
        ...spec.versions,
        {
          number: next,
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
    if (path === `${base}/spec`) {
      if (options.specFails) {
        return Response.json(
          { error: { code: "internal", message: "boom" } },
          { status: 500 },
        );
      }
      if (absent) {
        return Response.json(
          { error: { code: "not_found", message: "no spec" } },
          { status: 404 },
        );
      }
      return Response.json(spec);
    }
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
    specAt,
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
  if (options.cached !== undefined) {
    const key = ["spec", "demo", fixture.issueNumber];
    client.setQueryData(key, fixture.specAt(options.cached));
    // Staleness by age cannot reach a client whose staleTime is infinite.
    if (options.staleCache)
      client.getQueryCache().find({ queryKey: key })?.invalidate();
  }
  // The singleton app router can leave navigate pending between unmounted
  // trees. As in startAtDraftPage, mount first and await the rendered page.
  void router
    .navigate({
      to: "/projects/$slug/issues/$number/spec",
      params: { slug: "demo", number: String(fixture.issueNumber) },
      search: {
        file: "design.md",
        v: options.viewedVersion,
        ...(options.compare === undefined
          ? {}
          : { compare: options.compare, view: "rendered" as const }),
      },
      replace: true,
      ignoreBlocker: true,
      ...(options.state === undefined
        ? {}
        : { state: options.state as HistoryState }),
    })
    .catch(() => undefined);
  const mounted = renderOnTheAppRouter(client);
  mountedPages.push({
    unmount: mounted.unmount,
    clear: () => client.clear(),
    storageKey: fixture.storageKey,
  });
  if (options.absent) {
    await screen.findByText(
      "This issue has no spec yet.",
      {},
      { timeout: 4000 },
    );
  } else {
    await screen.findByRole(
      "button",
      { name: /finish review/i },
      { timeout: 4000 },
    );
  }
  await waitFor(() =>
    expect(client.getQueryState(["project", "demo"])?.status).toBe("success"),
  );
  return { ...fixture, client };
}

async function openReview(version = 1) {
  fireEvent.click(screen.getByRole("button", { name: /finish review/i }));
  return screen.findByRole("dialog", {
    name: `Finish review — spec v${version}`,
  });
}

/** Switches the page to another version, as the version picker does. */
async function viewVersion(page: { issueNumber: number }, v: number) {
  void router
    .navigate({
      to: "/projects/$slug/issues/$number/spec",
      params: { slug: "demo", number: String(page.issueNumber) },
      search: { file: "design.md", v },
    })
    .catch(() => undefined);
  await waitFor(() => expect(router.state.location.search.v).toBe(v));
  await waitFor(() => expect(shownTitle()).toBe(`Version ${v}`));
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

    it(`at ${width}px after a newer-version 409 the page stays on v1 and a review reopened on v2 keeps the drafts`, async () => {
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
      // The page stays on v1, so the open form still reviews v1 and is stale.
      dialog = await screen.findByRole("dialog", {
        name: "Finish review — spec v1",
      });
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
      fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expectDisabled(
        screen.getByRole("button", { name: /finish review/i }),
        true,
      );

      await viewVersion(page, 2);
      dialog = await openReview(2);
      expectDrafts(dialog, page.storageKey);
      expectDisabled(
        within(dialog).getByRole("button", { name: "Comment" }),
        false,
      );
      expectDisabled(
        within(dialog).getByRole("button", { name: "Approve" }),
        false,
      );
      expect(page.writes).toHaveLength(1);
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

/**
 * The document's heading as the version on screen spells it. A version past
 * the first is compared with the one before, and its heading carries that
 * one's text as a deletion.
 */
function shownTitle() {
  const heading = document.querySelector("main h1");
  if (heading === null) return null;
  const shown = heading.cloneNode(true) as HTMLElement;
  for (const removed of shown.querySelectorAll("del")) removed.remove();
  return shown.textContent;
}

/** An agent pushes, and the SSE feed invalidates the spec as it would. */
async function pushNext(page: RefreshedPage & { advance: () => void }) {
  const before = page.specReads();
  page.advance();
  await act(async () => {
    await page.client.invalidateQueries({
      queryKey: ["spec", "demo", page.issueNumber],
    });
  });
  return before;
}

describe("the spec page reads the version its URL names", () => {
  it("pins the first version of a spec pushed while the empty state is open", async () => {
    const page = await mountPage({ absent: true, state: { origin: "kept" } });
    expect(router.state.location.search.v).toBeUndefined();
    const entries = window.history.length;

    await pushNext(page);
    await waitFor(() => expect(router.state.location.search.v).toBe(1));
    await waitFor(() => expect(shownTitle()).toBe("Version 1"));
    // In place: no entry to step back onto, and the way back kept.
    expect(window.history.length).toBe(entries);
    expect(router.state.location.state).toMatchObject({ origin: "kept" });
  });

  it("offers Finish review on the current version only", async () => {
    reviewViewport(640);
    const page = await mountPage({ viewedVersion: 1 });
    const before = await pushNext(page);
    await expectRefreshed(page, before, 2, "unreviewed");
    const stale = screen.getByRole("button", { name: /finish review/i });
    expectDisabled(stale, true);
    expect(stale.getAttribute("aria-label")).toContain(
      "Only the current version can be reviewed",
    );
    // A disabled button gets no hover, so the reason is on its wrapper too.
    expect(
      stale
        .closest('[data-toolbar-slot="finish-review"]')
        ?.getAttribute("title"),
    ).toBe("Only the current version can be reviewed");
    fireEvent.click(stale);
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();

    await viewVersion(page, 2);
    expectDisabled(
      screen.getByRole("button", { name: /finish review/i }),
      false,
    );
    const dialog = await openReview(2);
    expectDisabled(
      within(dialog).getByRole("button", { name: "Approve" }),
      false,
    );
    expect(page.writes).toHaveLength(0);
  });

  it("takes a version ahead of the cached spec for the current one", async () => {
    // Opened from a version card before the refetch of the push that
    // replaced a withdrawn v1 has landed.
    const page = await mountPage({ version: 2, cached: 1, viewedVersion: 2 });
    act(() => {
      page.client.setQueryData(["spec", "demo", page.issueNumber], {
        ...page.specAt(1),
        review_status: "withdrawn",
      });
    });
    await waitFor(() => expect(shownTitle()).toBe("Version 2"));
    const finish = screen.getByRole("button", { name: /finish review/i });
    expectDisabled(finish, false);
    expect(document.querySelector("[data-old-version-notice]")).toBeNull();
    const status = document.querySelector(
      '[data-toolbar-slot="review-status"]',
    )?.textContent;
    expect(status).toBeTruthy();
    expect(status).not.toBe("old version");
    const dialog = await openReview(2);
    expect(within(dialog).queryByRole("status")).toBeNull();
    const approve = within(dialog).getByRole("button", { name: "Approve" });
    expectDisabled(approve, false);
    expect(approve.title).toBe("");
  });

  it("marks an older version and leads to the current one from a notice", async () => {
    await mountPage({ version: 2, viewedVersion: 1 });
    const slot = () =>
      document.querySelector('[data-toolbar-slot="review-status"]');
    expect(slot()?.textContent).toBe("old version");
    // Named by its words alone: the arrow is decoration.
    const link = screen.getByRole("link", {
      name: "This is an old version. Latest: v2",
    });
    expect(link.matches("[data-old-version-notice]")).toBe(true);
    const href = new URL(link.getAttribute("href") ?? "", "http://localhost");
    expect(href.searchParams.get("v")).toBe("2");
    expect(href.searchParams.get("file")).toBe("design.md");

    fireEvent.click(link);
    await waitFor(() => expect(router.state.location.search.v).toBe(2));
    await waitFor(() => expect(shownTitle()).toBe("Version 2"));
    expect(slot()?.textContent).toBe("awaiting review");
    expect(document.querySelector("[data-old-version-notice]")).toBeNull();
  });

  it("keeps the comparison the reader pinned on the way to the latest", async () => {
    await mountPage({ version: 3, viewedVersion: 2, compare: 1 });
    const link = await screen.findByRole("link", {
      name: "This is an old version. Latest: v3",
    });
    const href = new URL(link.getAttribute("href") ?? "", "http://localhost");
    expect(Object.fromEntries(href.searchParams)).toEqual({
      file: "design.md",
      v: "3",
      compare: "1",
      view: "rendered",
    });
  });
});

describe("an address without a version", () => {
  it("pins a fresh cache's version on the first frame, without asking the server", async () => {
    const page = await mountPage({ version: 2, cached: 2 });
    expect(shownTitle()).toBe("Version 2");
    await waitFor(() => expect(router.state.location.search.v).toBe(2));
    expect(page.specReads()).toBe(0);
  });

  it("pins what the refetch of a stale cache lands on", async () => {
    const page = await mountPage({ version: 2, cached: 1, staleCache: true });
    await waitFor(() => expect(router.state.location.search.v).toBe(2));
    await waitFor(() => expect(shownTitle()).toBe("Version 2"));
    expect(page.specReads()).toBe(1);
    expect(document.querySelector("[data-old-version-notice]")).toBeNull();
  });

  it("pins a stale cache when its refetch fails", async () => {
    await mountPage({
      version: 2,
      cached: 1,
      staleCache: true,
      specFails: true,
    });
    await waitFor(() => expect(router.state.location.search.v).toBe(1));
    expect(shownTitle()).toBe("Version 1");
    expect(screen.queryByText("Couldn't load this spec.")).toBeNull();
  });

  it("pins in place, keeping the entry and its history state", async () => {
    const entries = window.history.length;
    await mountPage({
      version: 2,
      cached: 1,
      staleCache: true,
      state: { origin: "kept" },
    });
    await waitFor(() => expect(router.state.location.search.v).toBe(2));
    expect(window.history.length).toBe(entries);
    expect(router.state.location.state).toMatchObject({ origin: "kept" });
  });

  it("keeps the pinned version through a push", async () => {
    const page = await mountPage({ version: 2 });
    await waitFor(() => expect(router.state.location.search.v).toBe(2));
    await waitFor(() => expect(shownTitle()).toBe("Version 2"));

    const before = await pushNext(page);
    await expectRefreshed(page, before, 3, "unreviewed");
    expect(shownTitle()).toBe("Version 2");
    expect(page.reads).not.toContain(`${page.base}/spec/files?version=3`);
    expect(router.state.location.search.v).toBe(2);
  });
});
