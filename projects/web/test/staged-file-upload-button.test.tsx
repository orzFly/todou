import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StagedFileUploadButton } from "../src/components/issue/staged-files.tsx";

function pickedFile(name: string) {
  return new File(["content"], name, { type: "image/png" });
}

describe("StagedFileUploadButton", () => {
  it("forwards picked files and allows re-picking the same file", () => {
    const onFiles = vi.fn();
    const { container } = render(<StagedFileUploadButton onFiles={onFiles} />);
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    expect(input?.multiple).toBe(true);

    fireEvent.change(input as HTMLInputElement, {
      target: { files: [pickedFile("shot.png")] },
    });
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect([...onFiles.mock.calls[0][0]].map((f: File) => f.name)).toEqual([
      "shot.png",
    ]);
    // value reset after the pick: choosing the same file again must
    // fire change again instead of being swallowed as "unchanged".
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("is icon-only without a label and shows the label when given", () => {
    const iconOnly = render(<StagedFileUploadButton onFiles={() => {}} />);
    expect(
      within(iconOnly.container).getByRole("button", { name: "Attach files" })
        .textContent,
    ).toBe("");

    const labeled = render(
      <StagedFileUploadButton onFiles={() => {}} label="Attach files" />,
    );
    expect(
      within(labeled.container).getByRole("button", { name: "Attach files" })
        .textContent,
    ).toBe("Attach files");
  });

  it("disables the button while an upload is in flight", () => {
    const { container } = render(
      <StagedFileUploadButton onFiles={() => {}} disabled />,
    );
    expect(
      within(container)
        .getByRole("button", { name: "Attach files" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});
