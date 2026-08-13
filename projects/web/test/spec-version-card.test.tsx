import { fireEvent, waitFor } from "@testing-library/react";
import { diffLines } from "diff";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpecVersionCard } from "../src/components/timeline/spec-version-card.tsx";
import {
  computeVersionStats,
  diffstatCells,
} from "../src/lib/spec-version-stats.ts";
import { renderWithProviders } from "./render.tsx";

describe("computeVersionStats", () => {
  const before = new Map([
    ["design.md", "a\nb\nc\n"],
    ["gone.md", "one\ntwo\n"],
  ]);
  const after = new Map([
    ["design.md", "a\nB\nB2\nc\n"],
    ["new.md", "x\ny\nz\n"],
  ]);

  it("counts added, modified, and removed lines per file", () => {
    const stats = computeVersionStats(
      { added: ["new.md"], changed: ["design.md"], removed: ["gone.md"] },
      before,
      after,
      diffLines,
    );
    expect(stats).toEqual([
      { path: "new.md", change: "added", plus: 3, minus: 0 },
      { path: "design.md", change: "modified", plus: 2, minus: 1 },
      { path: "gone.md", change: "removed", plus: 0, minus: 2 },
    ]);
  });
});

describe("diffstatCells", () => {
  it("splits five cells proportionally with a one-cell floor", () => {
    expect(diffstatCells(10, 0)).toEqual([
      "plus",
      "plus",
      "plus",
      "plus",
      "plus",
    ]);
    expect(diffstatCells(0, 4)).toEqual([
      "minus",
      "minus",
      "minus",
      "minus",
      "minus",
    ]);
    expect(diffstatCells(99, 1)).toEqual([
      "plus",
      "plus",
      "plus",
      "plus",
      "minus",
    ]);
    expect(diffstatCells(1, 99)).toEqual([
      "plus",
      "minus",
      "minus",
      "minus",
      "minus",
    ]);
    expect(diffstatCells(0, 0)).toEqual([
      "none",
      "none",
      "none",
      "none",
      "none",
    ]);
  });
});

