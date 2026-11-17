import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type CompareSide,
  MediaCompare,
} from "../src/components/shared/media-compare.tsx";
import { resetCompareMode, setCompareMode } from "../src/lib/compare-mode.ts";

beforeEach(() => resetCompareMode());

// happy-dom never fires `load`, so these hand the sizes over directly.
const side = (
  label: string,
  size: CompareSide["size"],
  failed?: boolean,
): CompareSide => ({
  label,
  content: <img src={`/${label}.png`} alt={label} />,
  size,
  failed,
});

const SAME = { width: 720, height: 400 };

function renderCompare(
  props: Partial<Parameters<typeof MediaCompare>[0]> = {},
) {
  return render(
    <MediaCompare
      before={side("v2", SAME)}
      after={side("v5", SAME)}
      align="start"
      backdrop="checker"
      {...props}
    />,
  );
}

const mode = (name: string, scope: HTMLElement | Document = document) =>
  [
    ...scope.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Comparison"] button',
    ),
  ].find((button) => button.getAttribute("aria-label") === name) ??
  (() => {
    throw new Error(`no ${name} button`);
  })();

describe("MediaCompare (T-722)", () => {
  it("starts side by side, with every mode available once both sizes are known", () => {
    renderCompare();
    expect(mode("Side by side").getAttribute("aria-pressed")).toBe("true");
    for (const name of ["Swipe", "Onion skin", "Difference"]) {
      expect(mode(name).getAttribute("aria-pressed")).toBe("false");
      expect(mode(name).disabled).toBe(false);
    }
  });

  it("offers only side by side while a size is unknown, or a side failed", () => {
    for (const [before, after] of [
      [side("v2", null), side("v5", SAME)],
      [side("v2", SAME), side("v5", null, true)],
      [side("v2", SAME, true), side("v5", SAME)],
    ]) {
      const { unmount } = renderCompare({ before, after });
      expect(mode("Side by side").disabled).toBe(false);
      for (const name of ["Swipe", "Onion skin", "Difference"]) {
        expect(mode(name).disabled).toBe(true);
      }
      unmount();
    }
  });

  it("swipes with a range over the stage, cutting at its value", () => {
    const { container } = renderCompare();
    fireEvent.click(mode("Swipe"));
    const range = screen.getByRole("slider", {
      name: "Swipe between v2 (left) and v5 (right)",
    });
    fireEvent.change(range, { target: { value: "30" } });
    const stage = container.querySelector<HTMLElement>(
      ".media-compare-overlay",
    );
    expect(stage?.style.getPropertyValue("--cut")).toBe("30%");
  });

  it("fades the newer side with the onion-skin slider", () => {
    const { container } = renderCompare();
    fireEvent.click(mode("Onion skin"));
    fireEvent.change(screen.getByRole("slider", { name: "Opacity of v5" }), {
      target: { value: "20" },
    });
    const layer = container.querySelector<HTMLElement>(
      '.media-compare-layer[data-side="after"]',
    );
    expect(layer?.style.opacity).toBe("0.2");
  });

  it("marks only the dimension the two sides disagree on", () => {
    const { container } = renderCompare({
      before: side("v2", { width: 720, height: 400 }),
      after: side("v5", { width: 720, height: 460 }),
    });
    const marked = [...container.querySelectorAll("mark[data-changed]")].map(
      (mark) => mark.textContent,
    );
    expect(marked).toEqual(["400", "460"]);
  });

  it("titles each side's name with all of it, for when a long one is cut (T-767)", () => {
    const long = "Safari 18 on an iPhone 15 Pro";
    const { container } = renderCompare({ after: side(long, SAME) });
    const names = [
      ...container.querySelectorAll<HTMLElement>(".media-compare-label-name"),
    ];
    expect(names.map((name) => name.title)).toEqual(["v2", long]);
    expect(names[1].textContent).toBe(long);
  });

  it("switches every comparison on the page together", () => {
    const { container } = render(
      <>
        <div data-testid="one">
          <MediaCompare
            before={side("v2", SAME)}
            after={side("v5", SAME)}
            align="start"
            backdrop="checker"
          />
        </div>
        <div data-testid="two">
          <MediaCompare
            before={side("v2", SAME)}
            after={side("v5", SAME)}
            align="start"
            backdrop="checker"
          />
        </div>
      </>,
    );
    const [one, two] = [
      screen.getByTestId("one"),
      screen.getByTestId("two"),
    ] as const;
    act(() => fireEvent.click(mode("Difference", one)));
    expect(mode("Difference", two).getAttribute("aria-pressed")).toBe("true");
    expect(
      container.querySelectorAll('[data-mode="diff"].media-compare-overlay'),
    ).toHaveLength(2);
  });

  it("draws one side by side, without changing the page's mode, when it cannot overlay", () => {
    render(
      <>
        <div data-testid="ok">
          <MediaCompare
            before={side("v2", SAME)}
            after={side("v5", SAME)}
            align="start"
            backdrop="checker"
          />
        </div>
        <div data-testid="broken">
          <MediaCompare
            before={side("v2", null, true)}
            after={side("v5", SAME)}
            align="start"
            backdrop="checker"
          />
        </div>
      </>,
    );
    const ok = screen.getByTestId("ok");
    const broken = screen.getByTestId("broken");
    fireEvent.click(mode("Swipe", ok));
    expect(mode("Side by side", broken).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(broken.querySelector(".media-compare-2up")).not.toBeNull();
    expect(mode("Swipe", ok).getAttribute("aria-pressed")).toBe("true");
  });

  it("draws the replacement instead of a stage, with no mode pressed", () => {
    const { container } = renderCompare({
      replacement: <pre data-testid="source">diff</pre>,
    });
    expect(screen.getByTestId("source")).toBeTruthy();
    expect(container.querySelector(".media-compare-stage")).toBeNull();
    expect(
      container.querySelectorAll(
        '[aria-label="Comparison"] [aria-pressed="true"]',
      ),
    ).toHaveLength(0);
  });

  it("has Copy only with text, and puts actions in the head", () => {
    const { unmount } = renderCompare({
      actions: <button type="button">Source</button>,
    });
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    expect(document.querySelector(".fence-head")?.textContent).toContain(
      "Source",
    );
    unmount();
    renderCompare({ text: "graph TD" });
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });

  it("draws both sides at one scale, the wider one filling the pane", () => {
    const { container } = renderCompare({
      before: side("v2", { width: 400, height: 300 }),
      after: side("v5", { width: 800, height: 300 }),
    });
    const boxes = [
      ...container.querySelectorAll<HTMLElement>(
        ".media-compare-2up .media-compare-box",
      ),
    ];
    expect(boxes.map((box) => [box.style.width, box.style.maxWidth])).toEqual([
      ["50%", "400px"],
      ["100%", "800px"],
    ]);
  });
});

describe("MediaCompare modes and smallest scale (T-724)", () => {
  it("has no mode control with one mode, and stays side by side without touching the page's mode", () => {
    render(
      <>
        <div data-testid="one">
          <MediaCompare
            before={side("v2", SAME)}
            after={side("v5", SAME)}
            align="center"
            backdrop="page"
            modes={["2up"]}
          />
        </div>
        <div data-testid="all">
          <MediaCompare
            before={side("v2", SAME)}
            after={side("v5", SAME)}
            align="start"
            backdrop="checker"
          />
        </div>
      </>,
    );
    const one = screen.getByTestId("one");
    const all = screen.getByTestId("all");
    expect(one.querySelector('fieldset[aria-label="Comparison"]')).toBeNull();
    expect(one.querySelector(".fence-tools")?.hasAttribute("data-always")).toBe(
      true,
    );
    act(() => setCompareMode("swipe"));
    expect(one.querySelector(".media-compare-2up")).not.toBeNull();
    expect(one.querySelector(".media-compare-overlay")).toBeNull();
    expect(mode("Swipe", all).getAttribute("aria-pressed")).toBe("true");
  });

  it("offers only the modes it is given", () => {
    const { container } = renderCompare({ modes: ["2up", "swipe"] });
    expect(
      [...container.querySelectorAll('[aria-label="Comparison"] button')].map(
        (button) => button.getAttribute("aria-label"),
      ),
    ).toEqual(["Side by side", "Swipe"]);
  });

  it("gives side by side a smallest pane, scaled from the wider side", () => {
    const { container, unmount } = renderCompare({
      minScale: 0.75,
      before: side("v2", { width: 552, height: 328 }),
      after: side("v5", { width: 360, height: 328 }),
    });
    const grid = container.querySelector<HTMLElement>(".media-compare-2up");
    expect(grid?.hasAttribute("data-min-pane")).toBe(true);
    expect(grid?.style.getPropertyValue("--min-pane")).toBe("414px");
    unmount();

    const plain = renderCompare();
    expect(
      plain.container
        .querySelector(".media-compare-2up")
        ?.hasAttribute("data-min-pane"),
    ).toBe(false);
  });

  it("sizes the side that drew when the other failed", () => {
    const { container } = renderCompare({
      before: side("v2", null, true),
      after: side("v5", { width: 1456, height: 781 }),
    });
    const [failed, drawn] = container.querySelectorAll<HTMLElement>(
      ".media-compare-2up .media-compare-box",
    );
    expect(failed?.style.width).toBe("");
    expect(drawn?.style.maxWidth).toBe("1456px");
    expect(drawn?.style.width).toBe("100%");
  });
});
