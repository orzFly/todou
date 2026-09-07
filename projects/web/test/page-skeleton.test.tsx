import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  IssueListBodySkeleton,
  PagePending,
  PageSkeleton,
  type PageSkeletonKind,
} from "../src/components/page-skeleton.tsx";
import { router } from "../src/router.tsx";
import { renderWithProviders } from "./render.tsx";

const KINDS: PageSkeletonKind[] = [
  "list",
  "detail",
  "spec",
  "board",
  "sections",
];

describe("PageSkeleton", () => {
  it.each(KINDS)("draws the %s shape", (kind) => {
    const view = render(<PageSkeleton kind={kind} />);
    const root = view.getByTestId("page-skeleton");
    expect(root.getAttribute("data-kind")).toBe(kind);
    expect(
      root.querySelectorAll("[data-slot=skeleton]").length,
    ).toBeGreaterThan(0);
  });

  it("gives the board a fixed set of columns — the real count is in the data still loading", () => {
    const view = render(<PageSkeleton kind="board" />);
    expect(view.getAllByTestId("board-skeleton-column")).toHaveLength(4);
  });

  it("draws the spec page's own envelope: toolbar band, file rail, one document", () => {
    const view = render(<PageSkeleton kind="spec" />);
    expect(view.getByTestId("spec-skeleton-toolbar")).toBeTruthy();
    expect(view.getAllByTestId("spec-skeleton-toolbar-row")).toHaveLength(2);
    expect(view.getAllByTestId("spec-skeleton-rail-file")).toHaveLength(4);
    expect(view.getAllByTestId("spec-skeleton-doc")).toHaveLength(1);
  });

  it("builds the list shape out of the body the list page reuses", () => {
    const view = render(<PageSkeleton kind="list" />);
    expect(view.getByTestId("issue-list-body-skeleton")).toBeTruthy();
  });

  it("renders the body half on its own", () => {
    const view = render(<IssueListBodySkeleton />);
    expect(view.getByTestId("issue-list-body-skeleton")).toBeTruthy();
    expect(view.queryByTestId("page-skeleton")).toBeNull();
  });
});

describe("PagePending", () => {
  it("falls back to sections where no route declares a shape", async () => {
    renderWithProviders(<PagePending />);
    const root = await screen.findByTestId("page-skeleton");
    expect(root.getAttribute("data-kind")).toBe("sections");
  });
});

describe("spec route", () => {
  // The one thing tsc cannot catch about this wiring: every kind is a valid
  // member of the union, so declaring the wrong shape — or forgetting to
  // change it — compiles either way.
  it("declares the spec shape rather than the issue page's", () => {
    const spec =
      router.routesById["/authed/projects/$slug/issues/$number/spec"];
    expect(spec.options.staticData?.pageSkeleton).toBe("spec");
  });
});
