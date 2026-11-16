import { describe, expect, it } from "vitest";
import { quietNote, runWatchLoop } from "../src/watch-loop.ts";
import { virtualClock } from "./harness.ts";

/** An entry the script reveals once the virtual clock reaches `appearsAt`. */
type Entry = { id: string; minor: boolean; created_at: string };
type Scripted = { appearsAtSec: number; entry: Entry };

const at = (
  clock: ReturnType<typeof virtualClock>,
  appearsAtSec: number,
  id: string,
  minor: boolean,
  createdOffsetSec = 0,
): Scripted => ({
  appearsAtSec,
  entry: {
    id,
    minor,
    // Written at the moment it appears, unless the case says otherwise.
    created_at: clock.iso((appearsAtSec + createdOffsetSec) * 1000),
  },
});

/**
 * Runs the loop over a script of entries, each drained once its time has
 * come, with a 1s poll so delivery times are exact to the second.
 */
async function run(
  script: (clock: ReturnType<typeof virtualClock>) => Scripted[],
  opts: {
    forever?: boolean;
    timeoutSec?: number;
    batching?: { debounceSec: number; deferSec: number } | null;
  } = {},
) {
  const clock = virtualClock();
  const entries = script(clock);
  const startMs = clock.now();
  let next = 0;
  const batches: { atSec: number; ids: string[]; cursor?: string }[] = [];
  const quiet: { atSec: number; cursor?: string; held: number }[] = [];
  let emptyCursor: string | undefined;
  const code = await runWatchLoop<Entry>({
    poll: false,
    forever: opts.forever ?? true,
    timeoutSec: opts.timeoutSec ?? 600,
    intervalSec: 1,
    batching:
      opts.batching === null
        ? undefined
        : {
            ...(opts.batching ?? { debounceSec: 15, deferSec: 300 }),
            isMinor: (item) => item.minor,
          },
    baseline: "c0",
    clock,
    drain: async () => {
      const items: Entry[] = [];
      while (
        next < entries.length &&
        (entries[next] as Scripted).appearsAtSec * 1000 <= clock.now() - startMs
      ) {
        items.push((entries[next] as Scripted).entry);
        next += 1;
      }
      return { items, cursor: `c${next}` };
    },
    onItems: (items, cursor) =>
      batches.push({
        atSec: clock.elapsed() / 1000,
        ids: items.map((item) => item.id),
        cursor,
      }),
    onEmpty: (cursor) => {
      emptyCursor = cursor;
    },
    onQuiet: (cursor, _totalMs, held) =>
      quiet.push({ atSec: clock.elapsed() / 1000, cursor, held }),
  });
  return { code, batches, quiet, emptyCursor };
}

describe("runWatchLoop: two tiers (T-694)", () => {
  it("holds a lone reference for the defer window under --forever", async () => {
    const { code, batches } = await run((clock) => [at(clock, 0, "ref", true)]);
    expect(code).toBe(0);
    expect(batches).toEqual([{ atSec: 300, ids: ["ref"], cursor: "c1" }]);
  });

  it("returns a held reference with exit 0 at a one-shot deadline", async () => {
    const { code, batches } = await run(
      (clock) => [at(clock, 0, "ref", true)],
      { forever: false, timeoutSec: 60 },
    );
    expect(code).toBe(0);
    expect(batches).toEqual([{ atSec: 60, ids: ["ref"], cursor: "c1" }]);
  });

  it("still exits 3 at a one-shot deadline with nothing held", async () => {
    const { code, batches, emptyCursor } = await run(() => [], {
      forever: false,
      timeoutSec: 60,
    });
    expect(code).toBe(3);
    expect(batches).toEqual([]);
    expect(emptyCursor).toBe("c0");
  });

  it("lets an urgent entry held at a one-shot deadline finish its window", async () => {
    const { code, batches } = await run(
      (clock) => [at(clock, 55, "comment", false)],
      { forever: false, timeoutSec: 60 },
    );
    expect(code).toBe(0);
    expect(batches).toEqual([{ atSec: 70, ids: ["comment"], cursor: "c1" }]);
  });

  it("sends a held reference along with the next comment", async () => {
    const { batches } = await run((clock) => [
      at(clock, 0, "ref", true),
      at(clock, 120, "comment", false),
    ]);
    expect(batches).toEqual([
      { atSec: 135, ids: ["ref", "comment"], cursor: "c2" },
    ]);
  });

  it("never pushes an urgent batch back for a reference that lands in it", async () => {
    const { batches } = await run((clock) => [
      at(clock, 0, "comment", false),
      at(clock, 5, "ref", true),
    ]);
    expect(batches).toEqual([
      { atSec: 15, ids: ["comment", "ref"], cursor: "c2" },
    ]);
  });

  it("returns a replayed reference at once", async () => {
    const { batches } = await run((clock) => [
      at(clock, 0, "ref", true, -3600),
    ]);
    expect(batches).toEqual([{ atSec: 0, ids: ["ref"], cursor: "c1" }]);
  });

  it("delivers a reference at once with --defer 0", async () => {
    const { batches } = await run((clock) => [at(clock, 0, "ref", true)], {
      batching: { debounceSec: 15, deferSec: 0 },
    });
    expect(batches).toEqual([{ atSec: 0, ids: ["ref"], cursor: "c1" }]);
  });

  it("delivers anything at once with both windows at 0", async () => {
    const { batches } = await run((clock) => [at(clock, 3, "comment", false)], {
      batching: { debounceSec: 0, deferSec: 0 },
    });
    expect(batches).toEqual([{ atSec: 3, ids: ["comment"], cursor: "c1" }]);
  });

  it("delivers anything at once without batching, as question wait asks", async () => {
    const { batches } = await run((clock) => [at(clock, 3, "ref", true)], {
      batching: null,
    });
    expect(batches).toEqual([{ atSec: 3, ids: ["ref"], cursor: "c1" }]);
  });

  it("heartbeats with the held count and a cursor short of what is held", async () => {
    const { quiet, batches } = await run(
      (clock) => [at(clock, 0, "ref", true)],
      { timeoutSec: 100 },
    );
    // The cursor a restart would resume from must replay the reference: a
    // fatal exit does not flush what is held.
    expect(quiet).toEqual([
      { atSec: 100, cursor: "c0", held: 1 },
      { atSec: 200, cursor: "c0", held: 1 },
    ]);
    expect(batches).toEqual([{ atSec: 300, ids: ["ref"], cursor: "c1" }]);
  });

  it("heartbeats with the current cursor when nothing is held", async () => {
    const { quiet } = await run((clock) => [at(clock, 250, "comment", false)], {
      timeoutSec: 100,
    });
    expect(quiet).toEqual([
      { atSec: 100, cursor: "c0", held: 0 },
      { atSec: 200, cursor: "c0", held: 0 },
    ]);
  });
});

describe("quietNote", () => {
  it("reads as before when nothing is held", () => {
    expect(quietNote("still watching", 600, 4_200_000)).toBe(
      "still watching — nothing new in 600s (1h10m total)",
    );
    expect(quietNote("still watching", 600, 4_200_000, 0)).toBe(
      "still watching — nothing new in 600s (1h10m total)",
    );
  });

  it("counts held minor entries", () => {
    expect(quietNote("still watching", 600, 4_200_000, 1)).toBe(
      "still watching — nothing new in 600s (1h10m total; 1 minor entry held)",
    );
    expect(quietNote("still watching", 600, 4_200_000, 2)).toBe(
      "still watching — nothing new in 600s (1h10m total; 2 minor entries held)",
    );
  });
});
