import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpecBlock } from "../src/components/issue/spec-block.tsx";
import { renderWithProviders } from "./render.tsx";

const INFO = {
  current_version: 2,
  review_status: "unreviewed",
  unresolved_comments: 0,
  files: [
    { path: "design.md", size: 2048 },
    { path: "notes/phases.md", size: 512 },
  ],
  versions: [
    {
      number: 1,
      author: { id: 2, login: "bot", display_name: "Bot", kind: "machine" },
      message: null,
      created_at: "2026-08-12T05:00:00Z",
    },
    {
      number: 2,
      author: { id: 2, login: "bot", display_name: "Bot", kind: "machine" },
      message: "address review",
      created_at: "2026-08-12T06:00:00Z",
    },
  ],
};

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal("fetch", async () =>
    status === 200
      ? Response.json(body)
      : Response.json(
          { error: { code: "not_found", message: "this issue has no spec" } },
          { status },
        ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("SpecBlock", () => {
  it("renders version, review state, and the file list", async () => {
    stubFetch(200, INFO);
    const view = renderWithProviders(<SpecBlock slug="p" issueNumber={23} />);
    await waitFor(() => {
      expect(view.getByText("v2")).toBeTruthy();
    });
    expect(view.getByText("awaiting review")).toBeTruthy();
    expect(view.getByText("design.md")).toBeTruthy();
    expect(view.getByText("notes/phases.md")).toBeTruthy();
    expect(view.getByText("Read & review")).toBeTruthy();
  });

  it("renders nothing when the issue has no spec", async () => {
    stubFetch(404, null);
    const view = renderWithProviders(<SpecBlock slug="p" issueNumber={23} />);
    // The 404 resolves to null; the block must stay absent, not error.
    await waitFor(() => {
      expect(view.container.textContent).toBe("");
    });
  });
});
