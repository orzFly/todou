import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AttachmentViewerDialog,
  type CompareImage,
  type ComparePair,
  type ViewerState,
} from "../src/components/issue/attachment-viewer.tsx";
import { resetCompareMode, setCompareMode } from "../src/lib/compare-mode.ts";

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetCompareMode();
});

const image = (
  label: string,
  filename: string,
  extra: Partial<CompareImage> = {},
): CompareImage => ({
  label,
  src: `/api/projects/a/attachments/${label}/download/${filename}`,
  filename,
  size: { width: 720, height: 400 },
  ...extra,
});

const pair = (name: string, afterName = name): ComparePair => ({
  before: image("v1", name, { contentType: "image/png", bytes: 48 * 1024 }),
  after: image("v2", afterName, {
    contentType: "image/png",
    bytes: 52 * 1024,
  }),
});

function Viewer({
  pairs,
  index = 0,
}: {
  pairs: ComparePair[];
  index?: number;
}) {
  const [state, setState] = useState<ViewerState | null>({
    compare: pairs,
    index,
  });
  return (
    <AttachmentViewerDialog
      state={state}
      onNavigate={(i) => setState((s) => s && { ...s, index: i })}
      onClose={() => setState(null)}
    />
  );
}

const title = () => screen.getByRole("heading").textContent;

describe("the viewer's comparison form", () => {
  it("titles a pair by the new name, or by both when they differ", () => {
    const { unmount } = render(<Viewer pairs={[pair("login.png")]} />);
    expect(title()).toBe("login.png");
    unmount();
    render(<Viewer pairs={[pair("login.png", "sign-in.png")]} />);
    expect(title()).toBe("login.png → sign-in.png");
  });

  it("offers each side for download under its own name", () => {
    render(<Viewer pairs={[pair("login.png", "sign-in.png")]} />);
    const before = screen.getByRole("link", { name: "Download v1" });
    const after = screen.getByRole("link", { name: "Download v2" });
    expect(before.getAttribute("href")).toBe(
      "/api/projects/a/attachments/v1/download/login.png",
    );
    expect(before.getAttribute("download")).toBe("login.png");
    expect(after.getAttribute("download")).toBe("sign-in.png");
    expect(screen.getByText("image/png · 48 KB → 52 KB")).toBeTruthy();
    expect(screen.queryByText("Open in new tab")).toBeNull();
  });

  it("pages through the comparisons in order and wraps round", () => {
    render(<Viewer pairs={[pair("a.png"), pair("b.png"), pair("c.png")]} />);
    expect(title()).toBe("a.png");
    expect(screen.getByText("1 / 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "next comparison" }));
    expect(title()).toBe("b.png");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
    expect(title()).toBe("c.png");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
    expect(title()).toBe("a.png");
    fireEvent.click(
      screen.getByRole("button", { name: "previous comparison" }),
    );
    expect(title()).toBe("c.png");
  });

  it("has no paging for a lone comparison", () => {
    render(<Viewer pairs={[pair("a.png")]} />);
    expect(
      screen.queryByRole("button", { name: "next comparison" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "previous comparison" }),
    ).toBeNull();
  });

  it("leaves the arrows to a focused swipe slider", () => {
    setCompareMode("swipe");
    render(<Viewer pairs={[pair("a.png"), pair("b.png")]} />);
    const slider = screen.getByRole("slider", {
      name: "Swipe between v1 (left) and v2 (right)",
    });
    slider.focus();
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(title()).toBe("a.png");
    // Off the slider the same key pages.
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
    expect(title()).toBe("b.png");
  });
});
