import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageCanvas } from "../src/components/issue/image-canvas.tsx";

// A 1920×1080 screenshot in a 1280×800 window (T-780): the restored canvas
// measures 992×558, fit is 0.5167, and the dialog can grow it to 1216×600 —
// the window less 2rem and the dialog's 16px padding either side, by the
// canvas's 75vh cap — so the stops are contain 0.5556, cover 0.6333 and 1.
let style: HTMLStyleElement;
let dialog: HTMLElement;
let toolbar: HTMLElement;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this === document.documentElement ? 1280 : 992;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(558);
  Element.prototype.setPointerCapture ??= () => {};
  // happy-dom has no Tailwind, so the styles the stops are measured from are
  // given here.
  style = document.createElement("style");
  style.textContent = `
    html { font-size: 16px; }
    [data-testid="image-canvas"] { max-height: 600px; }
    #dialog { padding-left: 16px; padding-right: 16px; }
  `;
  document.head.append(style);
  dialog = document.createElement("div");
  dialog.id = "dialog";
  toolbar = document.createElement("div");
  document.body.append(dialog, toolbar);
});

afterEach(() => {
  vi.restoreAllMocks();
  style.remove();
  dialog.remove();
  toolbar.remove();
});

function Harness() {
  const lastHeight = useRef<number | null>(null);
  const widening = useRef({ asked: null, rest: null });
  return (
    <ImageCanvas
      src="/shot.png"
      alt="shot"
      maximized={false}
      toolbar={toolbar}
      lastHeight={lastHeight}
      held={null}
      dialog={dialog}
      widening={widening}
    />
  );
}

const canvas = () => screen.getByTestId("image-canvas");
const zoom = () => canvas().dataset.zoom;

function open() {
  render(<Harness />);
  const image = screen.getByRole("img", { name: "shot" });
  Object.defineProperty(image, "naturalWidth", { value: 1920 });
  Object.defineProperty(image, "naturalHeight", { value: 1080 });
  fireEvent.load(image);
  expect(canvas().dataset.fit).toBe("0.5167");
}

const scroll = () =>
  fireEvent.wheel(canvas(), { clientX: 496, clientY: 279, deltaY: -5 });

function click() {
  const at = { pointerId: 1, pointerType: "mouse", clientX: 496, clientY: 279 };
  fireEvent.pointerDown(canvas(), { ...at, button: 0 });
  fireEvent.pointerUp(canvas(), at);
}

describe("zoom stops (T-780)", () => {
  it("holds a trackpad scroll at contain, cover and actual pixels", () => {
    open();
    const seen: string[] = [];
    for (let i = 0; i < 140; i++) {
      scroll();
      seen.push(zoom() ?? "");
    }
    const held = (z: string) => seen.filter((s) => s === z).length;
    // ln 1.2 of travel at 0.01 an event.
    expect(held("0.5556")).toBeGreaterThanOrEqual(15);
    expect(held("0.6333")).toBeGreaterThanOrEqual(15);
    expect(held("1.0000")).toBeGreaterThanOrEqual(15);
    expect(Number(seen.at(-1))).toBeGreaterThan(1);
  });

  it("reads the scroll again from a zoom a click set", () => {
    open();
    for (let i = 0; i < 40 && zoom() !== "0.5556"; i++) scroll();
    scroll();
    expect(zoom()).toBe("0.5556");
    click();
    expect(zoom()).toBe("0.5167");
    click();
    expect(zoom()).toBe("1.0333");
    scroll();
    expect(Number(zoom())).toBeCloseTo(1.0333 * Math.exp(0.01), 3);
  });

  it("lets a touch pinch through the stops with the fingers", () => {
    open();
    const finger = (pointerId: number, clientX: number) => ({
      pointerId,
      pointerType: "touch",
      clientX,
      clientY: 279,
    });
    fireEvent.pointerDown(canvas(), finger(1, 400));
    fireEvent.pointerDown(canvas(), finger(2, 500));
    for (let x = 502; x <= 530; x += 2)
      fireEvent.pointerMove(canvas(), finger(2, x));
    expect(Number(zoom())).toBeCloseTo((992 / 1920) * 1.3, 4);
  });

  it("stops + on contain", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "zoom in" }));
    expect(zoom()).toBe("0.5556");
  });
});
