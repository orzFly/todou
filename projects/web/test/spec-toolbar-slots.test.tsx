import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { SpecComments, SpecFiles, SpecInfo } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { parseSpecSearch } from "../src/lib/spec-search.ts";
import { SpecViewPage } from "../src/pages/spec-view.tsx";
import { testQueryClient } from "./render.tsx";

vi.mock("@pierre/diffs/react", () => ({
  MultiFileDiff: () => <div data-testid="diff" />,
  CodeView: () => null,
}));

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

const AUTHOR = {
  id: 1,
  login: "bot-one",
  display_name: "Bot One",
  kind: "machine" as const,
  avatar_url: null,
  owner: null,
};

// design.md is edited by v2, stable.md is carried over untouched, and
// fresh.md appears in v2 — one file per rendered-mode matrix column.
const BODIES: Record<number, Record<string, string>> = {
  1: { "design.md": "line one\n", "stable.md": "unchanged\n" },
  2: {
    "design.md": "line one, rewritten\n",
    "stable.md": "unchanged\n",
    "fresh.md": "brand new\n",
  },
};

function mockSpec() {
  const info: SpecInfo = {
    current_version: 2,
    review_status: "unreviewed",
    unresolved_comments: 0,
    files: Object.entries(BODIES[2] ?? {}).map(([path, body]) => ({
      path,
      size: body.length,
    })),
    versions: [1, 2].map((number) => ({
      number,
      author: AUTHOR,
      message: `v${number}`,
      created_at: `2026-01-0${number}T00:00:00Z`,
    })),
  };
  vi.spyOn(api, "getSpec").mockResolvedValue(info);
  vi.spyOn(api, "getSpecFiles").mockImplementation(
    (_slug, _number, version): Promise<SpecFiles> => {
      const v = version ?? 2;
      return Promise.resolve({
        version: v,
        files: Object.entries(BODIES[v] ?? {}).map(([path, body]) => ({
          path,
          body,
          size: body.length,
        })),
      });
    },
  );
  const comments: SpecComments = { current_version: 2, items: [] };
  vi.spyOn(api, "getSpecComments").mockResolvedValue(comments);
  vi.spyOn(api, "getReferenceConfig").mockResolvedValue({
    format: { prefix: "T-", history: [] },
    autolinks: [],
  });
}

function renderSpecView(search: string) {
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
      initialEntries: [`/projects/demo/issues/1/spec${search}`],
    }),
    defaultPendingMs: 0,
  });
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** The toolbar, once its data has landed. */
async function toolbar(search: string) {
  mockSpec();
  const view = renderSpecView(search);
  await view.findByRole("button", { name: /finish review/i });
  // The baseline snapshot decides several slots' state; wait for it rather
  // than assert against the moment before it arrives.
  await waitFor(() =>
    expect(api.getSpecFiles).toHaveBeenCalledWith("demo", 1, 1),
  );
  return view;
}

const slotNames = (view: { container: HTMLElement }) =>
  [...view.container.querySelectorAll("[data-toolbar-slot]")].map(
    (el) => el.getAttribute("data-toolbar-slot") ?? "",
  );

const jumpButtons = (view: ReturnType<typeof renderSpecView>) => ({
  prev: view.getByRole("button", { name: /^previous / }),
  next: view.getByRole("button", { name: /^next / }),
});

/** The columns of the T-190 state matrix, as T-192 re-cut them. */
const STATES: [label: string, search: string][] = [
  ["R1 · v1, no baseline possible", "?v=1"],
  ["R2 · modified file", "?v=2&file=design.md"],
  ["RN · new file", "?v=2&file=fresh.md"],
  ["RU · untouched file", "?v=2&file=stable.md"],
  ["C · source diff", "?v=2&compare=1"],
];

/** Moves the baseline picker to a position, by the text of its entry. */
async function pickBaseline(
  view: ReturnType<typeof renderSpecView>,
  name: RegExp,
) {
  const trigger = view.getByRole("button", {
    name: /baseline|comparing against/i,
  });
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
  fireEvent.click(screen.getByRole("menuitemradio", { name }));
}

