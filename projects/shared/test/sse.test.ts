import { describe, expect, it } from "vitest";
import { SseDecoder } from "../src/sse.ts";

describe("SseDecoder", () => {
  it("reassembles frames split at any byte boundary", () => {
    const wire = 'event: change\ndata: {"id":1}\n\nevent: ping\ndata: {}\n\n';
    for (let cut = 0; cut <= wire.length; cut++) {
      const decoder = new SseDecoder();
      const frames = [
        ...decoder.push(wire.slice(0, cut)),
        ...decoder.push(wire.slice(cut)),
      ];
      expect(frames).toEqual([
        { event: "change", data: '{"id":1}' },
        { event: "ping", data: "{}" },
      ]);
    }
  });

  it("holds back a frame until its terminating blank line arrives", () => {
    const decoder = new SseDecoder();
    expect(decoder.push("event: change\ndata: {}\n")).toEqual([]);
    expect(decoder.push("\n")).toEqual([{ event: "change", data: "{}" }]);
  });

  it("joins repeated data fields and defaults the event name", () => {
    const decoder = new SseDecoder();
    expect(decoder.push("data: one\ndata: two\n\n")).toEqual([
      { event: "message", data: "one\ntwo" },
    ]);
  });

  it("skips comments and fields it has no use for", () => {
    const decoder = new SseDecoder();
    expect(
      decoder.push(": keep-alive\n\nid: 7\nretry: 5000\n\ndata: x\n\n"),
    ).toEqual([{ event: "message", data: "x" }]);
  });

  it("reassembles CRLF frames split at any byte boundary", () => {
    const wire = "event: change\r\ndata: {}\r\n\r\n";
    for (let cut = 0; cut <= wire.length; cut++) {
      const decoder = new SseDecoder();
      const frames = [
        ...decoder.push(wire.slice(0, cut)),
        ...decoder.push(wire.slice(cut)),
      ];
      // A cut between the \r and the \n must not read as a blank line —
      // that would end the frame early, at "event: change" with no data.
      expect(frames).toEqual([{ event: "change", data: "{}" }]);
    }
  });

  it("accepts a bare \\r as a line break", () => {
    const decoder = new SseDecoder();
    expect(decoder.push("event: change\rdata: {}\r\r")).toEqual([
      { event: "change", data: "{}" },
    ]);
  });

  it("strips exactly one space after the colon, and tolerates none", () => {
    const decoder = new SseDecoder();
    expect(decoder.push("data:  padded\n\ndata:tight\n\n")).toEqual([
      { event: "message", data: " padded" },
      { event: "message", data: "tight" },
    ]);
  });
});
