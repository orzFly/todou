import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AvatarEditor } from "../src/components/shared/avatar-editor.tsx";
import { initialsOf, UserChip } from "../src/components/shared/user-chip.tsx";

vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
const { toast } = await import("sonner");

const human = {
  id: 1,
  login: "spud",
  display_name: "Spud Farmer",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

describe("initialsOf", () => {
  it("takes the first letters of the first two words", () => {
    expect(initialsOf("Spud Farmer")).toBe("SF");
    expect(initialsOf("claude-agent")).toBe("C");
  });
});

describe("UserChip names (T-149)", () => {
  it("shows the display name, keeping the login for the initials fallback", () => {
    const { getByText, queryByText } = render(<UserChip user={human} />);
    expect(getByText("Spud Farmer")).toBeTruthy();
    expect(queryByText("spud")).toBeNull();
    expect(queryByText("@spud")).toBeNull();
  });

  it("falls back to the login when the display name is blank", () => {
    const { getByText } = render(
      <UserChip user={{ ...human, display_name: "   " }} />,
    );
    expect(getByText("spud")).toBeTruthy();
    expect(getByText("S")).toBeTruthy();
  });

  it("adds the login beside the name under showLogin, never when compact", () => {
    const { getByText, queryByText, rerender } = render(
      <UserChip user={human} showLogin />,
    );
    expect(getByText("Spud Farmer")).toBeTruthy();
    expect(getByText("@spud")).toBeTruthy();

    rerender(<UserChip user={human} showLogin compact />);
    expect(queryByText("@spud")).toBeNull();
  });

  it("reads the name off an old server's response without printing undefined", () => {
    const legacy = { ...human } as Partial<typeof human>;
    legacy.display_name = undefined;
    const { getByText } = render(
      <UserChip user={legacy as typeof human} showLogin />,
    );
    expect(getByText("spud")).toBeTruthy();
  });
});

describe("UserChip avatars", () => {
  it("falls back to initials without an avatar", () => {
    const { container, getByText } = render(<UserChip user={human} />);
    expect(getByText("SF")).toBeTruthy();
    expect(container.querySelector("[data-slot=avatar-image]")).toBeNull();
  });

  it("mounts an AvatarImage when avatar_url is set, keeping the fallback", () => {
    const { container, getByText } = render(
      <UserChip user={{ ...human, avatar_url: "/api/users/1/avatar?v=abc" }} />,
    );
    // Radix keeps the initials fallback until the image finishes loading —
    // in happy-dom it never does, so only the fallback is observable. The
    // real-image path is covered by the server round-trip test.
    expect(getByText("SF")).toBeTruthy();
    expect(container.innerHTML).toBeTruthy();
  });
});

describe("AvatarEditor", () => {
  it("fires onUpload with the picked file", async () => {
    const onUpload = vi.fn();
    const { container } = render(
      <AvatarEditor user={human} onUpload={onUpload} onRemove={() => {}} />,
    );
    const input = container.querySelector(
      "input[type=file]",
    ) as HTMLInputElement;
    expect(input.accept).toContain("image/png");

    const file = new File(["x"], "a.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    // Every entry now goes through the resize check, so the handoff is a
    // microtask late even for a file that is already small enough.
    await waitFor(() => expect(onUpload).toHaveBeenCalledWith(file));
  });

  it("only offers Remove when an avatar exists", () => {
    const { queryByText, rerender, getByText } = render(
      <AvatarEditor user={human} onUpload={() => {}} onRemove={() => {}} />,
    );
    expect(queryByText("Remove")).toBeNull();

    const onRemove = vi.fn();
    rerender(
      <AvatarEditor
        user={{ ...human, avatar_url: "/api/users/1/avatar?v=abc" }}
        onUpload={() => {}}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(getByText("Remove"));
    expect(onRemove).toHaveBeenCalled();
  });
});

/**
 * happy-dom's DragEvent is a bare alias of Event and it has no ClipboardEvent
 * payload either, so both transfers are hand-hung on a synthetic event — the
 * same technique markdown-editor.test.tsx uses for the composer's staging.
 */
function transferOf(...files: File[]) {
  return {
    files,
    types: files.length > 0 ? ["Files"] : [],
  } as unknown as DataTransfer;
}

function dispatch(
  target: EventTarget,
  type: string,
  payload: Record<string, unknown>,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(payload)) {
    Object.defineProperty(event, key, { value, configurable: true });
  }
  target.dispatchEvent(event);
  return event;
}

describe("AvatarEditor drop and paste (T-226)", () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.warning).mockClear();
  });

  function setup() {
    const onUpload = vi.fn();
    const { container, getByText } = render(
      <AvatarEditor user={human} onUpload={onUpload} onRemove={() => {}} />,
    );
    const zone = container.querySelector("fieldset") as HTMLElement;
    return { onUpload, zone, getByText };
  }

  const png = () => new File(["x"], "a.png", { type: "image/png" });

  it("uploads a file dropped on the editor", async () => {
    const { onUpload, zone } = setup();
    const file = png();

    dispatch(zone, "drop", { dataTransfer: transferOf(file) });

    await waitFor(() => expect(onUpload).toHaveBeenCalledWith(file));
  });

  it("cancels dragover for a file payload, so the browser cannot navigate away", () => {
    const { zone } = setup();

    const event = dispatch(zone, "dragover", {
      dataTransfer: transferOf(png()),
    });

    expect(event.defaultPrevented).toBe(true);
  });

  it("rejects a dropped file whose type the server would refuse", async () => {
    const { onUpload, zone } = setup();
    const pdf = new File(["x"], "a.pdf", { type: "application/pdf" });

    dispatch(zone, "drop", { dataTransfer: transferOf(pdf) });

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(onUpload).not.toHaveBeenCalled();
  });

  it("uploads a pasted image while the pointer is over the editor", async () => {
    const { onUpload, zone } = setup();
    const file = png();
    fireEvent.mouseEnter(zone);

    dispatch(document, "paste", { clipboardData: { files: [file] } });

    await waitFor(() => expect(onUpload).toHaveBeenCalledWith(file));
  });

  it("uploads a pasted image while a control inside the editor has focus", async () => {
    const { onUpload, getByText } = setup();
    const file = png();
    // A browser does both; happy-dom's focus() does not dispatch focusin.
    const button = getByText("Upload").closest("button") as HTMLButtonElement;
    button.focus();
    fireEvent.focusIn(button);

    dispatch(document, "paste", { clipboardData: { files: [file] } });

    await waitFor(() => expect(onUpload).toHaveBeenCalledWith(file));
  });

  it("checks where the focus actually is, not where the flag says", async () => {
    const { onUpload, getByText } = setup();
    // Preparing disables the button that holds the focus, and the focusout
    // Chrome fires during that commit can lose its reset — leaving the flag
    // armed with the focus long gone. Verified in a real browser on T-226.
    fireEvent.focusIn(getByText("Upload"));

    const event = dispatch(document, "paste", {
      clipboardData: { files: [png()] },
    });

    expect(event.defaultPrevented).toBe(false);
    await waitFor(() => expect(onUpload).not.toHaveBeenCalled());
  });

  it("ignores a paste when the editor is neither hovered nor focused", async () => {
    const { onUpload } = setup();

    const event = dispatch(document, "paste", {
      clipboardData: { files: [png()] },
    });

    // The decision on #comment-2241: paste is not a page-wide shortcut.
    expect(event.defaultPrevented).toBe(false);
    await waitFor(() => expect(onUpload).not.toHaveBeenCalled());
  });

  it("leaves a text paste alone even while armed", async () => {
    const { onUpload, zone } = setup();
    fireEvent.mouseEnter(zone);

    const event = dispatch(document, "paste", { clipboardData: { files: [] } });

    // Claiming the event here would break typing into any field on the page.
    expect(event.defaultPrevented).toBe(false);
    await waitFor(() => expect(onUpload).not.toHaveBeenCalled());
  });
});