describe("SpecVersionCard", () => {
  afterEach(() => vi.unstubAllGlobals());

  const V1 = {
    version: 1,
    files: [{ path: "design.md", body: "a\nb\nc\n", size: 6 }],
  };
  const V2 = {
    version: 2,
    files: [
      { path: "design.md", body: "a\nB\nc\n", size: 6 },
      { path: "new.md", body: "x\n", size: 2 },
    ],
  };

  const SPEC_INFO = {
    current_version: 2,
    review_status: "unreviewed",
    unresolved_comments: 1,
    files: [{ path: "design.md", size: 6 }],
    versions: [
      {
        number: 1,
        author: { id: 2, login: "bot", kind: "machine" },
        message: null,
        created_at: "2026-08-12T11:00:00Z",
      },
      {
        number: 2,
        author: { id: 2, login: "bot", kind: "machine" },
        message: "round 2",
        created_at: "2026-08-12T12:00:00Z",
      },
    ],
  };

  /** `info` overrides the spec overview; `viewer` is the logged-in user id. */
  function stubFetch(info: object = SPEC_INFO, viewer = 1) {
    vi.stubGlobal("fetch", async (input: unknown) => {
      const url = new URL(String(input), "http://test");
      if (url.pathname.endsWith("/me")) {
        return Response.json({ id: viewer, login: "user", kind: "human" });
      }
      if (url.pathname.endsWith("/spec/files")) {
        return Response.json(url.searchParams.get("version") === "1" ? V1 : V2);
      }
      if (url.pathname.endsWith("/spec/comments")) {
        return Response.json({
          current_version: 2,
          items: [
            {
              comment_id: 9,
              author: { id: 1, login: "user" },
              created_at: "2026-08-12T12:00:00Z",
              body: "nit",
              anchor: {
                path: "design.md",
                version: 2,
                line_start: 2,
                line_end: 2,
                quote: "B",
              },
              resolved: null,
              outdated: true,
              current_line_start: null,
              current_line_end: null,
            },
          ],
        });
      }
      if (url.pathname.endsWith("/spec")) return Response.json(info);
      throw new Error(`unexpected fetch: ${url.pathname}`);
    });
  }

  const PAYLOAD = {
    version: 2,
    message: "round 2",
    added: ["new.md"],
    changed: ["design.md"],
    removed: ["gone.md"],
  };

  it("renders rows, stats, totals, and the annotation footer", async () => {
    stubFetch();
    const view = renderWithProviders(
      <SpecVersionCard slug="p" issueNumber={1} payload={PAYLOAD} />,
    );
    expect(await view.findByText("Spec v2")).toBeTruthy();
    expect(view.getByText("round 2")).toBeTruthy();
    expect(view.getByText("new.md")).toBeTruthy();
    expect(view.getByText("design.md")).toBeTruthy();
    expect(view.getByText("gone.md")).toBeTruthy();
    // Stats resolve async (lazy jsdiff + two snapshot fetches).
    await waitFor(() => {
      expect(view.getByText("+2")).toBeTruthy();
    });
    expect(
      await view.findByText(/1 review comment anchored at v2/),
    ).toBeTruthy();
    expect(view.getByText(/1 outdated by later pushes/)).toBeTruthy();
  });

  it("collapses to the header line and back", async () => {
    stubFetch();
    const view = renderWithProviders(
      <SpecVersionCard slug="p" issueNumber={1} payload={PAYLOAD} />,
    );
    await view.findByText("new.md");
    fireEvent.click(view.getByLabelText("collapse file list"));
    expect(view.queryByText("new.md")).toBeNull();
    expect(view.getByText("Spec v2")).toBeTruthy();
    fireEvent.click(view.getByLabelText("expand file list"));
    expect(view.getByText("new.md")).toBeTruthy();
  });

  it("prompts for review on the latest unreviewed version (T-103)", async () => {
    stubFetch();
    const view = renderWithProviders(
      <SpecVersionCard slug="p" issueNumber={1} payload={PAYLOAD} />,
    );
    const cta = await view.findByTestId("spec-review-cta");
    expect(cta.textContent).toContain("Awaiting your review");
    // Title and button only — no subline (T-103).
    expect(cta.textContent).not.toContain("unresolved comment");
    expect(cta.textContent).not.toContain("latest version");
    const link = view.getByRole("link", { name: /Read & review/ });
    expect(link.getAttribute("href")).toBe("/projects/p/issues/1/spec?v=2");
    // Survives the collapse — the ask is not part of the file list.
    fireEvent.click(view.getByLabelText("collapse file list"));
    expect(view.getByTestId("spec-review-cta")).toBeTruthy();
  });

  it("stays out of settled verdicts, older versions, and the pusher's view", async () => {
    const cases: Array<[string, object, number]> = [
      ["approved", { ...SPEC_INFO, review_status: "approved" }, 1],
      [
        "changes requested",
        { ...SPEC_INFO, review_status: "changes_requested" },
        1,
      ],
      ["superseded", { ...SPEC_INFO, current_version: 3 }, 1],
      ["pushed by the viewer", SPEC_INFO, 2],
    ];
    for (const [name, info, viewer] of cases) {
      stubFetch(info, viewer);
      const view = renderWithProviders(
        <SpecVersionCard slug="p" issueNumber={1} payload={PAYLOAD} />,
      );
      // The stats chain (two snapshot fetches + lazy jsdiff) settles well
      // after the spec overview — once it lands, an absent CTA is absent.
      await waitFor(() => expect(view.getByText("+2")).toBeTruthy());
      expect(view.queryByTestId("spec-review-cta"), name).toBeNull();
      view.unmount();
    }
  });

  it("renders nothing for a malformed payload", async () => {
    stubFetch();
    const view = renderWithProviders(
      <SpecVersionCard
        slug="p"
        issueNumber={1}
        payload={{ version: "not-a-number" }}
      />,
    );
    await waitFor(() => {
      expect(view.container.textContent).toBe("");
    });
  });
});
