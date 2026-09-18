import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  classifyReadFailure,
  type ReadFailureKind,
} from "../src/lib/http-status.ts";
import { useReadFailure } from "../src/lib/use-read-failure.ts";

function errorWithStatus(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

describe("classifyReadFailure", () => {
  it.each<{
    label: string;
    error: unknown;
    expected: ReadFailureKind;
  }>([
    {
      label: "treats a network error without status as transient",
      error: new Error("offline"),
      expected: "transient",
    },
    {
      label: "treats 400 as refused",
      error: errorWithStatus("bad request", 400),
      expected: "refused",
    },
    {
      label: "treats 401 as session loss",
      error: errorWithStatus("signed out", 401),
      expected: "session",
    },
    {
      label: "treats 403 as refused",
      error: errorWithStatus("forbidden", 403),
      expected: "refused",
    },
    {
      label: "treats 404 as refused",
      error: errorWithStatus("missing", 404),
      expected: "refused",
    },
    {
      label: "treats 499 as refused",
      error: errorWithStatus("client failure", 499),
      expected: "refused",
    },
    {
      label: "treats 500 as transient",
      error: errorWithStatus("server failure", 500),
      expected: "transient",
    },
    {
      label: "treats 503 as transient",
      error: errorWithStatus("unavailable", 503),
      expected: "transient",
    },
    {
      label: "treats null as transient",
      error: null,
      expected: "transient",
    },
    {
      label: "treats a non-Error value as transient",
      error: "offline",
      expected: "transient",
    },
  ])("$label", ({ error, expected }) => {
    expect(classifyReadFailure(error)).toBe(expected);
  });
});

describe("useReadFailure", () => {
  const transient = errorWithStatus("server failure", 503);
  const refused = errorWithStatus("forbidden", 403);
  const session = errorWithStatus("signed out", 401);

  it.each([
    {
      label: "replaces an empty surface after a transient failure",
      error: transient,
      hasContent: false,
      expected: { replace: "server failure", notice: null },
    },
    {
      label: "notices a transient failure beside retained content",
      error: transient,
      hasContent: true,
      expected: { replace: null, notice: "server failure" },
    },
    {
      label: "replaces an empty surface after a refused read",
      error: refused,
      hasContent: false,
      expected: { replace: "forbidden", notice: null },
    },
    {
      label: "replaces retained content after a refused read",
      error: refused,
      hasContent: true,
      expected: { replace: "forbidden", notice: null },
    },
    {
      label: "keeps an empty surface silent after session loss",
      error: session,
      hasContent: false,
      expected: { replace: null, notice: null },
    },
    {
      label: "keeps retained content silent after session loss",
      error: session,
      hasContent: true,
      expected: { replace: null, notice: null },
    },
  ])("$label", ({ error, hasContent, expected }) => {
    const { result } = renderHook(() => useReadFailure(error, hasContent));

    expect(result.current).toEqual(expected);
    expect(
      result.current.replace === null || result.current.notice === null,
    ).toBe(true);
  });

  it("normalizes blank failures to nonempty render guards", () => {
    const blankError = renderHook(() => useReadFailure(new Error(""), false));
    const blankValue = renderHook(() => useReadFailure("", false));

    expect(blankError.result.current).toEqual({
      replace: "Error",
      notice: null,
    });
    expect(blankValue.result.current).toEqual({
      replace: "Unknown error",
      notice: null,
    });
  });

  it("keeps a cold failure latched while its retry clears the live error", () => {
    const hook = renderHook(
      ({ error, hasContent }: { error: Error | null; hasContent: boolean }) =>
        useReadFailure(error, hasContent),
      { initialProps: { error: transient as Error | null, hasContent: false } },
    );

    hook.rerender({ error: null, hasContent: false });

    expect(hook.result.current).toEqual({
      replace: "server failure",
      notice: null,
    });
  });

  it("clears the cold failure latch when content arrives", () => {
    const hook = renderHook(
      ({ error, hasContent }: { error: Error | null; hasContent: boolean }) =>
        useReadFailure(error, hasContent),
      { initialProps: { error: transient as Error | null, hasContent: false } },
    );
    hook.rerender({ error: null, hasContent: false });

    hook.rerender({ error: null, hasContent: true });

    expect(hook.result.current).toEqual({ replace: null, notice: null });
  });

  it("keeps session loss silent after a cold failure was latched", () => {
    const hook = renderHook(
      ({ error, hasContent }: { error: Error | null; hasContent: boolean }) =>
        useReadFailure(error, hasContent),
      { initialProps: { error: transient as Error | null, hasContent: false } },
    );

    hook.rerender({ error: session, hasContent: false });

    expect(hook.result.current).toEqual({ replace: null, notice: null });
    hook.rerender({ error: null, hasContent: false });
    expect(hook.result.current).toEqual({ replace: null, notice: null });
  });
});
