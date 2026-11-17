import { beforeEach, describe, expect, it, vi } from "vitest";
import { type DiagramPalette, renderDiagram } from "../src/lib/mermaid.ts";

// happy-dom cannot lay a diagram out, so mermaid is replaced by a stand-in
// that draws its scratch node the way mermaid does and reports where it went.
const seen = vi.hoisted(() => ({
  container: undefined as Element | undefined,
  visibility: "",
  position: "",
  fail: false,
}));
vi.mock("mermaid", () => ({
  default: {
    initialize: () => {},
    parse: async () => true,
    render: async (id: string, _source: string, container?: Element) => {
      const scratch = document.createElement("div");
      scratch.id = `d${id}`;
      (container ?? document.body).append(scratch);
      seen.container = container;
      if (container !== undefined) {
        const style = getComputedStyle(container);
        seen.visibility = style.visibility;
        seen.position = style.position;
      }
      if (seen.fail) throw new Error("draw failed");
      scratch.remove();
      return { svg: `<svg id="${id}" viewBox="0 0 120 40"></svg>` };
    },
  },
}));

const PALETTE: DiagramPalette = {
  dark: false,
  background: "#ffffff",
  foreground: "#000000",
  muted: "#eeeeee",
  mutedForeground: "#666666",
  border: "#dddddd",
};

beforeEach(() => {
  seen.container = undefined;
  seen.fail = false;
});

describe("renderDiagram scratch drawing (T-703)", () => {
  it("draws off the page, in a host that is gone once the diagram is back", async () => {
    const result = await renderDiagram("flowchart LR\n  A", PALETTE, "serif");
    expect(result).toEqual({
      ok: true,
      svg: expect.any(String),
      width: 120,
      height: 40,
    });
    expect(seen.container).toBeDefined();
    expect(seen.visibility).toBe("hidden");
    expect(seen.position).toBe("fixed");
    expect(seen.container?.isConnected).toBe(false);
    expect(document.body.childElementCount).toBe(0);
  });

  it("takes the half-drawn diagram down with it when drawing throws", async () => {
    seen.fail = true;
    const result = await renderDiagram("flowchart LR\n  A", PALETTE, "serif");
    expect(result).toEqual({ ok: false, error: "draw failed" });
    expect(seen.container?.isConnected).toBe(false);
    expect(document.querySelector('[id^="dmermaid-"]')).toBeNull();
  });
});
