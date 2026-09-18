import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import {
  SpecReviewSessionProvider,
  useSpecReviewSession,
} from "../src/components/spec/spec-review-session-provider.tsx";
import {
  confirmSubmittedSpecReviewDrafts,
  type SpecReviewDraft,
  useSpecReviewDrafts,
} from "../src/lib/spec-drafts.ts";

import { testQueryClient } from "./render.tsx";

const original: SpecReviewDraft = {
  id: "draft-one",
  anchor: {
    path: "proposal.md",
    version: 1,
    line_start: 2,
    line_end: 2,
    col_start: null,
    col_end: null,
  },
  quote: "the anchor",
  body: "first body",
};

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

function DraftHarness({ slug }: { slug: string }) {
  const drafts = useSpecReviewDrafts(slug, 7);
  return (
    <div>
      <output data-testid="drafts">{JSON.stringify(drafts.drafts)}</output>
      <button
        type="button"
        onClick={() =>
          drafts.update(original.id, { ...original, body: "edited later" })
        }
      >
        edit
      </button>
      <button
        type="button"
        onClick={() => drafts.add({ ...original, body: "new while pending" })}
      >
        add
      </button>
      <button
        type="button"
        onClick={() => confirmSubmittedSpecReviewDrafts(slug, 7, [original])}
      >
        confirm
      </button>
    </div>
  );
}

function held<T>() {
  let release: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, rejectPromise) => {
    release = resolve;
    reject = rejectPromise;
  });
  return { promise, release, reject };
}

function SessionHarness() {
  const { state, session, submitReview } = useSpecReviewSession("reentry", 7);
  const drafts = useSpecReviewDrafts("reentry", 7);
  return (
    <div>
      <output data-testid="session-drafts">
        {JSON.stringify(drafts.drafts)}
      </output>
      <output data-testid="session-summary">{state.summary}</output>
      <output data-testid="session-pending">
        {state.pending?.verdict ?? "idle"}
      </output>
      <button
        type="button"
        onClick={() =>
          submitReview({
            currentVersion: 1,
            verdict: "comment",
            drafts: drafts.drafts,
          })
        }
      >
        submit
      </button>
      <button type="button" onClick={() => drafts.add(original)}>
        stage original
      </button>
      <button
        type="button"
        onClick={() => session.setSummary("new visit summary")}
      >
        write new summary
      </button>
    </div>
  );
}

function renderReentrySession() {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
    component: () => (
      <SpecReviewSessionProvider>
        <Outlet />
      </SpecReviewSessionProvider>
    ),
  });
  const projectRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects/$slug",
    component: () => <Outlet />,
  });
  const issueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number",
    component: () => <div>issue detail</div>,
  });
  const specRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number/spec",
    component: SessionHarness,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([
        projectRoute.addChildren([issueRoute, specRoute]),
      ]),
    ]),
    history: createMemoryHistory({
      initialEntries: ["/projects/reentry/issues/7/spec"],
    }),
  });
  render(
    <StrictMode>
      <QueryClientProvider client={testQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
  return router;
}

describe("confirming an atomic spec review", () => {
  it("deletes an unchanged submitted draft", () => {
    localStorage.setItem(
      "todou-spec-review:demo:7",
      JSON.stringify([original]),
    );
    render(<DraftHarness slug="demo" />);
    expect(screen.getByTestId("drafts").textContent).toContain("first body");

    fireEvent.click(screen.getByRole("button", { name: "confirm" }));
    expect(screen.getByTestId("drafts").textContent).toBe("[]");
  });

  it("keeps a submitted id changed in flight and a new draft", () => {
    localStorage.setItem(
      "todou-spec-review:other:7",
      JSON.stringify([original]),
    );
    render(<DraftHarness slug="other" />);
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.click(screen.getByRole("button", { name: "add" }));
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));
    const result = JSON.parse(screen.getByTestId("drafts").textContent ?? "[]");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: original.id, body: "edited later" });
    expect(result[1]).toMatchObject({ body: "new while pending" });
  });

  it("confirms the old submit snapshot without clearing a reentered session", async () => {
    localStorage.setItem(
      "todou-spec-review:reentry:7",
      JSON.stringify([original]),
    );
    const response = held<{
      version: number;
      verdict: "comment";
      event_id: number;
      summary_comment_id: null;
      comment_ids: number[];
    }>();
    vi.spyOn(api, "submitSpecReview").mockReturnValue(response.promise);
    const router = renderReentrySession();
    await screen.findByRole("button", { name: "submit" });

    fireEvent.click(screen.getByRole("button", { name: "submit" }));
    await router.navigate({
      to: "/projects/$slug/issues/$number",
      params: { slug: "reentry", number: "7" },
    });
    await screen.findByText("issue detail");
    await router.navigate({
      to: "/projects/$slug/issues/$number/spec",
      params: { slug: "reentry", number: "7" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "write new summary" }),
    );
    expect(screen.getByTestId("session-pending").textContent).toBe("comment");
    fireEvent.click(screen.getByRole("button", { name: "submit" }));
    expect(api.submitSpecReview).toHaveBeenCalledTimes(1);

    await act(async () => {
      response.release({
        version: 1,
        verdict: "comment",
        event_id: 9,
        summary_comment_id: null,
        comment_ids: [1],
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId("session-drafts").textContent).toBe("[]"),
    );
    expect(screen.getByTestId("session-summary").textContent).toBe(
      "new visit summary",
    );
  });

  it("finishes the current session successfully under StrictMode", async () => {
    vi.spyOn(api, "submitSpecReview").mockResolvedValue({
      version: 1,
      verdict: "comment",
      event_id: 10,
      summary_comment_id: 2,
      comment_ids: [],
    });
    renderReentrySession();
    fireEvent.click(
      await screen.findByRole("button", { name: "write new summary" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "submit" }));

    await waitFor(() => {
      expect(screen.getByTestId("session-pending").textContent).toBe("idle");
      expect(screen.getByTestId("session-summary").textContent).toBe("");
    });
  });

  it("allows a retry only after the shared pending request fails", async () => {
    const first = held<never>();
    const submit = vi
      .spyOn(api, "submitSpecReview")
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({
        version: 1,
        verdict: "comment",
        event_id: 10,
        summary_comment_id: 2,
        comment_ids: [1],
      });
    const router = renderReentrySession();
    fireEvent.click(
      await screen.findByRole("button", { name: "stage original" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "submit" }));
    await router.navigate({
      to: "/projects/$slug/issues/$number",
      params: { slug: "reentry", number: "7" },
    });
    await screen.findByText("issue detail");
    await router.navigate({
      to: "/projects/$slug/issues/$number/spec",
      params: { slug: "reentry", number: "7" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "write new summary" }),
    );
    expect(screen.getByTestId("session-pending").textContent).toBe("comment");

    await act(async () => {
      first.reject(new Error("first request failed"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("session-pending").textContent).toBe("idle"),
    );
    expect(screen.getByTestId("session-summary").textContent).toBe(
      "new visit summary",
    );
    expect(screen.getByTestId("session-drafts").textContent).toContain(
      "first body",
    );

    fireEvent.click(screen.getByRole("button", { name: "submit" }));
    expect(submit).toHaveBeenCalledTimes(2);
  });
});