describe("spec toolbar fixed slots (T-190)", () => {
  it("renders the same slots in every state", async () => {
    const seen: string[][] = [];
    for (const [, search] of STATES) {
      const view = await toolbar(search);
      seen.push(slotNames(view));
      view.unmount();
      vi.restoreAllMocks();
    }
    // Every column of the matrix, including the two the old toolbar
    // unmounted controls for: switching file or entering compare mode.
    expect(seen[0]).toEqual([
      "back",
      "title",
      "review-status",
      "files",
      "comment-file",
      "finish-review",
      "version",
      "baseline",
      "view-toggle",
      "display-toggle",
      "prev-change",
      "next-change",
    ]);
    for (const names of seen.slice(1)) expect(names).toEqual(seen[0]);
  });

  it("keeps every slot in place when the baseline goes off (T-192)", async () => {
    const view = await toolbar("?v=2&file=design.md");
    const before = slotNames(view);
    await pickBaseline(view, /no baseline/i);
    await waitFor(() =>
      expect(
        view.getByRole("button", { name: "source" }).hasAttribute("disabled"),
      ).toBe(true),
    );
    expect(slotNames(view)).toEqual(before);
  });

  it("disables ↑↓ at v1 rather than dropping them", async () => {
    const view = await toolbar("?v=1");
    const { prev, next } = jumpButtons(view);
    expect(prev.hasAttribute("disabled")).toBe(true);
    expect(next.hasAttribute("disabled")).toBe(true);
    expect(prev.getAttribute("aria-label")).toContain("first version");
  });

  it("steps changes on a modified file, and stops when the baseline goes off", async () => {
    const view = await toolbar("?v=2&file=design.md");
    expect(jumpButtons(view).next.hasAttribute("disabled")).toBe(false);
    await pickBaseline(view, /no baseline/i);
    await waitFor(() =>
      expect(jumpButtons(view).next.hasAttribute("disabled")).toBe(true),
    );
    expect(jumpButtons(view).next.getAttribute("aria-label")).toContain(
      "Pick a baseline",
    );
  });

  it("pins the widths the two new slots stand on (T-192)", async () => {
    // Rect equality across states is a browser measurement; happy-dom lays
    // nothing out, so what a suite can hold is the declaration that made it
    // true. Without these three the baseline label and the version's push
    // message slide everything to their right.
    const view = await toolbar("?v=2&file=design.md");
    const cls = (selector: string) =>
      view.container.querySelector(selector)?.className ?? "";
    expect(cls('[data-toolbar-slot="version"]')).toContain("lg:w-80");
    expect(cls('[data-toolbar-slot="baseline"] button')).toContain("min-w-32");
    expect(cls('[data-toolbar-slot="view-toggle"] fieldset')).toContain("w-36");
  });

  it("keeps wrap in the display slot, disabled outside the source diff", async () => {
    const view = await toolbar("?v=2&file=design.md");
    const wrap = view.getByRole("button", { name: /^wrap/ });
    expect(wrap.hasAttribute("disabled")).toBe(true);
    expect(wrap.getAttribute("aria-label")).toContain("source diff");
  });

  it("keeps ↑↓ usable on a file that is new in this version", async () => {
    // The named bug: `new in v2` used to unmount the buttons outright, so
    // there was no way to step off a brand-new file.
    const view = await toolbar("?v=2&file=fresh.md");
    expect(view.getByText("new in v2")).toBeTruthy();
    const { prev, next } = jumpButtons(view);
    expect(next.hasAttribute("disabled")).toBe(false);
    expect(prev.getAttribute("aria-label")).toBe("previous changed file");
  });

  it("steps whole file diffs in source-diff mode", async () => {
    const view = await toolbar("?v=2&compare=1");
    const { prev, next } = jumpButtons(view);
    expect(next.hasAttribute("disabled")).toBe(false);
    expect(prev.getAttribute("aria-label")).toBe("previous file diff");
    expect(view.container.querySelectorAll("[data-file-diff]")).toHaveLength(2);
  });

  it("disables Comment file in source-diff mode instead of hiding it", async () => {
    const view = await toolbar("?v=2&compare=1");
    const button = view.getByRole("button", { name: /^Comment file/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("aria-label")).toContain("line numbers");
  });

  it("lists the differing files in source-diff mode, carrying the baseline", async () => {
    const view = await toolbar("?v=2&compare=1");
    expect(view.getByRole("button", { name: /Files \(2\)/ })).toBeTruthy();
    // The rail renders the same list from lg up, so scope to the popover
    // rather than picking one of two identical links (T-192).
    fireEvent.click(view.getByRole("button", { name: /Files \(2\)/ }));
    const popover = await screen.findByRole("dialog");
    const link = within(popover).getByRole("link", { name: /fresh\.md/ });
    expect(link.getAttribute("href")).toBe(
      "/projects/demo/issues/1/spec?file=fresh.md&v=2&compare=1",
    );
  });
});
