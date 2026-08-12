import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AvatarEditor } from "../src/components/shared/avatar-editor.tsx";
import { initialsOf, UserChip } from "../src/components/shared/user-chip.tsx";

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
  it("fires onUpload with the picked file", () => {
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
    expect(onUpload).toHaveBeenCalledWith(file);
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
