import { describe, expect, it } from "vitest";
import {
  ProjectIcon,
  projectIconFallback,
} from "../src/components/shared/project-icon.tsx";
import { projectTint } from "../src/lib/project-tint.ts";
import { render } from "./render.tsx";

const draw = (project: {
  slug?: string;
  name: string;
  prefix?: string | null;
  icon_url?: string | null;
}) =>
  render(<ProjectIcon project={{ slug: "homelab", ...project }} />).container;

describe("what a project icon draws", () => {
  // The loaded-image path is not assertable here: Radix mounts the <img>
  // only once it loads, and happy-dom never fetches, so both the "has icon"
  // and "no icon" cases render the fallback and nothing else. That the URL is
  // minted and served is covered end to end by the server's
  // project-icon.test.ts; that it reaches the screen is a browser check.

  it("falls back to the bare REF, which is the everyday case", () => {
    // Most projects never upload an icon, so this is what is usually on
    // screen — and `CH` identifies a project better than `H` does.
    const container = draw({ name: "Homelab", prefix: "CH", icon_url: null });
    expect(container.textContent).toBe("CH");
    expect(container.textContent).not.toContain("-");
  });

  it("falls back to initials only when there is no REF either", () => {
    const container = draw({ name: "Home Lab", prefix: null, icon_url: null });
    expect(container.textContent).toBe("HL");
  });

  it("keeps a long REF inside its box instead of across the card", () => {
    // A 20-character prefix drew 192px of ink in a 40px box and ran straight
    // through the project's title.
    const container = draw({ name: "Pathological", prefix: "W".repeat(20) });
    expect(container.textContent).toBe("WWW");
    expect(
      container.querySelector('[data-slot="avatar"]')?.className,
    ).toContain("overflow-hidden");
  });

  it("leaves a REF that already fits alone", () => {
    expect(draw({ name: "Homelab", prefix: "CH" }).textContent).toBe("CH");
    expect(draw({ name: "Warehouse", prefix: "WMS" }).textContent).toBe("WMS");
  });

  // Asserted on the function and not only through `ProjectIcon`, because the
  // settings page's icon editor draws its box through `AvatarEditor` and
  // reaches this rule only by calling it.
  it("cuts a long REF to the same three characters wherever it is called", () => {
    const glyph = projectIconFallback({
      slug: "pathological",
      name: "Pathological",
      prefix: "W".repeat(20),
    });
    expect(render(glyph).container.textContent).toBe("WWW");
  });

  it("falls back to initials when called with no REF", () => {
    const glyph = projectIconFallback({
      slug: "home-lab",
      name: "Home Lab",
      prefix: null,
    });
    expect(render(glyph).container.textContent).toBe("HL");
  });

  it("is square, so a project never reads as a person", () => {
    const container = draw({ name: "Homelab", prefix: "CH" });
    expect(
      container
        .querySelector('[data-slot="avatar"]')
        ?.getAttribute("data-shape"),
    ).toBe("square");
  });

  it("paints the fallback in the tint hashed from the slug", () => {
    const container = draw({ slug: "todou", name: "todou", prefix: "T" });
    const stops = [...container.querySelectorAll("stop")].map((stop) =>
      stop.getAttribute("stop-color"),
    );
    const { from, to } = projectTint("todou");
    expect(stops).toEqual([from, to]);
  });

  it("gives every icon on a page its own gradient", () => {
    // Two rows naming the same project is the ordinary case (a search list);
    // with one id between them, either could paint from the other.
    const { container } = render(
      <>
        <ProjectIcon project={{ slug: "todou", name: "todou", prefix: "T" }} />
        <ProjectIcon project={{ slug: "todou", name: "todou", prefix: "T" }} />
      </>,
    );
    const ids = [...container.querySelectorAll("linearGradient")].map(
      (gradient) => gradient.id,
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const [index, rect] of [
      ...container.querySelectorAll("rect"),
    ].entries()) {
      expect(rect.getAttribute("fill")).toBe(`url(#${ids[index]})`);
    }
  });
});
