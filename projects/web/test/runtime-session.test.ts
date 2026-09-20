import type { Me } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuthControl,
  AuthFenceError,
  authControlName,
} from "../src/api/runtime/auth-control.ts";
import { deferred } from "../src/api/runtime/deferred.ts";
import { ResourceRuntime } from "../src/api/runtime/runtime.ts";
import {
  RuntimeSessionHost,
  SessionIdentity,
} from "../src/api/runtime/session.ts";
import {
  authEnvironment,
  hello,
  identity,
  issueProjection,
  issueResource,
  MemoryStorage,
  settle,
} from "./runtime-harness.ts";

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.useRealTimers();
});

function session(onlineIdentity = vi.fn(async () => identity())) {
  const network = vi.fn(async () => ({ title: "server" }));
  const runtime = new ResourceRuntime({ network });
  const host = new RuntimeSessionHost({
    runtime,
    onlineIdentity,
    apiMount: "/api",
    pageOrigin: "https://todou.example",
    buildId: "test",
  });
  disposals.push(() => host.dispose());
  return { runtime, host, network, onlineIdentity };
}

describe("online session authority", () => {
  it("ignores an old END after a newer transition has already settled", async () => {
    const { host } = session();
    const page = await hello(host);
    page.send("AUTH_BOOTSTRAP");
    await settle();
    for (const transitionId of ["old", "current"]) {
      page.send("AUTH_TRANSITION", {
        transitionId,
        phase: "begin",
        expectedEpoch: host.identity.epoch,
      });
      await settle();
      page.send("AUTH_TRANSITION", {
        transitionId,
        phase: "end",
        expectedEpoch: host.identity.epoch,
      });
      await settle();
    }
    const epoch = host.identity.epoch;
    const resets = page.page.received.filter(
      (message) => message.type === "SESSION_RESET",
    ).length;
    const requestId = page.send("AUTH_TRANSITION", {
      transitionId: "old",
      phase: "failed",
      expectedEpoch: epoch,
    });
    await settle();
    expect(host.identity.epoch).toBe(epoch);
    expect(host.identity.marker).toEqual({
      transitionId: "current",
      phase: "end",
    });
    expect(
      page.page.received.filter((message) => message.type === "SESSION_RESET"),
    ).toHaveLength(resets);
    expect(
      page.page.received.find((message) => message.requestId === requestId)
        ?.type,
    ).toBe("ACK");
  });

  it("merges only overlapping identity reads and makes every new port go online", async () => {
    const response = deferred<Me>();
    const online = vi.fn(() => response.promise);
    const { host } = session(online);
    const a = await hello(host);
    const b = await hello(host, "page-b");
    a.send("AUTH_BOOTSTRAP");
    b.send("AUTH_BOOTSTRAP");
    await settle();
    expect(online).toHaveBeenCalledTimes(1);
    response.resolve(identity());
    await settle();
    expect(a.page.received.some((m) => m.type === "IDENTITY")).toBe(true);
    expect(b.page.received.some((m) => m.type === "IDENTITY")).toBe(true);
    const c = await hello(host, "page-c");
    c.send("AUTH_BOOTSTRAP");
    await settle();
    expect(online).toHaveBeenCalledTimes(2);
  });

  it("rejects another real port's ID, stale epochs and malformed descriptors without taking down peers", async () => {
    const { host, network } = session();
    const a = await hello(host);
    const b = await hello(host, "page-b");
    a.send("AUTH_BOOTSTRAP");
    b.send("AUTH_BOOTSTRAP");
    await settle();
    a.send("READ_FRESH", { resource: issueResource, portId: b.ready.portId });
    b.send("READ_FRESH", {
      resource: { ...issueResource, path: "https://example.com/private" },
    });
    await settle();
    expect(network).not.toHaveBeenCalled();
    expect(a.page.received.at(-1)?.type).toBe("ERROR");
    expect(b.page.received.at(-1)?.type).toBe("ERROR");
    const request = b.send("READ_FRESH", { resource: issueResource });
    await settle();
    expect(b.page.received.find((m) => m.requestId === request)?.type).toBe(
      "RESULT",
    );
    host.identity.revoke("clear");
    b.send("READ_FRESH", { resource: issueResource, accountEpoch: 0 });
    await settle();
    expect(b.page.received.at(-1)?.type).toBe("ERROR");
  });

  it("never authorizes an old bootstrap across BEGIN and END, even for the same account", async () => {
    const old = deferred<Me>();
    const fresh = deferred<Me>();
    const online = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(fresh.promise);
    const reset = vi.fn();
    const gate = new SessionIdentity({ online, onReset: reset });
    disposals.push(() => gate.dispose());
    const first = gate.bootstrap(null);
    const rejected = expect(first).rejects.toMatchObject({
      kind: "session-reset",
    });
    await settle();
    gate.observeMarker({ transitionId: "login-a", phase: "begin" });
    gate.observeMarker({ transitionId: "login-a", phase: "end" });
    old.resolve(identity());
    await rejected;
    expect(gate.accountId).toBeNull();
    const second = gate.bootstrap({ transitionId: "login-a", phase: "end" });
    fresh.resolve(identity());
    await second;
    expect(gate.accountId).toBe("1");
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it("keeps new BEGIN fenced when old END or old BEGIN arrives", async () => {
    const gate = new SessionIdentity({
      online: async () => identity(),
      onReset: () => {},
    });
    gate.observeMarker({ transitionId: "a", phase: "begin" });
    gate.observeMarker({ transitionId: "a", phase: "end" });
    gate.observeMarker({ transitionId: "b", phase: "begin" });
    gate.observeMarker({ transitionId: "a", phase: "end" });
    gate.observeMarker({ transitionId: "a", phase: "begin" });
    expect(gate.marker).toEqual({ transitionId: "b", phase: "begin" });
    await expect(
      gate.bootstrap({ transitionId: "b", phase: "begin" }),
    ).rejects.toMatchObject({ kind: "session-reset" });
  });

  it("advances epoch A to B, cancels old private delivery and leaves failed new gates closed", async () => {
    const online = vi.fn(async () => identity());
    const { host } = session(online);
    const a = await hello(host);
    a.send("AUTH_BOOTSTRAP");
    await settle();
    const epoch = host.identity.epoch;
    online.mockResolvedValueOnce(identity(2));
    const b = await hello(host, "page-b");
    b.send("AUTH_BOOTSTRAP");
    await settle();
    expect(host.identity.epoch).toBeGreaterThan(epoch);
    expect(host.identity.accountId).toBe("2");
    expect(
      a.page.received.some(
        (m) => m.type === "SESSION_RESET" && m.reason === "identity-changed",
      ),
    ).toBe(true);
    online.mockRejectedValueOnce(new Error("network offline"));
    const c = await hello(host, "page-c");
    c.send("AUTH_BOOTSTRAP");
    await settle();
    c.send("SUBSCRIBE", {
      subscriptionId: "not-authorized",
      projection: issueProjection,
      enabled: true,
      visible: true,
    });
    await settle();
    expect(c.page.received.at(-1)?.type).toBe("ERROR");
  });

  it("sends control ACK before RESULT and does not let a dirty ACK complete a read", async () => {
    const { host, runtime } = session();
    const a = await hello(host);
    a.send("AUTH_BOOTSTRAP");
    await settle();
    const held = deferred<void>();
    vi.spyOn(runtime, "invalidate").mockImplementation((_targets, options) => {
      options?.onApplied?.({ target: 3 });
      return held.promise;
    });
    const request = a.send("INVALIDATE", {
      operationId: "write-1",
      targets: [{ type: "user" }],
      completion: "reads-settled",
    });
    await settle();
    expect(
      a.page.received.filter((m) => m.requestId === request).map((m) => m.type),
    ).toEqual(["ACK"]);
    held.resolve();
    await settle();
    expect(
      a.page.received.filter((m) => m.requestId === request).map((m) => m.type),
    ).toEqual(["ACK", "RESULT"]);
  });
});

describe("auth-control localStorage and locks", () => {
  it("serializes a slow logout before login and online-confirms failed actions", async () => {
    const env = authEnvironment();
    const a = env.control();
    const b = env.control();
    disposals.push(
      () => a.dispose(),
      () => b.dispose(),
    );
    const logout = deferred<void>();
    const order: string[] = [];
    const hooks = {
      fence: async () => {
        order.push("fence");
      },
      confirm: async () => {
        order.push("confirm");
      },
      recover: async () => {},
    };
    const first = a.transition(async () => {
      order.push("logout");
      await logout.promise;
    }, hooks);
    await settle();
    const second = b.transition(async () => {
      order.push("login");
    }, hooks);
    await settle();
    expect(order).toEqual(["fence", "logout"]);
    logout.resolve();
    await first;
    await second;
    expect(order).toEqual([
      "fence",
      "logout",
      "fence",
      "confirm",
      "fence",
      "login",
      "fence",
      "confirm",
    ]);
    const error = new Error("login failed");
    await expect(
      a.transition(async () => {
        throw error;
      }, hooks),
    ).rejects.toBe(error);
    expect(a.read()?.phase).toBe("failed");
    expect(order.at(-1)).toBe("confirm");
  });

  it("checks the durable marker without relying on BroadcastChannel delivery", () => {
    const env = authEnvironment();
    const control = env.control();
    disposals.push(() => control.dispose());
    const token = control.capture();
    env.storage.setItem(
      control.name,
      JSON.stringify({ transitionId: "remote", phase: "begin" }),
    );
    expect(() => control.assert(token)).toThrow(AuthFenceError);
    expect(control.finish("obsolete", "end")).toBe(false);
    expect(control.read()?.transitionId).toBe("remote");
  });

  it("recovers a crashed lock owner only after online confirmation", async () => {
    const env = authEnvironment();
    const control = env.control();
    disposals.push(() => control.dispose());
    env.storage.setItem(
      control.name,
      JSON.stringify({ transitionId: "crashed", phase: "begin" }),
    );
    const verify = deferred<void>();
    const recovery = control.recover({
      verify: () => verify.promise,
      fence: async () => {},
    });
    await settle();
    expect(control.read()?.phase).toBe("begin");
    verify.resolve();
    await recovery;
    expect(control.read()).toEqual({
      transitionId: "crashed",
      phase: "failed",
    });
  });

  it("fallback auth still fences healthy worker-capable peers", async () => {
    const env = authEnvironment();
    const modern = env.control();
    const fallback = env.control(false);
    disposals.push(
      () => modern.dispose(),
      () => fallback.dispose(),
    );
    expect(fallback.supported).toBe(false);
    const old = modern.capture();
    const http = deferred<void>();
    const action = fallback.transition(() => http.promise, {
      fence: async () => {},
      confirm: async () => {},
      recover: async () => {},
    });
    await settle();
    expect(() => modern.assert(old)).toThrow(AuthFenceError);
    http.resolve();
    await action;
    expect(modern.read()?.phase).toBe("end");
    expect(() => modern.assert(old)).toThrow(AuthFenceError);
  });

  it("disables shared caching when marker storage or locks are absent", () => {
    const unavailable = new AuthControl({ apiMount: "/api", storage: null });
    const noLocks = new AuthControl({
      apiMount: "/api",
      storage: new MemoryStorage(),
    });
    disposals.push(
      () => unavailable.dispose(),
      () => noLocks.dispose(),
    );
    expect(unavailable.supported).toBe(false);
    expect(noLocks.supported).toBe(false);
    expect(authControlName("/api/")).toBe(authControlName("/api"));
  });
});
