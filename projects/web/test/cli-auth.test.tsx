import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  CliAuthCard,
  callbackUrl,
  parseCliAuthSearch,
} from "../src/pages/cli-auth.tsx";
import { safeRedirect } from "../src/pages/login.tsx";

function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

describe("parseCliAuthSearch", () => {
  it("accepts a valid request and defaults the name", () => {
    expect(parseCliAuthSearch({ port: 4321, state: "abc" })).toEqual({
      port: 4321,
      state: "abc",
      name: "todou CLI",
    });
    expect(
      parseCliAuthSearch({ port: "4321", state: "abc", name: "cli @ bot-one" }),
    ).toEqual({ port: 4321, state: "abc", name: "cli @ bot-one" });
  });

  it("rejects bad ports and missing state", () => {
    expect(parseCliAuthSearch({ port: 0, state: "abc" })).toBeNull();
    expect(parseCliAuthSearch({ port: 70000, state: "abc" })).toBeNull();
    expect(parseCliAuthSearch({ port: "x", state: "abc" })).toBeNull();
    expect(parseCliAuthSearch({ port: 4321 })).toBeNull();
  });
});

describe("callbackUrl", () => {
  it("targets loopback with encoded token and state", () => {
    expect(
      callbackUrl({ port: 4321, state: "a b", name: "n" }, "todou_pat_x/y"),
    ).toBe("http://127.0.0.1:4321/callback?token=todou_pat_x%2Fy&state=a+b");
  });
});

describe("CliAuthCard", () => {
  const request = { port: 4321, state: "s3cret", name: "cli @ test" };

  it("mints only after an explicit click, then delivers", async () => {
    const mint = vi.fn().mockResolvedValue({ token: "todou_pat_minted" });
    const deliver = vi.fn();
    const { getByRole } = renderWithQuery(
      <CliAuthCard
        request={request}
        onCancel={() => {}}
        mint={mint}
        deliver={deliver}
      />,
    );
    expect(mint).not.toHaveBeenCalled();

    fireEvent.click(getByRole("button", { name: "Authorize" }));
    await waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(mint).toHaveBeenCalledWith("cli @ test");
    expect(deliver).toHaveBeenCalledWith(
      "http://127.0.0.1:4321/callback?token=todou_pat_minted&state=s3cret",
    );
  });

  it("shows mint failures and cancels via the callback", async () => {
    const mint = vi.fn().mockRejectedValue(new Error("nope"));
    const onCancel = vi.fn();
    const { getByRole, getByText } = renderWithQuery(
      <CliAuthCard
        request={request}
        onCancel={onCancel}
        mint={mint}
        deliver={() => {}}
      />,
    );
    fireEvent.click(getByRole("button", { name: "Authorize" }));
    await waitFor(() =>
      expect(getByText(/Could not issue the token/)).toBeTruthy(),
    );
    fireEvent.click(getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe("safeRedirect", () => {
  it("allows only same-site paths", () => {
    expect(safeRedirect("/cli-auth?port=1&state=x")).toBe(
      "/cli-auth?port=1&state=x",
    );
    expect(safeRedirect("//evil.example")).toBeUndefined();
    expect(safeRedirect("https://evil.example")).toBeUndefined();
    expect(safeRedirect(42)).toBeUndefined();
  });
});
