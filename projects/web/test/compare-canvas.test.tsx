import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComparePair } from "../src/components/issue/attachment-viewer.tsx";
import {
  CompareBar,
  CompareCanvas,
} from "../src/components/issue/compare-canvas.tsx";
import {
  resetCompareMode,
  setCompareMode,
  useCompareMode,
} from "../src/lib/compare-mode.ts";

const PAIR: ComparePair = {
  before: {
    label: "v2",
    src: "/before.png",
    filename: "shot.png",
    size: { width: 400, height: 300 },
  },
  after: {
    label: "v5",
    src: "/after.png",
    filename: "shot.png",
    size: { width: 400, height: 340 },
  },
};

// happy-dom lays nothing out; the canvas measures as 800×600, which puts a
// 400-wide pair side by side with the second pane from x = 404.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  Element.prototype.setPointerCapture ??= () => {};
});

afterEach(() => {
  vi.restoreAllMocks();
  resetCompareMode();
});

function Harness({ toolbar }: { toolbar?: HTMLElement }) {
  const [cut, setCut] = useState(50);
  const [fade, setFade] = useState(50);
  const lastHeight = useRef<number | null>(null);
  const widening = useRef({ asked: null, rest: null });
  return (
    <>
      <CompareCanvas
        pair={PAIR}
        maximized={false}
        toolbar={toolbar ?? null}
        lastHeight={lastHeight}
        held={null}
        dialog={null}
        widening={widening}
        cut={cut}
        onCut={setCut}
        fade={fade}
      />
      <CompareBar pair={PAIR} fade={fade} onFade={setFade} />
    </>
  );
}

const canvas = () => screen.getByTestId("compare-canvas");
const transforms = () =>
  [...canvas().querySelectorAll("img")].map((img) => img.style.transform);

describe("CompareCanvas", () => {
  it("draws both panes side by side with one transform", () => {
    render(<Harness />);
    expect(canvas().dataset.direction).toBe("row");
    const [a, b] = transforms();
    expect(a).toMatch(/^translate\(.+\) scale\(.+\)$/);
    expect(b).toBe(a);
  });

  it("zooms both panes from a wheel over the second", () => {
    render(<Harness />);
    const [start] = transforms();
    fireEvent.wheel(canvas(), { clientX: 600, clientY: 150, deltaY: -200 });
    const [a, b] = transforms();
    expect(a).not.toBe(start);
    expect(b).toBe(a);
    expect(Number(canvas().dataset.zoom)).toBeGreaterThan(
      Number(canvas().dataset.fit),
    );
  });

  it("moves the swipe split from its slider, never from a drag", () => {
    setCompareMode("swipe");
    render(<Harness />);
    const cut = () => canvas().style.getPropertyValue("--cut");
    expect(cut()).toBe("50%");
    fireEvent.change(
      screen.getByRole("slider", {
        name: "Swipe between v2 (left) and v5 (right)",
      }),
      { target: { value: "30" } },
    );
    expect(cut()).toBe("30%");
    fireEvent.pointerDown(canvas(), {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(canvas(), {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 300,
      clientY: 120,
    });
    fireEvent.pointerUp(canvas(), {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 300,
      clientY: 120,
    });
    expect(cut()).toBe("30%");
  });

  it("fades the new side from the onion slider", () => {
    setCompareMode("onion");
    render(<Harness />);
    fireEvent.change(screen.getByRole("slider", { name: "Opacity of v5" }), {
      target: { value: "20" },
    });
    const layer = canvas().querySelector<HTMLElement>(
      '.compare-viewer-layer[data-side="after"]',
    );
    expect(layer?.style.opacity).toBe("0.2");
  });

  it("writes a mode chosen in the bar to the page's shared mode", () => {
    let seen = "";
    function Reader() {
      seen = useCompareMode();
      return null;
    }
    render(
      <>
        <Harness />
        <Reader />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Difference" }));
    expect(seen).toBe("diff");
    expect(canvas().dataset.mode).toBe("diff");
  });

  // T-770: the render that switches to side by side ran before the canvas
  // was re-measured, against the single pane an overlay mode is cut into.
  it.each(["swipe", "onion", "diff"] as const)(
    "goes from %s to side by side with both panes",
    (mode) => {
      setCompareMode(mode);
      render(<Harness />);
      fireEvent.click(screen.getByRole("button", { name: "Side by side" }));
      expect(canvas().dataset.mode).toBe("2up");
      expect(canvas().dataset.direction).toBe("row");
      const [a, b] = transforms();
      expect(b).toBe(a);
      fireEvent.click(screen.getByRole("button", { name: "Swipe" }));
      fireEvent.click(screen.getByRole("button", { name: "Side by side" }));
      expect(transforms()).toHaveLength(2);
    },
  );

  it("disables the zoom controls once an image fails to load", () => {
    const toolbar = document.createElement("div");
    document.body.append(toolbar);
    render(<Harness toolbar={toolbar} />);
    const readout = () =>
      screen.getByRole("button", { name: "zoom and display options" });
    expect(readout()).not.toHaveProperty("disabled", true);
    act(() => {
      fireEvent.error(canvas().querySelectorAll("img")[1]);
    });
    expect(readout()).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "zoom in" })).toHaveProperty(
      "disabled",
      true,
    );
    toolbar.remove();
  });
});
