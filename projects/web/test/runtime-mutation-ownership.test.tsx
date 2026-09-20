import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { MePrefs } from "@todou/shared";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePatchPrefs } from "../src/api/prefs.ts";
import { api } from "../src/api/queries.ts";
import type { RuntimeBridge } from "../src/api/runtime/bridge.ts";
import type { RuntimeSnapshot } from "../src/api/runtime/protocol.ts";
import * as ownership from "../src/api/runtime/query-adapter.ts";
import { resource } from "../src/api/runtime/resources.ts";
import { userQuery } from "../src/api/users.ts";

function workerBridge() {
  const listeners = new Map<string, (snapshot: RuntimeSnapshot) => void>();
  const control = vi.fn(
    async (
      _type: Parameters<RuntimeBridge["control"]>[0],
      _payload: Record<string, unknown>,
    ) => ({}),
  );
  const bridge = {
    mode: "worker",
    ready: Promise.resolve(),
    control,
    subscribe: vi.fn(
      (
        projection: Parameters<RuntimeBridge["subscribe"]>[0],
        _options: Parameters<RuntimeBridge["subscribe"]>[1],
        listener: Parameters<RuntimeBridge["subscribe"]>[2],
      ) => {
        listeners.set(projection.queryHash, listener);
        return () => {
          listeners.delete(projection.queryHash);
        };
      },
    ),
    onMode: () => () => {},
    onSessionReset: () => () => {},
    onFrame: () => () => {},
    readProjection: vi.fn(async () => ({})),
    read: vi.fn(async () => ({})),
    bootstrap: vi.fn(),
    authTransition: vi.fn(),
    authRedirect: vi.fn(),
    dispose: vi.fn(),
  } as unknown as RuntimeBridge;
  return { bridge, listeners, control };
}

afterEach(() => vi.restoreAllMocks());

describe("explicit local write ownership", () => {
  it("holds worker snapshots through rollback and resumes only after the owner settles", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { bridge, listeners, control } = workerBridge();
    const adapter = ownership.installRuntimeQueryAdapter(client, bridge);
    const key = ["me-prefs"];
    const options = ownership.runtimeQueryOptions(
      {
        queryKey: key,
        queryFn: async () => ({ value: "server" }),
        enabled: false,
        initialData: { value: "before" },
      },
      {
        kind: "direct",
        resources: [resource("prefs", "/me/prefs")],
      },
    );
    const observer = new QueryObserver(client, options);
    const stop = observer.subscribe(() => {});
    try {
      await waitFor(() => expect(listeners.size).toBe(1));
      const snapshot: RuntimeSnapshot = {
        projectionHash: "prefs",
        status: "success",
        fetchStatus: "idle",
        data: { value: "server" },
        fetchedAt: Date.now(),
        stale: false,
        revision: 1,
        generation: 1,
      };
      const token = ownership.beginRuntimeWrite(client, { queryKey: key });
      await client.cancelQueries({ queryKey: key });
      ownership.writeRuntimeData(client, key, { value: "optimistic" }, token);
      for (const listener of listeners.values()) listener(snapshot);
      expect(client.getQueryData(key)).toEqual({ value: "optimistic" });
      ownership.writeRuntimeData(client, key, { value: "before" }, token);
      expect(client.getQueryData(key)).toEqual({ value: "before" });
      await ownership.settleRuntimeWrite(client, token);
      await waitFor(() =>
        expect(client.getQueryData(key)).toEqual({ value: "server" }),
      );
      expect(control.mock.calls.some(([type]) => type === "RESUME")).toBe(true);
    } finally {
      stop();
      adapter.dispose();
      client.clear();
    }
  });

  it("a failed preference write rolls back and releases the same owner", async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const before = MePrefs.parse({ show_weak_unread: true });
    client.setQueryData(["me-prefs"], before);
    const begin = vi.spyOn(ownership, "beginRuntimeWrite");
    const write = vi.spyOn(ownership, "writeRuntimeData");
    const settle = vi.spyOn(ownership, "settleRuntimeWrite");
    vi.spyOn(api, "patchMyPrefs").mockRejectedValue(new Error("failed"));
    const hook = renderHook(() => usePatchPrefs(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    try {
      await act(async () => {
        await hook.result.current
          .mutateAsync({ show_weak_unread: false })
          .catch(() => {});
      });
      const token = begin.mock.results[0]?.value;
      expect(token).toEqual(expect.any(String));
      expect(write).toHaveBeenCalledWith(
        client,
        ["me-prefs"],
        expect.objectContaining({ show_weak_unread: false }),
        token,
      );
      expect(write).toHaveBeenCalledWith(client, ["me-prefs"], before, token);
      expect(settle).toHaveBeenCalledWith(client, token);
      expect(client.getQueryData(["me-prefs"])).toEqual(before);
    } finally {
      hook.unmount();
      client.clear();
    }
  });

  it("failed optimistic setup releases its owner without calling the write endpoint", async () => {
    const client = new QueryClient();
    const begin = vi.spyOn(ownership, "beginRuntimeWrite");
    const settle = vi.spyOn(ownership, "settleRuntimeWrite");
    vi.spyOn(client, "cancelQueries").mockRejectedValue(
      new Error("cancel failed"),
    );
    const patch = vi
      .spyOn(api, "patchMyPrefs")
      .mockResolvedValue(MePrefs.parse({}));
    const hook = renderHook(() => usePatchPrefs(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    try {
      await act(async () => {
        await hook.result.current
          .mutateAsync({ show_weak_unread: false })
          .catch(() => {});
      });
      expect(settle).toHaveBeenCalledWith(client, begin.mock.results[0]?.value);
      expect(patch).not.toHaveBeenCalled();
    } finally {
      hook.unmount();
      client.clear();
    }
  });

  it("user aliases stay page-owned and never issue a worker seed or write control", async () => {
    const client = new QueryClient();
    const { bridge, control } = workerBridge();
    const adapter = ownership.installRuntimeQueryAdapter(client, bridge);
    const user = {
      id: 7,
      login: "alice",
      display_name: "Alice",
      kind: "human" as const,
      avatar_url: null,
      owner: null,
      created_at: "2026-01-01T00:00:00Z",
    };
    vi.spyOn(api, "getUser").mockResolvedValue(user);
    try {
      await client.fetchQuery(userQuery("7"));
      expect(client.getQueryData(["user", "alice"])).toEqual(user);
      expect(control).not.toHaveBeenCalled();
    } finally {
      adapter.dispose();
      client.clear();
    }
  });
});
