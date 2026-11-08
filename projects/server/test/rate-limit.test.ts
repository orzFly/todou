import { describe, expect, it } from "vitest";
import { SlidingWindowLimiter } from "../src/http/rate-limit.ts";

describe("SlidingWindowLimiter", () => {
  it("lets a key back in as its oldest hit leaves the window", () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter(2, 60_000, () => now);
    expect(limiter.take("a")).toBe(0);
    now = 10_000;
    expect(limiter.take("a")).toBe(0);
    now = 20_000;
    expect(limiter.take("a")).toBe(40);
    expect(limiter.take("b")).toBe(0);

    now = 60_001;
    expect(limiter.take("a")).toBe(0);
    // The refused attempt counted for nothing; the hit at 10s still does.
    expect(limiter.take("a")).toBe(10);
  });
});
