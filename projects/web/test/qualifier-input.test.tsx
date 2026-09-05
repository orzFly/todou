import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QualifierInput } from "../src/components/search/qualifier-input.tsx";

/** The mirror renders whatever it is handed; these tests only need spans. */
const render1 = (value: string) => (
  <span className="text-primary">{value}</span>
);

function mount(value = "harness:codex") {
  const utils = render(
    <QualifierInput
      value={value}
      onValueChange={() => {}}
      render={render1}
      aria-label="Search"
    />,
  );
  const input = utils.getByLabelText("Search") as HTMLInputElement;
  const mirror = utils.container.querySelector("[aria-hidden]") as HTMLElement;
  return { ...utils, input, mirror };
}

describe("QualifierInput", () => {
  it("paints the string through the mirror and keeps the input transparent", () => {
    const { input, mirror } = mount();
    expect(mirror.textContent).toBe("harness:codex");
    expect(input.className).toContain("text-transparent");
    expect(input.className).toContain("caret-foreground");
    expect(mirror.getAttribute("aria-hidden")).toBe("true");
  });

  it("hands the two layers the same metrics", () => {
    // Anything that differs here moves one layer relative to the other, and
    // the caret then stands beside its character instead of on it.
    const { input, mirror } = mount();
    for (const cls of ["px-2.5", "py-1", "text-base", "md:text-sm"]) {
      expect(input.className).toContain(cls);
      expect(mirror.className).toContain(cls);
    }
  });

  it("swaps the layers while an IME is composing", () => {
    // Pre-commit text is drawn by the browser inside the input; a transparent
    // input would swallow it, and most queries here are Chinese.
    const { input, mirror } = mount();
    fireEvent.compositionStart(input);
    expect(input.className).toContain("text-foreground");
    expect(input.className).not.toContain(" text-transparent");
    expect(mirror.className).toContain("[&_span]:text-transparent");

    fireEvent.compositionEnd(input);
    expect(input.className).toContain("text-transparent");
    expect(mirror.className).not.toContain("[&_span]:text-transparent");
  });

  it("keeps the selection translucent so the mirror shows through it", () => {
    expect(mount().input.className).toContain("selection:bg-primary/30");
  });

  it("reports where the caret is", () => {
    const seen: number[] = [];
    const utils = render(
      <QualifierInput
        value="harness:codex"
        onValueChange={() => {}}
        render={render1}
        onCaretChange={(p) => seen.push(p.caret)}
        aria-label="Search"
      />,
    );
    const input = utils.getByLabelText("Search") as HTMLInputElement;
    input.setSelectionRange(8, 8);
    fireEvent.select(input);
    expect(seen.at(-1)).toBe(8);
  });
});
