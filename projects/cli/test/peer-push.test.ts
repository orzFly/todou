import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openPeerPush, wrapEnvelope } from "../src/peer-push.ts";
import { virtualClock } from "./harness.ts";

// Short path, far from the ~108-byte sun_path limit that a repo-relative
// socket directory would spend most of on its own.
const root = mkdtempSync(join(tmpdir(), "todou-sock-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Frame = {
  type: string;
  priority: string;
  from: string;
  msg_id: string;
  message: { role: string; content: string };
};

type FakePeer = {
  target: string;
  /** Every frame the peer received, oldest first. */
  frames: Frame[];
  /** Reply to frame `n` the way the receiver does: over a new connection. */
  reply: (frame: Frame, status: string, reason?: string) => Promise<void>;
  /** Wait until `n` frames have arrived. */
  received: (n: number) => Promise<void>;
  /** Stop listening and remove the socket node, as a dead session would. */
  vanish: () => Promise<void>;
  close: () => Promise<void>;
};

/**
 * The receiving session, as far as this transport can tell: a socket that
 * collects frames and answers on a connection of its own — which is how a
 * real receipt travels, so the round trip is exercised rather than faked.
 */
async function fakePeer(name: string): Promise<FakePeer> {
  const dir = mkdtempSync(join(root, `${name}-`));
  const target = join(dir, "peer.sock");
  const frames: Frame[] = [];
  let arrived: (() => void) | null = null;
  const server: Server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
    });
    socket.on("end", () => {
      for (const line of buffer.split("\n")) {
        if (line.trim() !== "") frames.push(JSON.parse(line) as Frame);
      }
      arrived?.();
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(target, resolve));
  return {
    target,
    frames,
    reply: (frame, status, reason) =>
      new Promise((resolve, rejectReply) => {
        const back = frame.from.replace(/^uds:/, "");
        const socket = connect(back);
        socket.on("error", rejectReply);
        socket.on("connect", () =>
          socket.end(
            `${JSON.stringify({
              type: "control",
              action: "peer_message_status",
              orig_msg_id: frame.msg_id,
              status,
              ...(reason === undefined ? {} : { reason }),
            })}\n`,
            () => {
              socket.destroy();
              resolve();
            },
          ),
        );
      }),
    received: (n) =>
      frames.length >= n
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            arrived = () => {
              if (frames.length >= n) resolve();
            };
          }),
    vanish: () =>
      new Promise((resolve) => {
        server.close(() => {
          rmSync(target, { force: true });
          resolve();
        });
      }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** The batch shape the watch loop pushes: entries plus a cursor range. */
const render = (
  items: string[],
  since: string | undefined,
  cursor: string | undefined,
) =>
  [
    ...items,
    ...(since === undefined ? [] : [`since: ${since}`]),
    `cursor: ${cursor}`,
  ].join("\n");

describe("openPeerPush wire format (T-252)", () => {
  it("sends a frame the receiver will answer", async () => {
    const peer = await fakePeer("wire");
    const push = await openPeerPush<string>({
      target: peer.target,
      render,
      fromName: "todou-watch-T-252",
      fromMode: "bypass",
      clock: virtualClock(),
    });
    await push.send(["entry one"], "c0", "c1");
    await peer.received(1);
    const frame = peer.frames[0] as Frame;

    expect(frame.type).toBe("user");
    // Queued behind the current turn rather than interrupting it.
    expect(frame.priority).toBe("next");
    expect(frame.message.role).toBe("user");
    // A `from` that is not a uds: URI over an absolute .sock path gets no
    // receipt at all, so there would be nothing to degrade on.
    expect(frame.from).toMatch(/^uds:\/.*\.sock$/);
    // A non-UUID msg_id still delivers but comes back with no
    // orig_msg_id, which silently breaks correlation.
    expect(frame.msg_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // Byte for byte: the receiver re-serializes what it parsed and drops
    // the envelope on any difference.
    expect(frame.message.content).toBe(
      `<cross-session-message from="${frame.from}" ` +
        'from-name="todou-watch-T-252" from-mode="bypass">\n' +
        "entry one\nsince: c0\ncursor: c1\n</cross-session-message>",
    );

    push.close();
    await peer.close();
  });

  it("omits an attribute it has no value for", () => {
    expect(
      wrapEnvelope({ from: "uds:/x.sock", fromName: "todou-watch", body: "b" }),
    ).toBe(
      '<cross-session-message from="uds:/x.sock" from-name="todou-watch">\n' +
        "b\n</cross-session-message>",
    );
  });
});

describe("openPeerPush receipts (T-252)", () => {
  for (const status of ["held", "refused", "denied", "dropped", "expired"]) {
    it(`treats a ${status} receipt as a rejection`, async () => {
      const peer = await fakePeer(status);
      const push = await openPeerPush<string>({
        target: peer.target,
        render,
        fromName: "todou-watch",
        clock: virtualClock(),
      });
      await push.send(["entry one"], "c0", "c1");
      await peer.received(1);
      await peer.reply(peer.frames[0] as Frame, status, `because ${status}`);
      // Driven by the real socket event, not by a virtual sleep: a virtual
      // clock resolves on a macrotask and would race the I/O.
      await push.whenRejected;

      expect(push.rejected).toEqual({
        status,
        reason: `because ${status}`,
      });
      expect(push.unconfirmed()).toEqual({
        items: ["entry one"],
        since: "c0",
        cursor: "c1",
      });

      push.close();
      await peer.close();
    });
  }

  it("ignores a receipt for a message it did not send", async () => {
    const peer = await fakePeer("stray");
    const push = await openPeerPush<string>({
      target: peer.target,
      render,
      fromName: "todou-watch",
      clock: virtualClock(),
    });
    await push.send(["entry one"], "c0", "c1");
    await peer.received(1);
    const frame = peer.frames[0] as Frame;
    await peer.reply(
      { ...frame, msg_id: "00000000-0000-0000-0000-000000000000" },
      "refused",
    );
    // Nothing to await but the delivery itself; a round trip over the same
    // socket is ordered, so one more frame proves the first was handled.
    await peer.reply(frame, "delivered");

    expect(push.rejected).toBeNull();

    push.close();
    await peer.close();
  });

  it("counts a batch nothing negative arrived about as landed", async () => {
    const peer = await fakePeer("window");
    const clock = virtualClock();
    const push = await openPeerPush<string>({
      target: peer.target,
      render,
      fromName: "todou-watch",
      clock,
      receiptWindowMs: 30_000,
    });
    await push.send(["entry one"], "c0", "c1");
    await peer.received(1);
    expect(push.unconfirmed().items).toEqual(["entry one"]);

    await clock.sleep(29_999);
    expect(push.unconfirmed().items).toEqual(["entry one"]);
    await clock.sleep(1);
    expect(push.unconfirmed()).toEqual({
      items: [],
      since: undefined,
      cursor: undefined,
    });
    expect(push.rejected).toBeNull();

    push.close();
    await peer.close();
  });
});

describe("openPeerPush retries and the cursor chain (T-252)", () => {
  it("carries an unsent batch into the next push", async () => {
    const peer = await fakePeer("resend");
    const failures: string[] = [];
    let refuse = 2;
    const push = await openPeerPush<string>({
      target: peer.target,
      render,
      fromName: "todou-watch",
      clock: virtualClock(),
      dial: async (target, line) => {
        if (refuse-- > 0) {
          failures.push(line);
          // Not ENOENT/ECONNREFUSED: a blip, not a session that is gone.
          throw Object.assign(new Error("write failed"), { code: "EPIPE" });
        }
        await dialLine(target, line);
      },
    });

    await push.send(["one"], "c0", "c1");
    await push.send(["two"], "c1", "c2");
    // Two failures is not three: the channel is still worth using.
    expect(push.rejected).toBeNull();
    expect(failures).toHaveLength(2);
    await push.send(["three"], "c2", "c3");
    await peer.received(1);

    const content = (peer.frames[0] as Frame).message.content;
    // One envelope's worth of boilerplate for three batches …
    expect(content).toContain("one\ntwo\nthree\n");
    // … and the range still starts where the first unsent batch did, so a
    // reader comparing it against the previous push's cursor sees no gap.
    expect(content).toContain("since: c0\ncursor: c3\n");
    expect(push.unconfirmed().items).toEqual(["one", "two", "three"]);

    push.close();
    await peer.close();
  });

  it("gives up after three consecutive failures", async () => {
    const peer = await fakePeer("giveup");
    const push = await openPeerPush<string>({
      target: peer.target,
      render,
      fromName: "todou-watch",
      clock: virtualClock(),
      dial: () => {
        throw Object.assign(new Error("write failed"), { code: "EPIPE" });
      },
    });
    await push.send(["one"], "c0", "c1");
    await push.send(["two"], "c1", "c2");
    expect(push.rejected).toBeNull();
    await push.send(["three"], "c2", "c3");
    await push.whenRejected;

    expect(push.rejected?.status).toBe("unreachable");
    expect(push.unconfirmed()).toEqual({
      items: ["one", "two", "three"],
      since: "c0",
      cursor: "c3",
    });

    push.close();
    await peer.close();
  });

  it("gives up at once when the target socket is gone", async () => {
    const peer = await fakePeer("gone");
    const push = await openPeerPush<string>({
      target: peer.target,
      render,
      fromName: "todou-watch",
      clock: virtualClock(),
    });
    await peer.vanish();
    await push.send(["one"], "c0", "c1");
    await push.whenRejected;

    // The session is gone; there is no recipient to queue for.
    expect(push.rejected?.status).toBe("unreachable");
    expect(push.unconfirmed().items).toEqual(["one"]);

    push.close();
  });

  it("keeps each push's range abutting the last one's", async () => {
    const peer = await fakePeer("chain");
    const clock = virtualClock();
    const push = await openPeerPush<string>({
      target: peer.target,
      render,
      fromName: "todou-watch",
      clock,
    });
    await push.send(["one"], "c0", "c1");
    await peer.received(1);
    await push.send(["two"], "c1", "c2");
    await peer.received(2);
    await push.send(["three"], "c2", "c3");
    await peer.received(3);

    const ranges = peer.frames.map((frame) => {
      const body = frame.message.content;
      return {
        since: /since: (\S+)/.exec(body)?.[1],
        cursor: /cursor: (\S+)/.exec(body)?.[1],
      };
    });
    expect(ranges).toEqual([
      { since: "c0", cursor: "c1" },
      { since: "c1", cursor: "c2" },
      { since: "c2", cursor: "c3" },
    ]);
    // This is the whole basis of the receiver checking its own gaps: the
    // previous push's cursor is the next push's since, always.
    for (const [i, range] of ranges.entries()) {
      if (i > 0) expect(range.since).toBe(ranges[i - 1]?.cursor);
    }

    push.close();
    await peer.close();
  });

  it("omits the since line for a watch set with no history", async () => {
    const peer = await fakePeer("nobase");
    const push = await openPeerPush<string>({
      target: peer.target,
      render,
      fromName: "todou-watch",
      clock: virtualClock(),
    });
    await push.send(["one"], undefined, "c1");
    await peer.received(1);

    const content = (peer.frames[0] as Frame).message.content;
    expect(content).not.toContain("since:");
    expect(content).toContain("cursor: c1");

    push.close();
    await peer.close();
  });
});

/** The production dial, duplicated so a test can wrap it selectively. */
function dialLine(target: string, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(target);
    socket.on("error", reject);
    socket.on("connect", () =>
      socket.end(line, () => {
        socket.destroy();
        resolve();
      }),
    );
  });
}
