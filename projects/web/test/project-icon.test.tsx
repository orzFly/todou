import { describe, expect, it } from "vitest";
import { ProjectIcon } from "../src/components/shared/project-icon.tsx";
import { render } from "./render.tsx";

const draw = (project: {
  name: string;
  prefix?: string | null;
  icon_url?: string | null;
}) => render(<ProjectIcon project={project} />).container;

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

  it("is square, so a project never reads as a person", () => {
    const container = draw({ name: "Homelab", prefix: "CH" });
    expect(
      container
        .querySelector('[data-slot="avatar"]')
        ?.getAttribute("data-shape"),
    ).toBe("square");
  });
});
