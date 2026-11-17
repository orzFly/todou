import { act, fireEvent, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FenceFrame } from "../src/components/shared/fence-frame.tsx";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(toast.error).mockClear();
});

const TEXT = "const a = 1;\nconst b = 2;";

function liveText(container: HTMLElement): string {
  return container.querySelector("[aria-live]")?.textContent ?? "";
}

describe("FenceFrame", () => {
  it("floats a toolbar with the language and Copy, and no header", () => {
    const { container } = render(
      <FenceFrame text={TEXT} lang="ts">
        <pre>{TEXT}</pre>
      </FenceFrame>,
    );
    const tools = container.querySelector(".fence-tools");
    expect(tools?.textContent).toContain("ts");
    expect(tools?.className).toContain("select-none");
    // Floating, it covered the end of the first line wherever it showed.
    expect(tools?.className).not.toMatch(/\babsolute\b/);
    expect(tools?.hasAttribute("data-always")).toBe(false);
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(container.querySelector(".fence-head")).toBeNull();
  });

  it("copies the text and says so on the button for 1.5 s", async () => {
    vi.useFakeTimers();
    const { container } = render(
      <FenceFrame text={TEXT} lang="ts">
        <pre>{TEXT}</pre>
      </FenceFrame>,
    );
    const copy = screen.getByRole("button", { name: "Copy" });
    await act(async () => {
      fireEvent.click(copy);
    });
    expect(writeText).toHaveBeenCalledWith(TEXT);
    expect(copy.querySelector("[data-icon=copied]")).not.toBeNull();
    expect(liveText(container)).toBe("Copied");
    expect(toast.success).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(copy.querySelector("[data-icon=copied]")).toBeNull();
    expect(liveText(container)).toBe("");
  });

  it("toasts when there is no clipboard, and claims nothing", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    const { container } = render(
      <FenceFrame text={TEXT}>
        <pre>{TEXT}</pre>
      </FenceFrame>,
    );
    const copy = screen.getByRole("button", { name: "Copy" });
    await act(async () => {
      fireEvent.click(copy);
    });
    expect(toast.error).toHaveBeenCalledOnce();
    expect(copy.querySelector("[data-icon=copied]")).toBeNull();
    expect(liveText(container)).toBe("");
  });

  it("caps a collapsible block in a focusable scroller that Expand lifts", () => {
    render(
      <FenceFrame text={TEXT} collapsible>
        <pre>{TEXT}</pre>
      </FenceFrame>,
    );
    const scroller = screen.getByRole("region", { name: "Code" });
    expect(scroller.tabIndex).toBe(0);
    expect(scroller.hasAttribute("data-expanded")).toBe(false);
    const expand = screen.getByRole("button", { name: "Expand" });
    expect(expand.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(expand);
    expect(scroller.hasAttribute("data-expanded")).toBe(true);
    const collapse = screen.getByRole("button", { name: "Collapse" });
    expect(collapse.getAttribute("aria-pressed")).toBe("true");
  });

  it("has neither scroller nor Expand when not collapsible", () => {
    render(
      <FenceFrame text={TEXT}>
        <pre>{TEXT}</pre>
      </FenceFrame>,
    );
    expect(screen.queryByRole("region", { name: "Code" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Expand" })).toBeNull();
  });

  it("heads a named block with a download of it, and revokes it on unmount", () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const { container, unmount } = render(
      <FenceFrame text={TEXT} lang="yaml" title="compose.yaml">
        <pre>{TEXT}</pre>
      </FenceFrame>,
    );
    const link = container.querySelector('a[download="compose.yaml"]');
    expect(link?.getAttribute("href")).toMatch(/^blob:/);
    expect(container.querySelector(".fence-head")?.className).toContain(
      "select-none",
    );
    expect(container.querySelector(".fence-tools")).toBeNull();
    expect(
      [...container.querySelectorAll("span")].some(
        (span) => span.textContent === "yaml",
      ),
    ).toBe(false);
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();

    unmount();
    expect(revoke).toHaveBeenCalledWith("blob:x");
  });

  it("keeps the toolbar up when asked to", () => {
    const { container } = render(
      <FenceFrame text={TEXT} toolbarAlwaysVisible>
        <pre>{TEXT}</pre>
      </FenceFrame>,
    );
    expect(
      container.querySelector(".fence-tools")?.hasAttribute("data-always"),
    ).toBe(true);
  });

  it("has no Copy when it is given no text", () => {
    render(
      <FenceFrame lang="ts">
        <pre>{TEXT}</pre>
      </FenceFrame>,
    );
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });

  it("puts `leading` in a standing header instead of the floating toolbar", () => {
    const { container } = render(
      <FenceFrame leading={<button type="button">Mode</button>}>
        <div />
      </FenceFrame>,
    );
    const head = container.querySelector(".fence-head");
    expect(head?.querySelector("button")?.textContent).toBe("Mode");
    expect(container.querySelector(".fence-tools")).toBeNull();
  });
});
