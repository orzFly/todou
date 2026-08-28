import { describe, expect, it } from "vitest";
import {
  decodeMultiCursor,
  encodeMultiCursor,
  MalformedMultiCursorError,
  UnsupportedCursorVersionError,
} from "../src/schemas/cursor-envelope.ts";

/** A version-1 plain cursor: base64url of the (t, k, i) position tuple. */
const plainCursor = (i: number) =>
  Buffer.from(
    JSON.stringify({ t: "2026-08-11T12:00:00.123456Z", k: 1, i }),
  ).toString("base64url");

/** The same position in the compact version-3 form the server now mints. */
const compactCursor = (i: number) => `3:hl8rm75glc.1.${i.toString(36)}`;

describe("cursor envelope", () => {
  it("round-trips per-project positions, including empty streams", async () => {
    const positions = {
      frontend: plainCursor(42),
      backend: null,
    };
    const encoded = await encodeMultiCursor(positions);
    expect(encoded.startsWith("2:")).toBe(true);
    expect(await decodeMultiCursor(encoded)).toEqual(positions);
  });

  it("encodes one set of positions to exactly one string", async () => {
    const a = await encodeMultiCursor({
      alpha: plainCursor(1),
      beta: plainCursor(2),
    });
    const b = await encodeMultiCursor({
      beta: plainCursor(2),
      alpha: plainCursor(1),
    });
    expect(a).toBe(b);
  });

  it("compresses: many projects stay far below the uncompressed size", async () => {
    const positions = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`project-${i}`, plainCursor(i)]),
    );
    const encoded = await encodeMultiCursor(positions);
    const uncompressed = Buffer.from(JSON.stringify(positions)).toString(
      "base64url",
    );
    expect(encoded.length).toBeLessThan(uncompressed.length / 2);
  });

  it("returns null for anything without a version prefix", async () => {
    expect(await decodeMultiCursor(plainCursor(7))).toBeNull();
    expect(await decodeMultiCursor("")).toBeNull();
    expect(await decodeMultiCursor("not-base64!!")).toBeNull();
  });

  it("returns null for the plain-cursor versions", async () => {
    // A compact cursor carries a version prefix but is not an envelope: the
    // server decodes it itself, which is what lets an `issue view` cursor
    // bootstrap a cross-project watch.
    expect(await decodeMultiCursor(compactCursor(7))).toBeNull();
    expect(await decodeMultiCursor("4:thlrfxluubk.1z")).toBeNull();
  });

  it("round-trips an envelope of compact cursors", async () => {
    const positions = { frontend: compactCursor(42), backend: null };
    const encoded = await encodeMultiCursor(positions);
    expect(await decodeMultiCursor(encoded)).toEqual(positions);
  });

  it("rejects foreign version prefixes loudly", async () => {
    await expect(decodeMultiCursor("5:abcd")).rejects.toBeInstanceOf(
      UnsupportedCursorVersionError,
    );
    await expect(decodeMultiCursor("1:abcd")).rejects.toBeInstanceOf(
      UnsupportedCursorVersionError,
    );
  });

  it("rejects version-2 envelopes with broken payloads", async () => {
    // Corrupt deflate stream.
    await expect(decodeMultiCursor("2:AAAA")).rejects.toBeInstanceOf(
      MalformedMultiCursorError,
    );
    // Valid deflate, but the JSON is not a slug→cursor record.
    const deflate = async (text: string) => {
      const stream = new Blob([new TextEncoder().encode(text)])
        .stream()
        .pipeThrough(new CompressionStream("deflate-raw"));
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      return `2:${Buffer.from(bytes).toString("base64url")}`;
    };
    await expect(
      deflate("[1,2]").then(decodeMultiCursor),
    ).rejects.toBeInstanceOf(MalformedMultiCursorError);
    await expect(
      deflate('{"ok":7}').then(decodeMultiCursor),
    ).rejects.toBeInstanceOf(MalformedMultiCursorError);
    await expect(
      deflate('{"UPPER":"c"}').then(decodeMultiCursor),
    ).rejects.toBeInstanceOf(MalformedMultiCursorError);
    await expect(
      deflate("not json").then(decodeMultiCursor),
    ).rejects.toBeInstanceOf(MalformedMultiCursorError);
  });
});
