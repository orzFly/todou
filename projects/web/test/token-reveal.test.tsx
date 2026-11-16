import { fireEvent, render, waitFor } from "@testing-library/react";
import type { TokenCreated } from "@todou/shared";
import { describe, expect, it, vi } from "vitest";
import { TokenReveal } from "../src/components/shared/token-reveal.tsx";

const token = {
  id: 1,
  token: "todou_pat_super-secret-value",
  prefix: "todou_pat_super",
  name: "ci",
  expires_at: null,
  act_as: "off",
} satisfies TokenCreated;

describe("TokenReveal (one-time plaintext display)", () => {
  it("shows the plaintext exactly once with the prefix warning", () => {
    const { getByTestId, getByText } = render(<TokenReveal token={token} />);
    expect(getByTestId("token-plaintext").textContent).toBe(
      "todou_pat_super-secret-value",
    );
    expect(getByText(/only the prefix/)).toBeTruthy();
  });

  it("copies the plaintext to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const { getByRole, getByText } = render(<TokenReveal token={token} />);
    fireEvent.click(getByRole("button"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("todou_pat_super-secret-value"),
    );
    expect(getByText("Copied")).toBeTruthy();

    vi.unstubAllGlobals();
  });

  it("names the act-as header only for a token that can act as agents", () => {
    const plain = render(<TokenReveal token={token} />);
    expect(plain.queryByText(/x-todou-act-as/)).toBeNull();
    plain.unmount();
    const acting = render(
      <TokenReveal token={{ ...token, act_as: "existing" }} />,
    );
    expect(acting.getByText("x-todou-act-as: <agent login>")).toBeTruthy();
  });
});
