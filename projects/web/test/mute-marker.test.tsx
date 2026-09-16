import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UnreadMarker } from "../src/components/issue/unread-marker.tsx";

describe("UnreadMarker muted states (T-372)", () => {
  it.each(["forever", "until_activity", "project"] as const)(
    "dims the count badge and says so for %s",
    (muted) => {
      const { container } = render(
        <UnreadMarker unread unreadComments={3} muted={muted} />,
      );
      const badge = container.querySelector("span");
      expect(badge).toBeTruthy();
      expect(badge?.className).toContain("bg-muted-foreground/70");
      expect(badge?.className).not.toContain("bg-blue-600");
      expect(badge?.getAttribute("title")).toContain(
        muted === "project"
          ? "the whole project is muted"
          : "this card is muted",
      );
    },
  );

  it.each(["forever", "until_activity", "project"] as const)(
    "dims the hollow ring for %s",
    (muted) => {
      const { container } = render(
        <UnreadMarker unread unreadComments={0} muted={muted} />,
      );
      const ring = container.querySelector("span");
      expect(ring).toBeTruthy();
      expect(ring?.className).toContain("border-muted-foreground/60");
      expect(ring?.className).not.toContain("border-blue-500");
    },
  );

  it("stays exactly as before when not muted", () => {
    const { container } = render(
      <UnreadMarker unread unreadComments={3} muted={null} />,
    );
    const badge = container.querySelector("span");
    expect(badge?.className).toContain("bg-blue-600");
    expect(badge?.getAttribute("title")).toBe(
      "3 new comments since you last viewed",
    );
  });
});
