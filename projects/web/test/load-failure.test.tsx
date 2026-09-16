import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LoadFailure } from "../src/components/shared/load-failure.tsx";
import { render } from "./render.tsx";

describe("LoadFailure", () => {
  it("retries exactly once per click", () => {
    const onRetry = vi.fn();
    render(
      <LoadFailure
        message="Failed."
        detail="boom"
        onRetry={onRetry}
        retrying={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("disables the button while retrying", () => {
    const onRetry = vi.fn();
    render(
      <LoadFailure
        message="Failed."
        detail="boom"
        onRetry={onRetry}
        retrying={true}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("puts the raw error on the message line's title, not the button's", () => {
    render(
      <LoadFailure
        message="Failed."
        detail="500 Internal"
        onRetry={() => {}}
        retrying={false}
      />,
    );
    const line = screen.getByText("Failed.");
    expect(line.getAttribute("title")).toBe("500 Internal");
    expect(
      screen.getByRole("button", { name: "Retry" }).getAttribute("title"),
    ).toBeNull();
  });
});
