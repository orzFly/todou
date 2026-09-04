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
  File: () => <div data-testid="file-view" />,
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
// design.md changes three of its four paragraphs, so the counter has more
// than one stop to count; the untouched paragraph neighbours a changed one
// and therefore never folds away.
const BODIES: Record<number, Record<string, string>> = {
  1: {
    "design.md": "line one\n\nline two\n\nline three\n\nline four\n",
    "stable.md": "unchanged\n",
  },
  2: {
    "design.md":
      "line one, rewritten\n\nline two\n\nline three, rewritten\n\nline four, rewritten\n",
    "stable.md": "unchanged\n",
    "fresh.md": "brand new\n",
  },
};

function mockSpec() {
  const info: SpecInfo = {
    current_version: 2,
    current_version_cursor: "c2",
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
  const view = render(
    <QueryClientProvider client={testQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router };
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

const countSlot = (view: { container: HTMLElement }) =>
  view.container.querySelector('[data-toolbar-slot="change-count"]');

/**
 * Place the changed blocks and let the counter re-measure. happy-dom lays
 * nothing out, so every rect is zero until a test says otherwise; the viewport
 * is 768 tall, which puts the pivot at 384 and its tolerance band at 376–392.
 */
function stubTops(view: { container: HTMLElement }, tops: number[]): void {
  const els = [
    ...view.container.querySelectorAll<HTMLElement>(
      ".spec-changed, .spec-ins-block",
    ),
  ];
  els.forEach((el, i) => {
    el.getBoundingClientRect = () =>
      ({ top: tops[i] ?? 0, height: 20 }) as DOMRect;
  });
  fireEvent.scroll(window);
}

/** The columns of the T-190 state matrix, as T-192 re-cut them. */
const STATES: [label: string, search: string][] = [
  ["R2 · modified file", "?v=2&file=design.md"],
  ["RN · new file", "?v=2&file=fresh.md"],
  ["RU · untouched file", "?v=2&file=stable.md"],
  ["C · source diff", "?v=2&compare=1"],
];

// Anchored on both ends: the baseline trigger's label also opens with
// "comparing against vN", and ↑↓ explain themselves with "Turn comparing on".
const TOGGLE_LABEL = /^turn comparing on$|turn comparing off$|^compare —/i;
const compareToggle = (view: ReturnType<typeof renderSpecView>) =>
  view.getByRole("button", { name: TOGGLE_LABEL });

const SLOTS_COMPARING = [
  "back",
  "title",
  "review-status",
  "files",
  "comment-file",
  "finish-review",
  "view-toggle",
  "version",
  "compare",
  "baseline",
  "display-toggle",
  "prev-change",
  "change-count",
  "next-change",
];

const SLOTS_PLAIN = SLOTS_COMPARING.filter((name) => name !== "baseline");

describe("spec toolbar fixed slots (T-190)", () => {
  it("renders the same slots in every state that compares", async () => {
    const seen: string[][] = [];
    for (const [, search] of STATES) {
      const view = await toolbar(search);
      seen.push(slotNames(view));
      view.unmount();
      vi.restoreAllMocks();
    }
    // Every column of the matrix, including the two the old toolbar
    // unmounted controls for: switching file or entering compare mode.
    for (const names of seen) expect(names).toEqual(SLOTS_COMPARING);
  });

  it("drops the baseline slot alone when comparing goes off (T-200)", async () => {
    // The one exception to "every slot in every state": there is no baseline
    // to disable a picker against, and a hollow box mid-range reads worse
    // than a shorter range. Everything else keeps its place.
    const view = await toolbar("?v=2&file=design.md");
    fireEvent.click(compareToggle(view));
    await waitFor(() => expect(slotNames(view)).toEqual(SLOTS_PLAIN));
    expect(view.router.state.location.search).toEqual({
      v: 2,
      file: "design.md",
    });
  });

  it("has no baseline slot at v1 either, and disables the toggle there", async () => {
    const view = await toolbar("?v=1");
    expect(slotNames(view)).toEqual(SLOTS_PLAIN);
    const toggle = compareToggle(view);
    expect(toggle.hasAttribute("disabled")).toBe(true);
    expect(toggle.getAttribute("aria-label")).toContain("no earlier version");
  });

  it("presses the compare toggle in and out (T-200)", async () => {
    const view = await toolbar("?v=2&file=design.md");
    expect(compareToggle(view).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(compareToggle(view));
    await waitFor(() =>
      expect(compareToggle(view).getAttribute("aria-pressed")).toBe("false"),
    );
    fireEvent.click(compareToggle(view));
    await waitFor(() =>
      expect(compareToggle(view).getAttribute("aria-pressed")).toBe("true"),
    );
  });

  it("drops the draft count until there is a draft (T-200)", async () => {
    // T-190 reserved the box to hold the button still; the hollow it left on
    // every draftless page is what the card was opened about.
    const view = await toolbar("?v=2&file=design.md");
    const button = view.container.querySelector(
      '[data-toolbar-slot="finish-review"]',
    );
    expect(button?.textContent).toBe("Finish review");
    expect(button?.querySelector(".tabular-nums")).toBeNull();
  });

  it("offers no way back into comparing from the baseline menu", async () => {
    // The toggle is the only entry point, so the menu only answers "against
    // which version" (T-200).
    const view = await toolbar("?v=2&file=design.md");
    const trigger = view.getByRole("button", {
      name: /pick another baseline/i,
    });
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
    expect(screen.queryByText(/no baseline/i)).toBeNull();
    expect(screen.queryAllByRole("menuitemradio")).toHaveLength(0);
    // Every baseline has a URL of its own now, so the entries are links.
    const entries = screen.getAllByRole("menuitem");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.getAttribute("href")).toBe(
      "/projects/demo/issues/1/spec?file=design.md&v=2",
    );
  });

  it("disables ↑↓ at v1 rather than dropping them", async () => {
    const view = await toolbar("?v=1");
    const { prev, next } = jumpButtons(view);
    expect(prev.hasAttribute("disabled")).toBe(true);
    expect(next.hasAttribute("disabled")).toBe(true);
    expect(prev.getAttribute("aria-label")).toContain("first version");
  });

  it("steps changes on a modified file, and stops when comparing goes off", async () => {
    const view = await toolbar("?v=2&file=design.md");
    expect(jumpButtons(view).next.hasAttribute("disabled")).toBe(false);
    fireEvent.click(compareToggle(view));
    await waitFor(() =>
      expect(jumpButtons(view).next.hasAttribute("disabled")).toBe(true),
    );
    expect(jumpButtons(view).next.getAttribute("aria-label")).toContain(
      "Turn comparing on",
    );
  });

  it("sizes row B's controls to their content, at one shared height (T-194)", async () => {
    // Geometry is a browser measurement and happy-dom lays nothing out, so
    // what a suite can hold is the declaration behind it. These three widths
    // bought stillness with hollow boxes — 61px of it in the display slot —
    // and T-194 traded them back.
    const view = await toolbar("?v=2&file=design.md");
    const cls = (selector: string) =>
      view.container.querySelector(selector)?.className ?? "";
    expect(cls('[data-toolbar-slot="version"]')).not.toContain("lg:w-80");
    expect(cls('[data-toolbar-slot="baseline"] button')).not.toContain(
      "min-w-32",
    );
    expect(cls('[data-toolbar-slot="view-toggle"] fieldset')).not.toContain(
      "w-36",
    );
    // The version trigger's own cap moved onto the message span, because the
    // baseline's cap is computed from whatever this one measures out to
    // (T-200) — and a button-level cap would hide that measurement.
    expect(cls('[data-toolbar-slot="version"] button')).not.toContain(
      "max-w-80",
    );
    expect(cls('[data-linked-msg="version"]')).toContain(
      "max-w-[var(--spec-vmsg-max,20rem)]",
    );
    expect(cls('[data-linked-msg="baseline"]')).toContain(
      "max-w-[var(--spec-bmsg-max,8rem)]",
    );
    // One height across the row, or the pills line up on nothing: their
    // natural heights are 22, 28 and 30px.
    expect(cls('[data-toolbar-slot="version"] button')).toContain("h-7");
    expect(cls('[data-toolbar-slot="baseline"] button')).toContain("h-7");
    expect(cls('[data-toolbar-slot="compare"] button')).toContain("h-7");
    expect(cls('[data-toolbar-slot="view-toggle"] fieldset')).toContain("h-7");
    expect(cls('[data-toolbar-slot="display-toggle"] > *')).toContain("h-7");
  });

  it("keeps row A on one line from lg up, where the title can shrink (T-206)", async () => {
    // Line breaking runs before flex shrinking and measures each item
    // unshrunk, so with `flex-wrap` on at lg the row met a long title by
    // pushing Finish review onto a second line — and the title, having caused
    // no overflow, never truncated. Same reason as T-194 above for asserting
    // the declaration: happy-dom lays nothing out.
    const view = await toolbar("?v=2&file=design.md");
    const cls = (selector: string) =>
      view.container.querySelector(selector)?.className ?? "";
    const rowA = view.container.querySelector(
      '[data-toolbar-slot="back"]',
    )?.parentElement;
    expect(rowA?.className).toContain("lg:flex-nowrap");
    // Below lg the title is display:none and every other item is shrink-0:
    // nothing left to give, so wrapping stays the graceful answer there.
    expect(rowA?.className).toContain("flex-wrap");
    // The ellipsis needs both halves, and neither may become a fixed width
    // (T-194) or a grown flex child, which would strand the review badge.
    expect(cls('[data-toolbar-slot="title"]')).toContain("min-w-0");
    expect(cls('[data-toolbar-slot="title"]')).toContain("truncate");
    expect(cls('[data-toolbar-slot="title"]')).not.toMatch(/\bflex-1\b|basis-/);
    expect(cls('[data-toolbar-slot="title"]')).not.toMatch(/(^|\s)(w-|max-w-)/);
    // One wrapping unit, so the wrap left below lg cannot stage the same
    // stranding it was just fixed for.
    const commentFile = view.container.querySelector(
      '[data-toolbar-slot="comment-file"]',
    );
    const finish = view.container.querySelector(
      '[data-toolbar-slot="finish-review"]',
    );
    expect(finish?.parentElement).toBe(commentFile?.parentElement);
    expect(finish?.parentElement).not.toBe(rowA);
  });

  it("shows fold on the rendered views and wrap on the source ones", async () => {
    // The display slot used to hold a permanently disabled `wrap` on every
    // rendered view — a button that could never be pressed (T-222).
    const view = await toolbar("?v=2&file=design.md");
    const fold = view.getByRole("button", { name: /^fold/ });
    expect(fold.hasAttribute("disabled")).toBe(false);
    expect(fold.getAttribute("aria-pressed")).toBe("true");
    expect(view.queryByRole("button", { name: /^wrap/ })).toBeNull();
    view.unmount();
    vi.restoreAllMocks();

    const untouched = await toolbar("?v=2&file=stable.md");
    const disabled = untouched.getByRole("button", { name: /^fold/ });
    expect(disabled.hasAttribute("disabled")).toBe(true);
    expect(disabled.getAttribute("aria-label")).toContain("Nothing changed");
    untouched.unmount();
    vi.restoreAllMocks();

    const fresh = await toolbar("?v=2&file=fresh.md");
    expect(fresh.getByText("new in v2")).toBeTruthy();
    expect(fresh.queryByRole("button", { name: /^fold/ })).toBeNull();
    expect(fresh.queryByRole("button", { name: /^wrap/ })).toBeNull();
    fresh.unmount();
    vi.restoreAllMocks();

    const source = await toolbar("?v=2&compare=1");
    expect(
      source.getByRole("button", { name: /^wrap/ }).hasAttribute("disabled"),
    ).toBe(false);
    expect(source.queryByRole("button", { name: /^fold/ })).toBeNull();
  });

  it("turns fold off, remembers it, and refuses it with comparing off", async () => {
    const view = await toolbar("?v=2&file=design.md");
    fireEvent.click(view.getByRole("button", { name: /^fold/ }));
    await waitFor(() =>
      expect(
        view
          .getByRole("button", { name: /^fold/ })
          .getAttribute("aria-pressed"),
      ).toBe("false"),
    );
    expect(localStorage.getItem("todou-spec-fold")).toBe("off");

    fireEvent.click(compareToggle(view));
    await waitFor(() =>
      expect(
        view.getByRole("button", { name: /^fold/ }).hasAttribute("disabled"),
      ).toBe(true),
    );
    expect(
      view.getByRole("button", { name: /^fold/ }).getAttribute("aria-label"),
    ).toContain("Turn comparing on");
  });

  it("opens with fold off when storage says so", async () => {
    localStorage.setItem("todou-spec-fold", "off");
    const view = await toolbar("?v=2&file=design.md");
    expect(
      view.getByRole("button", { name: /^fold/ }).getAttribute("aria-pressed"),
    ).toBe("false");
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

  it("counts the change ↓ would step to (T-224)", async () => {
    const view = await toolbar("?v=2&file=design.md");
    await waitFor(() => expect(countSlot(view)?.textContent).toBe("3/3"));

    // Every block below the pivot: ↓ lands on the first, so the reader is on
    // none of them yet.
    stubTops(view, [500, 700, 900]);
    await waitFor(() => expect(countSlot(view)?.textContent).toBe("0/3"));

    stubTops(view, [100, 500, 900]);
    await waitFor(() => expect(countSlot(view)?.textContent).toBe("1/3"));

    stubTops(view, [-100, 200, 900]);
    await waitFor(() => expect(countSlot(view)?.textContent).toBe("2/3"));
    expect(countSlot(view)?.getAttribute("title")).toBe("change 2 of 3");
  });

  it("takes the total from the DOM, not from the changed ranges (T-224)", async () => {
    // T-223 turns a replaced image into a stop of its own, and any count
    // derived from the ranges would keep saying 3 while ↓ visits four.
    const view = await toolbar("?v=2&file=design.md");
    await waitFor(() => expect(countSlot(view)?.textContent).toBe("3/3"));
    const extra = document.createElement("p");
    extra.className = "spec-ins-block";
    view.container.querySelector("main")?.append(extra);
    stubTops(view, [100, 500, 900, 950]);
    await waitFor(() => expect(countSlot(view)?.textContent).toBe("1/4"));
  });

  it("counts a mark nested in another mark as one stop (T-223, T-224)", async () => {
    // A swapped image marks the <img> and the paragraph holding it both, and
    // ↑↓ have always stepped over blocks — the pair is one place to look. Left
    // in, it would stop the reader twice within one paragraph and inflate the
    // total against what the reader can see.
    const view = await toolbar("?v=2&file=design.md");
    await waitFor(() => expect(countSlot(view)?.textContent).toBe("3/3"));
    const blocks = view.container.querySelectorAll("p.spec-changed");
    const host = blocks[blocks.length - 1];
    if (host === undefined) throw new Error("no changed block to nest inside");
    const nested = document.createElement("img");
    nested.className = "spec-ins-block";
    host.append(nested);
    stubTops(view, [100, 500, 900]);
    await waitFor(() => expect(countSlot(view)?.textContent).toBe("1/3"));
  });

  it("counts files where ↑↓ step over files (T-224)", async () => {
    const view = await toolbar("?v=2&file=stable.md");
    // stable.md is not one of the two changed files, so ↓ goes to the first.
    await waitFor(() => expect(countSlot(view)?.textContent).toBe("0/2"));
    expect(countSlot(view)?.getAttribute("title")).toBe("changed file 0 of 2");
  });

  it("counts whole file diffs in source-diff mode (T-224)", async () => {
    const view = await toolbar("?v=2&compare=1");
    await waitFor(() => expect(countSlot(view)?.textContent).toBe("2/2"));
    expect(countSlot(view)?.getAttribute("title")).toBe("file diff 2 of 2");
  });

  it("shows the arrows' own reason where there is nothing to count (T-224)", async () => {
    const view = await toolbar("?v=1");
    expect(countSlot(view)?.textContent).toBe("–");
    expect(countSlot(view)?.getAttribute("title")).toContain("first version");
    view.unmount();
    vi.restoreAllMocks();

    const comparing = await toolbar("?v=2&file=design.md");
    fireEvent.click(compareToggle(comparing));
    await waitFor(() => expect(countSlot(comparing)?.textContent).toBe("–"));
    expect(countSlot(comparing)?.getAttribute("title")).toContain(
      "Turn comparing on",
    );
  });

  it("steps with n and p exactly as the arrows do (T-224)", async () => {
    // stable.md is outside the rail, so the step leaves the file and lands in
    // the URL — the one move a suite can compare without geometry.
    const byKey = await toolbar("?v=2&file=stable.md");
    fireEvent.keyDown(document.body, { key: "n" });
    await waitFor(() =>
      expect(byKey.router.state.location.search).toMatchObject({
        file: "design.md",
      }),
    );
    byKey.unmount();
    vi.restoreAllMocks();

    const byClick = await toolbar("?v=2&file=stable.md");
    fireEvent.click(jumpButtons(byClick).next);
    await waitFor(() =>
      expect(byClick.router.state.location.search).toMatchObject({
        file: "design.md",
      }),
    );
    byClick.unmount();
    vi.restoreAllMocks();

    const backwards = await toolbar("?v=2&file=stable.md");
    fireEvent.keyDown(document.body, { key: "p" });
    await waitFor(() =>
      expect(backwards.router.state.location.search).toMatchObject({
        file: "fresh.md",
      }),
    );
  });

  it("leaves n and p alone while the reader is typing (T-224)", async () => {
    const view = await toolbar("?v=2&file=stable.md");
    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { key: "n" });
    await waitFor(() => expect(countSlot(view)?.textContent).toBe("0/2"));
    expect(view.router.state.location.search).toMatchObject({
      file: "stable.md",
    });
    input.remove();
  });

  it("leaves n and p alone inside a dialog (T-224)", async () => {
    // Radix runs its own typeahead over the same letters, and the reader who
    // opened the dialog is not asking the page behind it to scroll.
    const view = await toolbar("?v=2&file=stable.md");
    fireEvent.click(view.getByRole("button", { name: /finish review/i }));
    const dialog = await screen.findByRole("dialog");
    const target = within(dialog).getAllByRole("button")[0];
    if (target === undefined) throw new Error("the dialog has no button");
    fireEvent.keyDown(target, { key: "n" });
    await waitFor(() => expect(countSlot(view)?.textContent).toBe("0/2"));
    expect(view.router.state.location.search).toMatchObject({
      file: "stable.md",
    });
  });

  it("keeps n and p as disabled as the arrows are (T-224)", async () => {
    const view = await toolbar("?v=1");
    const before = view.router.state.location.search;
    fireEvent.keyDown(document.body, { key: "n" });
    await waitFor(() => expect(countSlot(view)?.textContent).toBe("–"));
    expect(view.router.state.location.search).toEqual(before);
  });

  it("says on the arrows which keys drive them (T-224)", async () => {
    const view = await toolbar("?v=2&file=design.md");
    const { prev, next } = jumpButtons(view);
    expect(prev.getAttribute("aria-keyshortcuts")).toBe("p");
    expect(next.getAttribute("aria-keyshortcuts")).toBe("n");
    expect(next.getAttribute("title")).toBe("next change (n)");
    expect(prev.getAttribute("title")).toBe("previous change (p)");
    // The label carries the disabled reason, so the tooltip steps aside and
    // lets the slot's own title through.
    expect(next.getAttribute("aria-label")).toBe("next change");
    view.unmount();
    vi.restoreAllMocks();

    const first = await toolbar("?v=1");
    expect(jumpButtons(first).next.getAttribute("title")).toBeNull();
  });

  it("disables Comment file in source-diff mode instead of hiding it", async () => {
    const view = await toolbar("?v=2&compare=1");
    const button = view.getByRole("button", { name: /^Comment file/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("aria-label")).toContain("line numbers");
  });

  it("lists the whole file set in source-diff mode, carrying the baseline", async () => {
    const view = await toolbar("?v=2&compare=1");
    // design.md changed, fresh.md is new, stable.md did not move (T-203).
    expect(view.getByRole("button", { name: /Files \(3\)/ })).toBeTruthy();
    // The rail renders the same list from lg up, so scope to the popover
    // rather than picking one of two identical links (T-192).
    fireEvent.click(view.getByRole("button", { name: /Files \(3\)/ }));
    const popover = await screen.findByRole("dialog");
    const link = within(popover).getByRole("link", { name: /fresh\.md/ });
    expect(link.getAttribute("href")).toBe(
      "/projects/demo/issues/1/spec?file=fresh.md&v=2&compare=1",
    );
  });
});
