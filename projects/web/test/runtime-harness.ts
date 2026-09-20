import type { Me } from "@todou/shared";
import {
  type AuthChannel,
  AuthControl,
  type AuthLocks,
  type AuthStorage,
} from "../src/api/runtime/auth-control.ts";
import type { RuntimeWorker } from "../src/api/runtime/bridge.ts";
import { defineProjection } from "../src/api/runtime/projections.ts";
import type { ServerMessage } from "../src/api/runtime/protocol.ts";
import { resource } from "../src/api/runtime/resources.ts";
import type {
  RuntimePort,
  RuntimeSessionHost,
} from "../src/api/runtime/session.ts";

export const identity = (id = 1) =>
  ({ id, login: id === 1 ? "alice" : "bot-one" }) as Me;
export const issueResource = resource("issue", "/projects/example/issues/1");
export const issueProjection = defineProjection({
  kind: "direct",
  version: 1,
  queryKey: ["issue", "example", 1],
  queryHash: '["issue","example",1]',
  resources: [issueResource],
});

export async function settle(): Promise<void> {
  for (let turn = 0; turn < 30; turn++) await Promise.resolve();
}

export class FakePort implements RuntimePort {
  peer?: FakePort;
  sent: unknown[] = [];
  received: ServerMessage[] = [];
  closed = false;
  onmessage: RuntimePort["onmessage"] = null;
  onmessageerror: RuntimePort["onmessageerror"] = null;
  postMessage(message: unknown): void {
    if (this.closed) return;
    this.sent.push(message);
    const peer = this.peer;
    void Promise.resolve().then(() => {
      if (!peer || peer.closed) return;
      peer.received.push(message as ServerMessage);
      peer.onmessage?.({ data: message } as MessageEvent);
    });
  }
  start(): void {}
  close(): void {
    this.closed = true;
  }
}
export function ports(): { page: FakePort; worker: FakePort } {
  const page = new FakePort();
  const worker = new FakePort();
  page.peer = worker;
  worker.peer = page;
  return { page, worker };
}

export class MemoryStorage implements AuthStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}
export class SerialLocks implements AuthLocks {
  private tails = new Map<string, Promise<unknown>>();
  request<T>(name: string, callback: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(name) ?? Promise.resolve())
      .catch(() => {})
      .then(callback);
    this.tails.set(name, result);
    void result
      .finally(() => {
        if (this.tails.get(name) === result) this.tails.delete(name);
      })
      .catch(() => {});
    return result;
  }
}
export class Channels {
  private peers: AuthChannel[] = [];
  open(): AuthChannel {
    const channel: AuthChannel = {
      onmessage: null,
      postMessage: (message) => {
        for (const peer of this.peers)
          if (peer !== channel)
            void Promise.resolve().then(() =>
              peer.onmessage?.({ data: message } as MessageEvent),
            );
      },
      close: () => {
        this.peers = this.peers.filter((peer) => peer !== channel);
      },
    };
    this.peers.push(channel);
    return channel;
  }
}
export function authEnvironment() {
  const storage = new MemoryStorage();
  const locks = new SerialLocks();
  const channels = new Channels();
  return {
    storage,
    locks,
    channels,
    control: (withLocks = true) =>
      new AuthControl({
        apiMount: "/api",
        storage,
        locks: withLocks ? locks : null,
        channel: channels.open(),
      }),
  };
}

export function workerFactory(host: RuntimeSessionHost): {
  factory: () => RuntimeWorker;
  workers: RuntimeWorker[];
  connections: FakePort[];
} {
  const workers: RuntimeWorker[] = [];
  const connections: FakePort[] = [];
  return {
    workers,
    connections,
    factory: () => {
      const pair = ports();
      host.attach(pair.worker);
      const worker: RuntimeWorker = { port: pair.page, onerror: null };
      workers.push(worker);
      connections.push(pair.page);
      return worker;
    },
  };
}

export async function hello(host: RuntimeSessionHost, origin = "page-a") {
  const pair = ports();
  host.attach(pair.worker);
  let nextId = 0;
  pair.page.postMessage({
    type: "HELLO",
    requestId: String(++nextId),
    protocolVersion: 1,
    buildId: "test",
    apiMount: "/api",
    pageOrigin: "https://todou.example",
    clientOrigin: origin,
  });
  await settle();
  const ready = pair.page.received.find((message) => message.type === "READY")!;
  const send = (type: string, payload: Record<string, unknown> = {}) => {
    const requestId = String(++nextId);
    pair.page.postMessage({
      type,
      protocolVersion: 1,
      runtimeGeneration: ready.runtimeGeneration,
      portId: ready.portId,
      accountEpoch: host.identity.epoch,
      requestId,
      ...payload,
    });
    return requestId;
  };
  return { ...pair, ready, send };
}
