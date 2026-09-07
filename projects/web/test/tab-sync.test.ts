import { afterEach, describe, expect, it, vi } from "vitest";
import {
  electLeader,
  openTabChannel,
  tabSyncSupported,
} from "../src/api/tab-sync.ts";
import { installTabSync } from "./tab-sync.ts";

const LOCK = "todou:events:1";
const CHANNEL = "todou:events:1:ch";

/** Lets the two chained lock requests inside `electLeader` settle. */
const settle = () => Promise.resolve().then(() => Promise.resolve());

describe("tabSyncSupported", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses happy-dom's null LockManager", () => {
    // `"locks" in navigator` and `typeof navigator.locks !== "undefined"`
    // both say yes here, which is why the check is a truthiness one.
    expect(navigator.locks).toBeNull();
    expect("locks" in navigator).toBe(true);
    expect(tabSyncSupported()).toBe(false);
  });

  it("refuses a browser without BroadcastChannel", () => {
    const installed = installTabSync();
    expect(tabSyncSupported()).toBe(true);
    vi.stubGlobal("BroadcastChannel", undefined);
    expect(tabSyncSupported()).toBe(false);
    installed.restore();
  });
});

describe("electLeader", () => {
  let restore = () => {};
  afterEach(() => {
    restore();
    restore = () => {};
  });

  function tabs() {
    const installed = installTabSync();
    restore = installed.restore;
    return installed;
  }

  it("leads at once when nobody holds the lock, without a promotion", async () => {
    tabs();
    const seen: { promoted: boolean }[] = [];
    electLeader(LOCK, (info) => {
      seen.push(info);
      return () => {};
    });
    await settle();
    expect(seen).toEqual([{ promoted: false }]);
  });

  it("makes the second tab wait, then promotes it on handover", async () => {
    tabs();
    const first: { promoted: boolean }[] = [];
    const second: { promoted: boolean }[] = [];
    const giveUpFirst = electLeader(LOCK, (info) => {
      first.push(info);
      return () => {};
    });
    await settle();
    electLeader(LOCK, (info) => {
      second.push(info);
      return () => {};
    });
    await settle();
    expect(second).toEqual([]);

    giveUpFirst();
    await settle();
    // The promotion bit is what makes the new leader compensate for the
    // events that arrived while nobody was connected.
    expect(second).toEqual([{ promoted: true }]);
    expect(first).toEqual([{ promoted: false }]);
  });

  it("never leads after a queued tab gives up, and does not throw", async () => {
    tabs();
    const held = electLeader(LOCK, () => () => {});
    await settle();
    const waiting: unknown[] = [];
    const giveUpWaiting = electLeader(LOCK, (info) => {
      waiting.push(info);
      return () => {};
    });
    await settle();

    giveUpWaiting();
    await settle();
    held();
    await settle();
    expect(waiting).toEqual([]);
  });

  it("tears the leader down exactly once, however often it is released", async () => {
    tabs();
    const stop = vi.fn();
    const giveUp = electLeader(LOCK, () => stop);
    await settle();
    giveUp();
    giveUp();
    giveUp();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("hands the lock on to a third tab after two handovers", async () => {
    tabs();
    const order: string[] = [];
    const one = electLeader(LOCK, () => {
      order.push("one");
      return () => {};
    });
    await settle();
    const two = electLeader(LOCK, () => {
      order.push("two");
      return () => {};
    });
    electLeader(LOCK, () => {
      order.push("three");
      return () => {};
    });
    await settle();
    one();
    await settle();
    two();
    await settle();
    expect(order).toEqual(["one", "two", "three"]);
  });
});

describe("openTabChannel", () => {
  let restore = () => {};
  afterEach(() => {
    restore();
    restore = () => {};
  });

  it("carries a v1 frame to the other tab", () => {
    restore = installTabSync().restore;
    const seen: unknown[] = [];
    openTabChannel(CHANNEL, (msg) => seen.push(msg));
    const sender = openTabChannel(CHANNEL, () => {});
    sender.post({ v: 1, frame: "gap" });
    expect(seen).toEqual([{ v: 1, frame: "gap" }]);
  });

  it("drops a frame from a version it does not know", () => {
    restore = installTabSync().restore;
    const seen: unknown[] = [];
    openTabChannel(CHANNEL, (msg) => seen.push(msg));
    const sender = openTabChannel(CHANNEL, () => {});
    sender.post({ v: 2, frame: "gap" } as unknown as never);
    sender.post(null as unknown as never);
    expect(seen).toEqual([]);
  });

  it("stays callable after it is closed", () => {
    restore = installTabSync().restore;
    const channel = openTabChannel(CHANNEL, () => {});
    channel.close();
    expect(() => channel.post({ v: 1, frame: "gap" })).not.toThrow();
    expect(() => channel.close()).not.toThrow();
  });

  /**
   * The one case on the real API. Everything above runs on a fake whose
   * delivery is synchronous, so a fake that got the direction or the
   * self-delivery rule wrong would pass every one of them.
   */
  it("matches the real BroadcastChannel: peers hear it, the sender does not", async () => {
    const heardByReceiver: unknown[] = [];
    const heardBySender: unknown[] = [];
    const receiver = openTabChannel(CHANNEL, (msg) =>
      heardByReceiver.push(msg),
    );
    const sender = openTabChannel(CHANNEL, (msg) => heardBySender.push(msg));
    sender.post({ v: 1, frame: "me", data: "{}" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(heardByReceiver).toEqual([{ v: 1, frame: "me", data: "{}" }]);
    expect(heardBySender).toEqual([]);
    // Node's BroadcastChannel keeps the event loop alive until it is closed.
    receiver.close();
    sender.close();
  });
});
