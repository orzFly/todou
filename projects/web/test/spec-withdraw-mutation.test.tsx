import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { SpecWithdrawResult } from "@todou/shared";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { useWithdrawSpec } from "../src/api/spec.ts";
import { testQueryClient } from "./render.tsx";

afterEach(() => vi.restoreAllMocks());

function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const projectionKeys = [
  ["spec", "demo", 7],
  ["spec", "demo", 7, "comments"],
  ["issue", "demo", 7],
  ["issues", "demo", { status: 1 }],
  ["issues", "demo", "board", 1],
  ["timeline", "demo", 7],
  ["inbox"],
];
const untouchedKeys = [
  ["spec-files", "demo", 7, 3],
  ["spec-files", "demo", 7, "current"],
  ["spec", "other", 8],
  ["issue", "other", 8],
  ["issues", "other"],
];

describe("local spec withdrawal mutation", () => {
  it.each(["success", "failure"] as const)(
    "%s refreshes mutable projections without SSE or invalidating immutable files",
    async (outcome) => {
      const client = testQueryClient();
      for (const queryKey of [...projectionKeys, ...untouchedKeys]) {
        client.setQueryData(queryKey, { marker: "cached" });
      }
      const request = held<SpecWithdrawResult>();
      const withdraw = vi
        .spyOn(api, "withdrawSpec")
        .mockReturnValue(request.promise);
      const { result } = renderHook(() => useWithdrawSpec(), {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      });
      act(() =>
        result.current.mutate({
          slug: "demo",
          issueNumber: 7,
          version: 3,
          reason: "rework @user T-9",
        }),
      );
      await waitFor(() =>
        expect(withdraw).toHaveBeenCalledWith("demo", 7, {
          version: 3,
          reason: "rework @user T-9",
        }),
      );
      // Another tab can advance the cache while the original request is pending.
      client.setQueryData(["spec", "demo", 7], { current_version: 4 });
      await act(async () => {
        if (outcome === "success") {
          request.resolve({
            version: 3,
            review_status: "withdrawn",
            unchanged: false,
            cursor: "withdraw-3",
          });
        } else {
          request.reject(
            new Error("Spec v4 is current; refresh before withdrawing"),
          );
        }
      });
      await waitFor(() => expect(result.current.isPending).toBe(false));
      expect(withdraw).toHaveBeenCalledTimes(1);
      for (const queryKey of projectionKeys) {
        expect(
          client.getQueryState(queryKey)?.isInvalidated,
          JSON.stringify(queryKey),
        ).toBe(true);
      }
      for (const queryKey of untouchedKeys) {
        expect(
          client.getQueryState(queryKey)?.isInvalidated,
          JSON.stringify(queryKey),
        ).toBe(false);
      }
      expect(client.getQueryData(["spec", "demo", 7])).toEqual({
        current_version: 4,
      });
      client.clear();
    },
  );

  it("uses the submitted identity for a late result after the caller rerenders", async () => {
    const client = testQueryClient();
    for (const key of [
      ["spec", "demo", 7],
      ["spec", "other", 8],
    ])
      client.setQueryData(key, {});
    const request = held<SpecWithdrawResult>();
    const withdraw = vi
      .spyOn(api, "withdrawSpec")
      .mockReturnValue(request.promise);
    const { result, rerender } = renderHook(
      ({ slug, issueNumber }) => {
        const mutation = useWithdrawSpec();
        return {
          mutation,
          submit: () => mutation.mutate({ slug, issueNumber, version: 3 }),
        };
      },
      {
        initialProps: { slug: "demo", issueNumber: 7 },
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    act(() => result.current.submit());
    await waitFor(() =>
      expect(withdraw).toHaveBeenCalledWith("demo", 7, { version: 3 }),
    );
    rerender({ slug: "other", issueNumber: 8 });
    await act(async () =>
      request.resolve({
        version: 3,
        review_status: "withdrawn",
        unchanged: true,
        cursor: "withdraw-3",
      }),
    );
    await waitFor(() => expect(result.current.mutation.isSuccess).toBe(true));
    expect(client.getQueryState(["spec", "demo", 7])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["spec", "other", 8])?.isInvalidated).toBe(
      false,
    );
    expect(withdraw).toHaveBeenCalledTimes(1);
    client.clear();
  });
});
