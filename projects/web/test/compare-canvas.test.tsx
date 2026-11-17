import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

function Harness({
  toolbar,
  pair = PAIR,
}: {
  toolbar?: HTMLElement;
  pair?: ComparePair;
}) {
  const [cut, setCut] = useState(50);
  const [fade, setFade] = useState(50);
  const lastHeight = useRef<number | null>(null);
  const widening = useRef({ asked: null, rest: null });
  return (
    <>
      <CompareCanvas
        pair={pair}
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
      <CompareBar pair={pair} fade={fade} onFade={setFade} />
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

// Wider than tall by far: images this shape stack, diagrams never do.
const DIAGRAMS: ComparePair = {
  kind: "diagram",
  key: "d1",
  title: "flow.mmd",
  diagramType: "sequence",
  before: {
    label: "v1",
    svg: '<svg data-side-svg="before"></svg>',
    source: "sequenceDiagram\n  A->>B: hi",
    size: { width: 2000, height: 400 },
  },
  after: {
    label: "v2",
    svg: '<svg data-side-svg="after"></svg>',
    source: "sequenceDiagram\n  A->>B: hello",
    size: { width: 2000, height: 400 },
  },
};

describe("CompareCanvas with diagrams (T-773)", () => {
  const drawings = () => [
    ...canvas().querySelectorAll<HTMLElement>(".compare-diagram"),
  ];

  it("stays side by side, left and right, whatever the page's mode", () => {
    setCompareMode("swipe");
    let seen = "";
    function Reader() {
      seen = useCompareMode();
      return null;
    }
    render(
      <>
        <Harness pair={DIAGRAMS} />
        <Reader />
      </>,
    );
    expect(canvas().dataset.mode).toBe("2up");
    expect(canvas().dataset.direction).toBe("row");
    expect(seen).toBe("swipe");
    expect(screen.queryByRole("group", { name: "Comparison" })).toBeNull();
    expect(
      [...canvas().querySelectorAll<HTMLElement>(".compare-viewer-pane")].map(
        (pane) => [pane.style.left, pane.style.top],
      ),
    ).toEqual([
      ["0px", "0px"],
      ["404px", "0px"],
    ]);
  });

  it("draws each side's SVG at its natural size under one transform, with no checkerboard", () => {
    render(<Harness pair={DIAGRAMS} />);
    const [a, b] = drawings();
    expect(a?.querySelector('svg[data-side-svg="before"]')).not.toBeNull();
    expect(b?.querySelector('svg[data-side-svg="after"]')).not.toBeNull();
    expect(a?.style.width).toBe("2000px");
    expect(a?.style.transform).toMatch(/^translate\(.+\) scale\(.+\)$/);
    expect(b?.style.transform).toBe(a?.style.transform);
    expect(canvas().querySelectorAll("img")).toHaveLength(0);
    for (const pane of canvas().querySelectorAll(".compare-viewer-pane"))
      expect(pane.querySelector('[aria-hidden="true"]')).toBeNull();
    fireEvent.wheel(canvas(), { clientX: 600, clientY: 150, deltaY: -200 });
    const [c, d] = drawings();
    expect(Number(canvas().dataset.zoom)).toBeGreaterThan(
      Number(canvas().dataset.fit),
    );
    expect(d?.style.transform).toBe(c?.style.transform);
  });

  it("offers only fit and 100% in the zoom menu", async () => {
    const toolbar = document.createElement("div");
    document.body.append(toolbar);
    render(<Harness toolbar={toolbar} pair={DIAGRAMS} />);
    const readout = screen.getByRole("button", {
      name: "zoom and display options",
    });
    fireEvent.pointerDown(readout, { button: 0, pointerType: "mouse" });
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Fit0", "100%1"]);
    expect(screen.queryByText("Background")).toBeNull();
    expect(screen.queryByText("Scaling")).toBeNull();
    toolbar.remove();
  });
});
