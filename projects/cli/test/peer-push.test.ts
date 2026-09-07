import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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

type AuthFrame = { type: string; token: string };

/**
 * A non-UUID msg_id still delivers, but the receipt comes back with no
 * orig_msg_id to correlate — which holds for a bounce we mint as much as
 * for a push.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type FakePeer = {
  target: string;
  /** Every message frame the peer received, oldest first. */
  frames: Frame[];
  /** Every auth frame, kept apart so `frames[0]` still means the message. */
  authFrames: AuthFrame[];
  /** Reply to frame `n` the way the receiver does: over a new connection. */
  reply: (
    frame: Frame,
    status: string,
    reason?: string,
    extra?: Record<string, unknown>,
  ) => Promise<void>;
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
  const authFrames: AuthFrame[] = [];
  let arrived: (() => void) | null = null;
  const server: Server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
    });
    socket.on("end", () => {
      for (const line of buffer.split("\n")) {
        if (line.trim() === "") continue;
        const parsed = JSON.parse(line) as { type?: string };
        if (parsed.type === "auth") authFrames.push(parsed as AuthFrame);
        else frames.push(parsed as Frame);
      }
      arrived?.();
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(target, resolve));
  return {
    target,
    frames,
    authFrames,
    reply: (frame, status, reason, extra) =>
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
              ...extra,
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

type Replier = {
  /** The address its frames claim to come from, `uds:`-prefixed. */
  from: string;
  /** Every frame that came back to it, oldest first. */
  frames: Array<Record<string, unknown>>;
  /** Wait until `n` frames have arrived. */
  received: (n: number) => Promise<void>;
  close: () => Promise<void>;
};

/**
 * The session that replied: a socket of its own, bound where the caller
 * says — inside the push's directory, which is where a real session's
 * socket sits, or outside it, which is what the vet has to turn away.
 */
async function fakeReplier(dir: string, name: string): Promise<Replier> {
  const path = join(dir, name);
  const frames: Array<Record<string, unknown>> = [];
  let arrived: (() => void) | null = null;
  const server: Server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
    });
    socket.on("end", () => {
      for (const line of buffer.split("\n")) {
        if (line.trim() !== "") frames.push(JSON.parse(line));
      }
      arrived?.();
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    from: `uds:${path}`,
    frames,
    received: (n) =>
      frames.length >= n
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            arrived = () => {
              if (frames.length >= n) resolve();
            };
          }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** One frame written to a push's reply address, as a replier sends it. */
function replyTo(address: string, frame: unknown): Promise<void> {
  return dialLine(address.replace(/^uds:/, ""), `${JSON.stringify(frame)}\n`);
}

/** A reply, in the shape the receiving session actually writes one. */
const userReply = (replier: Replier, msgId: string) => ({
  msgV: 1,
  msg_id: msgId,
  type: "user",
  priority: "next",
  from: replier.from,
  message: {
    role: "user",
    content: `<cross-session-message from="${replier.from}">\nnoted\n</cross-session-message>`,
  },
});

/** Waits out a counter the listener bumps off a socket event of its own. */
async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(check()).toBe(true);
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
      fromMode: () => "bypass",
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
    // The `no-reply-` prefix is the whole point of the address rather than
    // cosmetics: it is the string the receiving side tells its Claude to
    // reply to, which is where the channel states that it takes no mail.
    expect(basename(frame.from)).toMatch(/^no-reply-todou-watch-\d+\.sock$/);
    expect(frame.msg_id).toMatch(UUID);
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

describe("openPeerPush auth line (T-255)", () => {
  it("opens every connection with the auth frame", async () => {
    const peer = await fakePeer("auth");
    const payloads: string[] = [];
    const push = await openPeerPush<string>({
      target: peer.target,
      render,
      fromName: "todou-watch",
      clock: virtualClock(),
      token: "abc",
      dial: async (target, payload) => {
        payloads.push(payload);
        await dialLine(target, payload);
      },
    });
    await push.send(["entry one"], "c0", "c1");
    await peer.received(1);

    // First line of the connection, byte for byte as Claude Code writes it:
    // an auth frame in any later position is ignored outright.
    expect(payloads[0]).toMatch(/^\{"type":"auth","token":"abc"\}\n/);
    expect(peer.authFrames).toEqual([{ type: "auth", token: "abc" }]);
    expect(peer.frames).toHaveLength(1);

    // Each push dials a new connection, and only a fresh connection can
    // carry an auth frame, so the line goes out every time.
    await push.send(["entry two"], "c1", "c2");
    await peer.received(2);
    expect(peer.authFrames).toEqual([
      { type: "auth", token: "abc" },
      { type: "auth", token: "abc" },
    ]);

    push.close();
    await peer.close();
  });

  it("dials bare when there is no token to send", async () => {
    const peer = await fakePeer("notoken");
    const push = await openPeerPush<string>({
      target: peer.target,
      render,
      fromName: "todou-watch-T-252",
      fromMode: () => "bypass",
      clock: virtualClock(),
    });
    await push.send(["entry one"], "c0", "c1");
    await peer.received(1);
    const frame = peer.frames[0] as Frame;

    expect(peer.authFrames).toEqual([]);
    // POSIX before v2.1.228 exported a socket and no token, and it accepts
    // a connection that opens with the message frame — so the wire format
    // of that frame has to be what it was before this option existed.
    expect(frame.message.content).toBe(
      `<cross-session-message from="${frame.from}" ` +
        'from-name="todou-watch-T-252" from-mode="bypass">\n' +
        "entry one\nsince: c0\ncursor: c1\n</cross-session-message>",
    );

    push.close();
    await peer.close();
  });

  it("refuses to open on native Windows without a token", async () => {
    const peer = await fakePeer("win-notoken");
    await expect(
      openPeerPush<string>({
        target: peer.target,
        render,
        fromName: "todou-watch",
        clock: virtualClock(),
        platform: "win32",
      }),
    ).rejects.toThrow(/CLAUDE_CODE_MESSAGING_TOKEN/);

    await peer.close();
  });

  it("says on native Windows that receipts are unverified", async () => {
    const peer = await fakePeer("win-note");
    const notes: string[] = [];
    const push = await openPeerPush<string>({
      target: peer.target,
      render,
      fromName: "todou-watch",
      clock: virtualClock(),
      platform: "win32",
      token: "abc",
      note: (message) => notes.push(message),
    });

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("native Windows");

    push.close();
    await peer.close();
  });

  it("stays quiet about the platform anywhere else", async () => {
    const peer = await fakePeer("posix-note");
    const notes: string[] = [];
    const push = await openPeerPush<string>({
      target: peer.target,
      render,
      fromName: "todou-watch",
      clock: virtualClock(),
      platform: "linux",
      token: "abc",
      note: (message) => notes.push(message),
    });

    expect(notes).toEqual([]);

    push.close();
    await peer.close();
  });

  it("keeps the token out of every diagnostic", async () => {
    const peer = await fakePeer("secret");
    const secret = "tok_do_not_print";
    const notes: string[] = [];
    const push = await openPeerPush<string>({
      target: peer.target,
      render,
      fromName: "todou-watch",
      clock: virtualClock(),
      platform: "win32",
      token: secret,
      note: (message) => notes.push(message),
    });
    // The failure path describes the error and never what was written,
    // which is the whole payload and carries the credential.
    await push.send(["entry one"], "c0", "c1");
    await peer.vanish();
    await push.send(["entry two"], "c1", "c2");
    await push.whenRejected;

    expect(notes).toHaveLength(1);
    expect(push.rejected).not.toBeNull();
    expect([...notes, JSON.stringify(push.rejected)].join("\n")).not.toContain(
      secret,
    );

    push.close();
  });
});

describe("openPeerPush payload limit (T-255)", () => {
  it("replaces a batch it cannot fit with its range", async () => {
    const peer = await fakePeer("toobig");
    const payloads: string[] = [];
    const push = await openPeerPush<string>({
      target: peer.target,
      render,
      fromName: "todou-watch",
      clock: virtualClock(),
      dial: async (target, payload) => {
        payloads.push(payload);
        await dialLine(target, payload);
      },
    });
    await push.send(["x".repeat(1_100_000), "entry two"], "c0", "c1");
    await peer.received(1);

    // Past the cap the receiver destroys the connection without a receipt,
    // which this channel reads as a delivery — so the batch never goes out
    // at that size in the first place.
    expect(payloads).toHaveLength(1);
    expect((payloads[0] as string).length).toBeLessThanOrEqual(1_048_576);
    const content = (peer.frames[0] as Frame).message.content;
    expect(content).toContain("batch of 2 entries was too large to push");
    expect(content).not.toContain("entry two");
    // The range is what makes this a pointer rather than a loss: the reader
    // re-reads the entries from the tracker starting at `since`.
    expect(content).toContain("since: c0");
    expect(content.split("\n").at(-2)).toBe("cursor: c1");

    push.close();
    await peer.close();
  });

  it("counts one oversized entry as one entry", async () => {
    const peer = await fakePeer("toobig-one");
    const push = await openPeerPush<string>({
      target: peer.target,
      render,
      fromName: "todou-watch",
      clock: virtualClock(),
    });
    await push.send(["x".repeat(1_100_000)], "c0", "c1");
    await peer.received(1);

    expect((peer.frames[0] as Frame).message.content).toContain(
      "batch of 1 entry was too large to push",
    );

    push.close();
    await peer.close();
  });
});

describe("openPeerPush attested mode (T-292)", () => {
  it("asks again for every push", async () => {
    const peer = await fakePeer("mode-per-push");
    const modes: Array<"bypass" | "prompting"> = ["bypass", "prompting"];
    let asked = 0;
    const push = await openPeerPush<string>({
      target: peer.target,
      render,
      fromName: "todou-watch",
      clock: virtualClock(),
      fromMode: () => modes[asked++],
    });
    await push.send(["entry one"], "c0", "c1");
    await peer.received(1);
    await push.send(["entry two"], "c1", "c2");
    await peer.received(2);

    // Read once at channel open this would attest "bypass" twice, which is
    // the whole of what a resident watch gets wrong.
    expect((peer.frames[0] as Frame).message.content).toContain(
      'from-mode="bypass"',
    );
    expect((peer.frames[1] as Frame).message.content).toContain(
      'from-mode="prompting"',
    );

    push.close();
    await peer.close();
  });

  it("asks once per push, not once per rendering", async () => {
    const peer = await fakePeer("mode-oversize");
    let asked = 0;
    const push = await openPeerPush<string>({
      target: peer.target,
      render,
      fromName: "todou-watch",
      clock: virtualClock(),
      fromMode: () => {
        asked += 1;
        return "bypass";
      },
    });
    // The oversize path below renders a second time, and a batch's two
    // renderings must not be able to disagree about who sent them.
    await push.send(["x".repeat(1_100_000)], "c0", "c1");
    await peer.received(1);

    expect(asked).toBe(1);

    push.close();
    await peer.close();
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

describe("openPeerPush receipt correlation (T-255)", () => {
  it("reads an expired receipt detailed as refused as a refusal", async () => {
    const peer = await fakePeer("detail");
    const push = await openPeerPush<string>({
      target: peer.target,
      render,
      fromName: "todou-watch",
      clock: virtualClock(),
    });
    await push.send(["entry one"], "c0", "c1");
    await peer.received(1);
    // How the receiver spells its own refusal: naming it "aged out unread"
    // would send the user looking at the wrong setting.
    await peer.reply(peer.frames[0] as Frame, "expired", undefined, {
      status_detail: "refused",
    });
    await push.whenRejected;

    expect(push.rejected?.status).toBe("refused");

    push.close();
    await peer.close();
  });

  it("recognizes a batch named only in dropped_msg_ids", async () => {
    const peer = await fakePeer("dropped-list");
    const push = await openPeerPush<string>({
      target: peer.target,
      render,
      fromName: "todou-watch",
      clock: virtualClock(),
    });
    await push.send(["entry one"], "c0", "c1");
    await peer.received(1);
    const frame = peer.frames[0] as Frame;
    // A merged drop receipt names the message that overflowed the queue in
    // orig_msg_id and the older ones it discarded in the list, so the two
    // are different messages and only the list mentions ours.
    await peer.reply(
      { ...frame, msg_id: "00000000-0000-0000-0000-000000000000" },
      "dropped",
      "queue full",
      { dropped_msg_ids: [frame.msg_id] },
    );
    await push.whenRejected;

    expect(push.rejected).toEqual({ status: "dropped", reason: "queue full" });

    push.close();
    await peer.close();
  });

  it("gives up at once when a sandbox blocks the socket", async () => {
    const peer = await fakePeer("eacces");
    const push = await openPeerPush<string>({
      target: peer.target,
      render,
      fromName: "todou-watch",
      clock: virtualClock(),
      dial: () => {
        throw Object.assign(new Error("connect EACCES"), { code: "EACCES" });
      },
    });
    // One attempt, not three: no number of retries changes a setting.
    await push.send(["one"], "c0", "c1");
    await push.whenRejected;

    expect(push.rejected?.status).toBe("unreachable");
    expect(push.rejected?.reason).toContain("sandbox.network.allowUnixSockets");

    push.close();
    await peer.close();
  });
});

describe("openPeerPush replies to a no-reply address (T-258)", () => {
  const MSG_A = "11111111-1111-1111-1111-111111111111";
  const MSG_B = "22222222-2222-2222-2222-222222222222";

  /** A channel with one push out, and the frame it can be answered from. */
  const pushed = async (name: string) => {
    const peer = await fakePeer(name);
    const push = await openPeerPush<string>({
      target: peer.target,
      render,
      fromName: "todou-watch",
      clock: virtualClock(),
    });
    await push.send(["entry one"], "c0", "c1");
    await peer.received(1);
    return { peer, push, frame: peer.frames[0] as Frame };
  };

  it("bounces a reply back to the address it came from", async () => {
    const { peer, push, frame } = await pushed("reply");
    const replier = await fakeReplier(dirname(peer.target), "417584.sock");

    await replyTo(frame.from, userReply(replier, MSG_A));
    await replier.received(1);

    // A status, not prose: both wordings the replying session shows come
    // from a fixed table keyed on it, and `reason` is never read there.
    expect(replier.frames[0]).toMatchObject({
      type: "control",
      action: "peer_message_status",
      status: "refused",
      orig_msg_id: MSG_A,
      from: frame.from,
    });
    expect(replier.frames[0]?.msg_id).toMatch(UUID);
    // No auth line: the token here is a child token for our own parent
    // session's inbox, and a peer has no business holding it.
    expect(replier.frames).toHaveLength(1);
    expect(push.replies()).toEqual({ discarded: 1, unbounced: 0 });

    push.close();
    await replier.close();
    await peer.close();
  });

  it("counts a reply from another directory without dialling it", async () => {
    const { peer, push, frame } = await pushed("reply-outside");
    const inside = await fakeReplier(dirname(peer.target), "417584.sock");
    const outside = await fakeReplier(
      mkdtempSync(join(root, "outside-")),
      "417585.sock",
    );

    await replyTo(frame.from, userReply(outside, MSG_A));
    // The next bounce proves the first frame was handled: connections are
    // accepted in the order they were opened.
    await replyTo(frame.from, userReply(inside, MSG_B));
    await inside.received(1);

    // Bound and listening, so a dial would have landed — it was never made.
    expect(outside.frames).toEqual([]);
    expect(push.replies()).toEqual({ discarded: 2, unbounced: 0 });

    push.close();
    await inside.close();
    await outside.close();
    await peer.close();
  });

  it("stays as invisible as ever about any other frame", async () => {
    const { peer, push, frame } = await pushed("reply-other");
    const replier = await fakeReplier(dirname(peer.target), "417584.sock");

    await replyTo(frame.from, {
      type: "control",
      action: "peer_idle_notice",
      from: replier.from,
    });
    await replyTo(frame.from, userReply(replier, MSG_A));
    await replier.received(1);

    // Neither counted nor answered: a frame this listener is not addressed
    // by is not a reply, and a bounce for it would be noise.
    expect(replier.frames).toHaveLength(1);
    expect(push.replies()).toEqual({ discarded: 1, unbounced: 0 });

    push.close();
    await replier.close();
    await peer.close();
  });

  it("keeps the channel usable when a bounce cannot be written", async () => {
    const peer = await fakePeer("bounce-fails");
    const push = await openPeerPush<string>({
      target: peer.target,
      render,
      fromName: "todou-watch",
      clock: virtualClock(),
      // Only the bounce fails. A peer's unreachable socket says nothing
      // about whether our own session is still listening, so `failures`
      // must not move and the channel must stay open.
      dial: async (to, payload) => {
        if (to !== peer.target) throw new Error("bounce blocked");
        await dialLine(to, payload);
      },
    });
    await push.send(["entry one"], "c0", "c1");
    await peer.received(1);
    const frame = peer.frames[0] as Frame;
    const replier = await fakeReplier(dirname(peer.target), "417584.sock");

    await replyTo(frame.from, userReply(replier, MSG_A));
    await eventually(() => push.replies().unbounced === 1);

    expect(push.rejected).toBeNull();
    await push.send(["entry two"], "c1", "c2");
    await peer.received(2);
    expect(push.replies()).toEqual({ discarded: 1, unbounced: 1 });
    expect(replier.frames).toEqual([]);

    push.close();
    await replier.close();
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
