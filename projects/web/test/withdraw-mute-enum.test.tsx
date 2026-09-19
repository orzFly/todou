import { QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { MuteReason, SpecInfo } from "@todou/shared";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnreadMarker } from "../src/components/issue/unread-marker.tsx";
import { WithdrawSpec } from "../src/components/spec/withdraw-spec.tsx";
import { testQueryClient } from "./render.tsx";

const withdrawal = vi.hoisted(() => ({
  isPending: false,
  error: null,
  mutate: vi.fn(),
  reset: vi.fn(),
}));
vi.mock("../src/api/spec.ts", () => ({
  useWithdrawSpec: () => withdrawal,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const spec: SpecInfo = {
  current_version: 1,
  current_version_cursor: "c1",
  review_status: "unreviewed",
  unresolved_comments: 0,
  unresolved_carried_comments: 0,
  files: [],
  versions: [],
};

// Inject wire values directly into the consumers, bypassing schema parsing.
function withdrawElement(reviewStatus: unknown) {
  return (
    <WithdrawSpec
      slug="demo"
      issueNumber={1}
      version={1}
      spec={{
        ...spec,
        review_status: reviewStatus as SpecInfo["review_status"],
      }}
    />
  );
}

function mountWithdrawal(reviewStatus: unknown) {
  const client = testQueryClient();
  client.setQueryDefaults(["project", "demo"], { staleTime: Infinity });
  client.setQueryData(["project", "demo"], { viewer_role: "writer" });
  return render(withdrawElement(reviewStatus), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

function openWithdrawal() {
  fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByRole("textbox"), {
    target: { value: "Keep this reason" },
  });
  return dialog;
}

const futureValues = ["future_value", "constructor", "__proto__"];
const malformedValues = ["", 7, false, {}, []];

describe("WithdrawSpec review status compatibility", () => {
  it.each(futureValues)(
    "keeps an open draft disabled with a neutral reason for %s",
    (value) => {
      const view = mountWithdrawal("unreviewed");
      const dialog = openWithdrawal();
      view.rerender(withdrawElement(value));

      const message = `Withdrawal is unavailable for review status: ${value}.`;
      // The old binary fallback fails these assertions: it calls every future
      // status already reviewed, even though the button stays disabled.
      expect(within(dialog).getByRole("status").textContent).toBe(message);
      expect(dialog.textContent).not.toContain("already been reviewed");
      expect(
        (within(dialog).getByRole("textbox") as HTMLTextAreaElement).value,
      ).toBe("Keep this reason");
      const submit = within(dialog).getByRole("button", {
        name: "Withdraw",
      }) as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
      expect(submit.title).toBe(message);
      fireEvent.click(submit);
      fireEvent.submit(dialog.querySelector("form")!);
      expect(withdrawal.mutate).not.toHaveBeenCalled();
    },
  );

  it.each(futureValues)(
    "does not offer withdrawal initially for %s",
    (value) => {
      mountWithdrawal(value);
      expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
    },
  );

  it.each(["approved", "changes_requested"])(
    "retains the reviewed reason for %s",
    (value) => {
      const view = mountWithdrawal("unreviewed");
      const dialog = openWithdrawal();
      view.rerender(withdrawElement(value));
      expect(within(dialog).getByRole("status").textContent).toBe(
        "This version has already been reviewed and cannot be withdrawn.",
      );
      expect(
        (
          within(dialog).getByRole("button", {
            name: "Withdraw",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      fireEvent.submit(dialog.querySelector("form")!);
      expect(withdrawal.mutate).not.toHaveBeenCalled();
    },
  );

  it.each(["unreviewed", "withdrawn"])(
    "preserves submission for an open draft with %s",
    (value) => {
      const view = mountWithdrawal("unreviewed");
      const dialog = openWithdrawal();
      view.rerender(withdrawElement(value));
      if (value === "withdrawn") {
        expect(within(dialog).getByRole("status").textContent).toBe(
          "Already withdrawn. Submitting again keeps the original reason.",
        );
      } else {
        expect(within(dialog).queryByRole("status")).toBeNull();
      }
      const submit = within(dialog).getByRole("button", {
        name: "Withdraw",
      }) as HTMLButtonElement;
      expect(submit.disabled).toBe(false);
      fireEvent.click(submit);
      expect(withdrawal.mutate).toHaveBeenCalledWith(
        {
          slug: "demo",
          issueNumber: 1,
          version: 1,
          reason: "Keep this reason",
        },
        { onSuccess: expect.any(Function) },
      );
    },
  );

  it.each([undefined, null, ...malformedValues].map((value) => ({ value })))(
    "throws TypeError for malformed required review status %j",
    ({ value }) => {
      expect(() => mountWithdrawal(value)).toThrow(TypeError);
    },
  );
});

describe("UnreadMarker mute reason compatibility", () => {
  it.each(futureValues)(
    "labels unknown mute %s neutrally in both markers",
    (value) => {
      const view = render(
        <UnreadMarker unread unreadComments={3} muted={value as MuteReason} />,
      );
      const label = `3 new comments since you last viewed — mute reason: ${value}`;
      const badge = screen.getByRole("img");
      // The binary project/card fallback fails the exact title and accessible
      // name: future reasons must never be described as a card mute.
      expect(badge.title).toBe(label);
      expect(badge.getAttribute("aria-label")).toBe(label);
      expect(badge.title).not.toContain("this card is muted");
      expect(badge.className).toContain("bg-muted-foreground");

      view.rerender(
        <UnreadMarker unread unreadComments={0} muted={value as MuteReason} />,
      );
      const ring = view.container.querySelector("span");
      expect(ring?.title).toBe(
        `new activity since you last viewed — mute reason: ${value}`,
      );
      expect(ring?.className).toContain("border-muted-foreground");
    },
  );

  it.each([
    ["project", " — the whole project is muted"],
    ["forever", " — this card is muted"],
    ["until_activity", " — this card is muted"],
  ] as const)("keeps known mute text for %s", (muted, suffix) => {
    const view = render(
      <UnreadMarker unread unreadComments={1} muted={muted} />,
    );
    const label = `1 new comment since you last viewed${suffix}`;
    expect(screen.getByRole("img").title).toBe(label);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe(label);
    view.rerender(<UnreadMarker unread unreadComments={0} muted={muted} />);
    expect(view.container.querySelector("span")?.title).toBe(
      `new activity since you last viewed${suffix}`,
    );
  });

  it.each([{}, { muted: undefined }, { muted: null }])(
    "preserves no-mute behavior for %j",
    (props) => {
      const view = render(
        <UnreadMarker unread unreadComments={101} {...props} />,
      );
      const badge = screen.getByRole("img");
      expect(badge.title).toBe("101 new comments since you last viewed");
      expect(badge.getAttribute("aria-label")).toBe(badge.title);
      expect(badge.textContent).toBe("99+");
      expect(badge.className).toContain("bg-blue-600");
      view.rerender(<UnreadMarker unread unreadComments={0} {...props} />);
      const ring = view.container.querySelector("span");
      expect(ring?.title).toBe("new activity since you last viewed");
      expect(ring?.className).toContain("border-blue-500");
      view.rerender(
        <UnreadMarker unread={false} unreadComments={0} {...props} />,
      );
      expect(view.container.innerHTML).toBe("");
    },
  );

  it.each(malformedValues.map((value) => ({ value })))(
    "throws TypeError for malformed non-null mute %j",
    ({ value }) => {
      expect(() =>
        render(
          <UnreadMarker
            unread={false}
            unreadComments={0}
            muted={value as MuteReason}
          />,
        ),
      ).toThrow(TypeError);
    },
  );
});
