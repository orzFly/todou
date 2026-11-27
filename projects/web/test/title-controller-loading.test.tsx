import { QueryClientProvider, useIsFetching } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { MePrefs, type ReferenceConfig } from "@todou/shared";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import { api } from "../src/api/queries.ts";
import { TitleController } from "../src/components/title-controller.tsx";
import { testQueryClient } from "./render.tsx";

type Project = Awaited<ReturnType<typeof api.getProject>>;
type Issue = Awaited<ReturnType<typeof api.getIssue>>;

const ACME = {
  id: 1,
  slug: "acme",
  name: "Acme Tracker",
  description: "",
  created_at: "2026-11-01T00:00:00Z",
  viewer_role: "writer",
} as Project;

const ACME_REFS: ReferenceConfig = {
  format: { prefix: "ACME", history: [] },
  autolinks: [],
};

const ISSUE = {
  number: 1,
  title: "Fix the login",
  body_preview: null,
} as unknown as Issue;

const PREVIOUS = "Acme Tracker · issues";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const never = <T,>() => new Promise<T>(() => {});

/**
 * react-query delivers a fetch to its observers in the same batch as this
 * count, so once it drops the controller has rendered that data. Releasing the
 * next part sooner can land both in one render, hiding a wrong title between.
 */
function InFlight() {
  return <output data-testid="in-flight">{useIsFetching()}</output>;
}

const inFlight = (count: number) =>
  waitFor(() =>
    expect(screen.getByTestId("in-flight").textContent).toBe(String(count)),
  );

const titled = (title: string) =>
  waitFor(() => expect(document.title).toBe(title));

/** The real route ids, which are what `titleFor` switches on. */
function mountAt(path: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <TitleController />
        <InFlight />
        <Outlet />
      </>
    ),
  });
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
  });
  const specRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number/spec",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([
        projectRoute.addChildren([issueRoute, specRoute]),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

let titleWrites: MockInstance<(title: string) => void>;

beforeEach(() => {
  document.title = PREVIOUS;
  titleWrites = vi.spyOn(document, "title", "set");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.title = "";
});

const written = () => titleWrites.mock.calls.map(([title]) => title);

describe("document title while its parts load (T-820)", () => {
  it("names the spec page once, after the project and its prefix arrive", async () => {
    const project = deferred<Project>();
    const refs = deferred<ReferenceConfig>();
    vi.spyOn(api, "getProject").mockReturnValue(project.promise);
    vi.spyOn(api, "getReferenceConfig").mockReturnValue(refs.promise);
    // Neither shows in this title, so neither may hold it back.
    vi.spyOn(api, "getIssue").mockReturnValue(never());
    vi.spyOn(api, "getMyPrefs").mockReturnValue(never());

    mountAt("/projects/acme/issues/1/spec");
    project.resolve(ACME);
    await inFlight(3);
    refs.resolve(ACME_REFS);
    await titled("ACME-1 spec · Acme Tracker");
    expect(written()).toEqual(["ACME-1 spec · Acme Tracker"]);
  });

  it("names an issue page once its title and the placement preference arrive", async () => {
    const issue = deferred<Issue>();
    const prefs = deferred<MePrefs>();
    vi.spyOn(api, "getProject").mockResolvedValue(ACME);
    vi.spyOn(api, "getReferenceConfig").mockResolvedValue(ACME_REFS);
    vi.spyOn(api, "getIssue").mockReturnValue(issue.promise);
    vi.spyOn(api, "getMyPrefs").mockReturnValue(prefs.promise);

    mountAt("/projects/acme/issues/1");
    issue.resolve(ISSUE);
    await inFlight(1);
    prefs.resolve(MePrefs.parse({ ref_placement_detail: "after" }));
    await titled("Fix the login ACME-1 · Acme Tracker");
    expect(written()).toEqual(["Fix the login ACME-1 · Acme Tracker"]);
  });

  it("names the page by the slug once the project fails to load", async () => {
    vi.spyOn(api, "getProject").mockRejectedValue(
      Object.assign(new Error("not found"), { status: 404 }),
    );
    vi.spyOn(api, "getReferenceConfig").mockResolvedValue(ACME_REFS);
    vi.spyOn(api, "getIssue").mockReturnValue(never());
    vi.spyOn(api, "getMyPrefs").mockReturnValue(never());

    mountAt("/projects/acme/issues/1/spec");
    await titled("ACME-1 spec · acme");
    expect(written()).toEqual(["ACME-1 spec · acme"]);
  });
});
