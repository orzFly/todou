import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UnreadBadge } from "../src/components/unread-badge.tsx";

describe("UnreadBadge", () => {
  it("shows nothing at zero", () => {
    const view = render(<UnreadBadge count={0} />);
    expect(view.container.textContent).toBe("");
    expect(view.container.querySelector("span")).toBeNull();
  });

  it("shows the count as-is up to 99", () => {
    expect(render(<UnreadBadge count={1} />).container.textContent).toBe("1");
    expect(render(<UnreadBadge count={99} />).container.textContent).toBe("99");
  });

  it("caps beyond 99", () => {
    expect(render(<UnreadBadge count={120} />).container.textContent).toBe(
      "99+",
    );
  });

  it("keeps the pill classes and merges the caller's placement", () => {
    const badge = render(
      <UnreadBadge count={3} className="ml-auto shrink-0" />,
    ).container.querySelector("span");
    expect(badge?.classList.contains("ml-auto")).toBe(true);
    expect(badge?.classList.contains("shrink-0")).toBe(true);
    expect(badge?.classList.contains("bg-blue-600")).toBe(true);
    expect(badge?.classList.contains("rounded-full")).toBe(true);
  });

  it("stays out of the accessibility tree", () => {
    const badge = render(<UnreadBadge count={3} />).container.querySelector(
      "span",
    );
    expect(badge?.getAttribute("aria-hidden")).toBe("true");
  });
});
