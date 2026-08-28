import { describe, expect, it } from "vitest";
import { DomainError } from "../src/errors.ts";
import {
  decodeListCursor,
  decodeTimelineCursor,
  encodeListCursor,
  encodeTimelineCursor,
} from "../src/services/cursor.ts";

/** The version-1 encoding: base64url of the position tuple as JSON. */
const legacy = (payload: unknown) =>
  Buffer.from(JSON.stringify(payload)).toString("base64url");

const expectMalformed = (fn: () => unknown) => {
  let caught: unknown;
  expect(() => {
    try {
      fn();
    } catch (error) {
      caught = error;
      throw error;
    }
  }).toThrow(DomainError);
  expect((caught as DomainError).status).toBe(422);
  expect((caught as DomainError).message).toBe("malformed cursor");
};

describe("timeline cursor codec", () => {
  const position = { t: "2026-08-28T10:31:27.680000Z", k: 1, i: 3771 } as const;

  it("encodes a position to the compact version-3 form", () => {
    // The card's own cursor, the length claim it is measured against.
    expect(encodeTimelineCursor(position)).toBe("3:hlrfxluubk.1.2wr");
    expect(encodeTimelineCursor(position)).toHaveLength(18);
    expect(legacy(position)).toHaveLength(67);
  });

  it("round-trips microsecond precision", () => {
    for (const t of [
      "2026-08-28T10:31:27.680000Z",
      "2026-02-02T10:00:00.000100Z",
      "2026-02-02T10:00:00.000000Z",
      "1970-01-01T00:00:00.000001Z",
      "2255-01-01T00:00:00.999999Z",
    ]) {
      for (const k of [0, 1] as const) {
        const cursor = { t, k, i: 1 };
        expect(decodeTimelineCursor(encodeTimelineCursor(cursor))).toEqual(
          cursor,
        );
      }
    }
  });

  it("keeps version-1 cursors readable", () => {
    expect(decodeTimelineCursor(legacy(position))).toEqual(position);

    // Millisecond `t` from servers before the precision fix, which agents
    // persist across restarts: still parsed, still widened downstream.
    const ms = { t: "2026-08-28T10:31:27.680Z", k: 0, i: 9 };
    expect(decodeTimelineCursor(legacy(ms))).toEqual(ms);
  });

  it("rejects malformed payloads under a known version", () => {
    for (const raw of [
      "3:hlrfxluubk.1", // too few segments
      "3:hlrfxluubk.1.2wr.5", // too many
      "3:hlrfxluubk.2.2wr", // kind outside {0, 1}
      "3:HLRFXLUUBK.1.2wr", // base36 is lowercase
      "3:hlrfxluubk.1.-2", // negative id
      "3:0.1.2wr", // zero microseconds
      "3:zzzzzzzzzzzzzz.1.2wr", // beyond the safe-integer range
      "3:.1.2wr",
      "3:",
      "5:hlrfxluubk.1.2wr", // a version this build does not mint
      "not-a-cursor!!",
      legacy({ t: "nonsense", k: 1, i: 3 }),
      legacy({ t: "2026-08-28T10:31:27.680Z", k: 2, i: 3 }),
      legacy({ t: "2026-08-28T10:31:27.680Z", k: 1, i: "3" }),
    ]) {
      expectMalformed(() => decodeTimelineCursor(raw));
    }
  });
});

describe("issue list cursor codec", () => {
  it("tags which sort key it was minted for", () => {
    const byTime = encodeListCursor({
      v: "2026-08-28T10:31:27.680000Z",
      i: 71,
    });
    const byNumber = encodeListCursor({ v: 47, i: 71 });
    expect(byTime).toBe("4:thlrfxluubk.1z");
    expect(byNumber).toBe("4:n1b.1z");

    expect(decodeListCursor(byTime, false)).toEqual({
      v: "2026-08-28T10:31:27.680000Z",
      i: 71,
    });
    expect(decodeListCursor(byNumber, true)).toEqual({ v: 47, i: 71 });
  });

  it("refuses a cursor minted for the other sort key", () => {
    // Read as a timestamp an issue number lands in 1970; read as a number a
    // timestamp is NaN. Both used to reach the SQL predicate.
    expectMalformed(() =>
      decodeListCursor(encodeListCursor({ v: 47, i: 71 }), false),
    );
    expectMalformed(() =>
      decodeListCursor(
        encodeListCursor({ v: "2026-08-28T10:31:27.680000Z", i: 71 }),
        true,
      ),
    );
  });

  it("keeps version-1 cursors readable, tag inferred from the payload", () => {
    const time = { v: "2026-08-28T10:31:27.680Z", i: 71 };
    const number = { v: 47, i: 71 };
    expect(decodeListCursor(legacy(time), false)).toEqual(time);
    expect(decodeListCursor(legacy(number), true)).toEqual(number);
    expectMalformed(() => decodeListCursor(legacy(number), false));
    expectMalformed(() => decodeListCursor(legacy(time), true));
  });

  it("rejects malformed payloads under a known version", () => {
    for (const raw of [
      "4:xhlrfxluubk.1z", // unknown sort tag
      "4:thlrfxluubk", // missing id
      "4:thlrfxluubk.1z.5",
      "4:t.1z",
      "4:t0.1z", // zero microseconds
      "4:",
      "6:t1.1z",
      legacy({ i: 71 }),
      legacy({ v: 47 }),
      legacy({ v: null, i: 71 }),
    ]) {
      expectMalformed(() => decodeListCursor(raw, false));
    }
  });
});
