import { describe, expect, it } from "vitest";
import { rateLimitKey, SlidingWindowLimiter } from "../src/http/rate-limit.ts";

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

  it("sweeps idle keys at most once a window", () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter(1, 60_000, () => now);
    const size = () =>
      (limiter as unknown as { hits: Map<string, number[]> }).hits.size;
    for (let i = 0; i < 1001; i++) limiter.take(`a${i}`);
    now = 1;
    // The first of these sweeps (nothing is idle yet); the rest must not.
    for (let i = 0; i < 1001; i++) limiter.take(`b${i}`);
    now = 60_000;
    // Every a-key is idle now, but the last sweep was under a window ago.
    limiter.take("c");
    expect(size()).toBe(2003);
    now = 60_002;
    limiter.take("d");
    expect(size()).toBe(2);
  });
});

describe("rateLimitKey", () => {
  it("keeps IPv4 whole and folds IPv6 to its /64", () => {
    expect(rateLimitKey("203.0.113.7")).toBe("203.0.113.7");
    expect(rateLimitKey("2001:db8:0:7::1")).toBe("2001:db8:0:7::/64");
    expect(rateLimitKey("2001:0DB8:0000:0007:ffff:1:2:3")).toBe(
      "2001:db8:0:7::/64",
    );
    expect(rateLimitKey("2001:db8::7:1:2:3:4")).toBe("2001:db8:0:7::/64");
    expect(rateLimitKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(rateLimitKey("::1")).toBe("0:0:0:0::/64");
  });
});
