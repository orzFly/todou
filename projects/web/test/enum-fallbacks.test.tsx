import { render } from "@testing-library/react";
import type { MuteList, SpecReviewStatus } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { muteLabelOf, muteOf } from "../src/api/mutes.ts";
import {
  SpecStatusBadge,
  specStatusLabel,
  specStatusStyle,
} from "../src/components/issue/spec-entry.tsx";
import { specReviewVerdictLabel } from "../src/components/spec/use-review-completion.ts";
import { roleDotOf } from "../src/lib/roles.ts";

describe("server enum fallbacks", () => {
  it("distinguishes no mute row from a row missing its required mode", () => {
    expect(muteOf(undefined, "p", 7)).toBeUndefined();
    expect(muteOf({ projects: [], issues: [] }, "p", 7)).toBeUndefined();
    const mutes = {
      projects: [],
      issues: [
        {
          project: { slug: "p", name: "Project" },
          number: 7,
          title: "Card",
          muted_at: "2026-09-19T00:00:00Z",
        },
      ],
    } as unknown as MuteList;
    expect(() => muteOf(mutes, "p", 7)).toThrow(TypeError);
  });

  it.each(["future_review_state", "constructor", "__proto__"])(
    "keeps unknown spec status %s visible in the actual badge",
    (value) => {
      const status = value as SpecReviewStatus;
      const view = render(<SpecStatusBadge status={status} />);
      expect(view.container.textContent).toBe(
        `unknown status: ${value}`,
      );
      expect(view.container.firstElementChild?.className).toContain(
        "text-muted-foreground",
      );
      expect(view.container.textContent).not.toContain("undefined");
    },
  );

  it.each([
    ["unreviewed", "awaiting review", "text-amber-700"],
    ["approved", "approved", "text-green-700"],
    ["changes_requested", "changes requested", "text-red-700"],
  ] as const)(
    "preserves known status %s label and styling",
    (status, label, style) => {
      const view = render(<SpecStatusBadge status={status} />);
      expect(view.container.textContent).toBe(label);
      expect(view.container.firstElementChild?.className).toContain(style);
    },
  );

  it("keeps unknown review results, mute modes, and role dots readable", () => {
    expect(specReviewVerdictLabel("future_verdict")).toBe(
      'Reviewed ("future_verdict")',
    );
    expect(muteLabelOf("future_mute_mode")).toBe(
      'unknown mute mode ("future_mute_mode")',
    );
    expect(roleDotOf("future_role")).toBe("bg-muted-foreground");
    expect(muteLabelOf("forever")).toBe("Quiet until unmuted");
    expect(muteLabelOf("until_activity")).toBe("Quiet until new activity");
    expect(specReviewVerdictLabel("approve")).toBe("Approved");
    expect(specReviewVerdictLabel("request_changes")).toBe(
      "Requested changes on",
    );
    expect(specReviewVerdictLabel("comment")).toBe("Commented on");
  });

  it.each([undefined, null, "", 42])(
    "does not call a missing or malformed required value an unknown enum: %j",
    (invalid) => {
      // Runtime server data bypasses the TS interface; schemas remain unchanged.
      const value = invalid as string;
      for (const display of [
        specStatusLabel,
        specStatusStyle,
        specReviewVerdictLabel,
        muteLabelOf,
        roleDotOf,
      ]) {
        expect(() => display(value)).toThrow(TypeError);
      }
      const status = value as SpecReviewStatus;
      expect(() => render(<SpecStatusBadge status={status} />)).toThrow(
        TypeError,
      );
    },
  );
});
