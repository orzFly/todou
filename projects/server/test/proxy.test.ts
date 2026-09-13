import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import {
  compileTrustedProxies,
  describeTrustedProxies,
  peerTrust,
  remoteAddrOf,
  requestOrigin,
  requestProto,
} from "../src/http/proxy.ts";

function fakeRequest(options: {
  remoteAddress?: string;
  headers?: Record<string, string>;
}) {
  const headers = new Map(
    Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    req: {
      header: (name: string) => headers.get(name.toLowerCase()),
      url: "http://fallback.example/api/x",
    },
    env:
      options.remoteAddress === undefined
        ? {}
        : { incoming: { socket: { remoteAddress: options.remoteAddress } } },
  };
}

function configWith(toml: string) {
  return loadConfig({ tomlSource: toml, env: {} });
}

describe("peerTrust", () => {
  const config = configWith("");

  it("reports the address when the peer is trusted", () => {
    // 证伪: trusted branch without addr → red.
    expect(
      peerTrust(fakeRequest({ remoteAddress: "127.0.0.1" }), config),
    ).toEqual({
      trusted: true,
      addr: "127.0.0.1",
    });
  });

  it("reports not-listed with the address for a peer off the list", () => {
    // 证伪: merging both untrusted reasons into one → red. This is the
    // flattening this card exists to undo.
    expect(
      peerTrust(fakeRequest({ remoteAddress: "10.9.9.9" }), config),
    ).toEqual({
      trusted: false,
      reason: "not-listed",
      addr: "10.9.9.9",
    });
  });

  it("reports no-peer when the adapter has no socket address", () => {
    // 证伪: routing null remoteAddrOf through not-listed → red.
    expect(peerTrust(fakeRequest({}), config)).toEqual({
      trusted: false,
      reason: "no-peer",
    });
  });
});

describe("compileTrustedProxies rules", () => {
  it("exposes sorted, node-formatted rules — not a config echo", () => {
    // 证伪: echoing the input array → red (no Address:/Subnet: prefixes,
    // different order). With only the default list an echo would pass,
    // because the defaults happen to look like CIDRs.
    expect(compileTrustedProxies(["10.0.0.0/8", "192.168.1.5"]).rules).toEqual([
      "Address: IPv4 192.168.1.5",
      "Subnet: IPv4 10.0.0.0/8",
    ]);
  });

  it("sorts the default list deterministically", () => {
    // 证伪: dropping .sort() → red. node (v20 and v24 alike) emits the
    // IPv6 entry first here, so this distinguishes sorted from raw. Note
    // 127.0.0.1/32 carries a prefix length, so node files it under Subnet.
    expect(compileTrustedProxies(["127.0.0.1/32", "::1/128"]).rules).toEqual([
      "Subnet: IPv4 127.0.0.1/32",
      "Subnet: IPv6 ::1/128",
    ]);
  });
});

describe("describeTrustedProxies", () => {
  it("renders the compiled rules, not the configuration", () => {
    // 证伪: joining config.http.trusted_proxies instead of .rules → red.
    // toBe, not toContain: a half-built line must not pass.
    expect(
      describeTrustedProxies(
        configWith('[http]\ntrusted_proxies = ["10.0.0.0/8", "192.168.1.5"]'),
      ),
    ).toBe(
      "http.trusted_proxies compiled to: Address: IPv4 192.168.1.5 | Subnet: IPv4 10.0.0.0/8",
    );
  });

  it("says outright that an empty list trusts nobody", () => {
    // 证伪: joining an empty rules array without the special case → red
    // (a sentence ending in ": "). This is the legal config that 401s
    // every forward-mode request.
    expect(
      describeTrustedProxies(configWith("[http]\ntrusted_proxies = []")),
    ).toBe(
      "http.trusted_proxies compiled to: (nothing — no peer can ever be trusted)",
    );
  });
});

describe("compileTrustedProxies", () => {
  it("matches bare addresses and CIDR blocks per family", () => {
    const check = compileTrustedProxies([
      "192.168.1.5",
      "10.0.0.0/8",
      "fd00::/8",
      "::1/128",
    ]);
    expect(check("192.168.1.5")).toBe(true);
    expect(check("192.168.1.6")).toBe(false);
    expect(check("10.255.0.1")).toBe(true);
    expect(check("11.0.0.1")).toBe(false);
    expect(check("fd12::1")).toBe(true);
    expect(check("::1")).toBe(true);
    expect(check("2001:db8::1")).toBe(false);
  });

  it("normalises IPv4-mapped IPv6 peers before matching", () => {
    const check = compileTrustedProxies(["127.0.0.1/32"]);
    expect(check("::ffff:127.0.0.1")).toBe(true);
    expect(check("::FFFF:127.0.0.1")).toBe(true);
    expect(check("::ffff:10.0.0.1")).toBe(false);
  });

  it("never matches garbage peer addresses", () => {
    const check = compileTrustedProxies(["10.0.0.0/8"]);
    expect(check("")).toBe(false);
    expect(check("not-an-ip")).toBe(false);
  });
});

describe("remoteAddrOf", () => {
  it("digs the node socket address out of the adapter env", () => {
    expect(remoteAddrOf(fakeRequest({ remoteAddress: "10.1.2.3" }))).toBe(
      "10.1.2.3",
    );
  });

  it("degrades to null without a node socket (tests, other adapters)", () => {
    expect(remoteAddrOf(fakeRequest({}))).toBeNull();
    expect(
      remoteAddrOf({
        req: { header: () => undefined, url: "http://x.example/" },
        env: undefined,
      }),
    ).toBeNull();
  });
});

describe("requestProto", () => {
  const config = configWith("");

  it("believes X-Forwarded-Proto only from a trusted peer", () => {
    const trusted = fakeRequest({
      remoteAddress: "127.0.0.1",
      headers: { "X-Forwarded-Proto": "https" },
    });
    expect(requestProto(trusted, config)).toBe("https");

    const untrusted = fakeRequest({
      remoteAddress: "10.9.9.9",
      headers: { "X-Forwarded-Proto": "https" },
    });
    expect(requestProto(untrusted, config)).toBe("http");
  });

  it("takes the first token of a chained header and defaults to http", () => {
    const chained = fakeRequest({
      remoteAddress: "127.0.0.1",
      headers: { "X-Forwarded-Proto": "https, http" },
    });
    expect(requestProto(chained, config)).toBe("https");
    expect(
      requestProto(fakeRequest({ remoteAddress: "127.0.0.1" }), config),
    ).toBe("http");
  });
});

describe("requestOrigin", () => {
  it("prefers a configured public_origin over everything", () => {
    const config = configWith(
      '[http]\npublic_origin = "https://todou.example"',
    );
    const c = fakeRequest({
      remoteAddress: "127.0.0.1",
      headers: { Host: "internal:8637", "X-Forwarded-Host": "evil.example" },
    });
    expect(requestOrigin(c, config)).toBe("https://todou.example");
  });

  it("derives from forwarded headers when the peer is trusted", () => {
    const config = configWith("");
    const c = fakeRequest({
      remoteAddress: "127.0.0.1",
      headers: {
        Host: "internal:8637",
        "X-Forwarded-Host": "todou.example",
        "X-Forwarded-Proto": "https",
      },
    });
    expect(requestOrigin(c, config)).toBe("https://todou.example");
  });

  it("falls back to the Host header for direct or untrusted peers", () => {
    const config = configWith("");
    const untrusted = fakeRequest({
      remoteAddress: "10.9.9.9",
      headers: { Host: "internal:8637", "X-Forwarded-Host": "evil.example" },
    });
    expect(requestOrigin(untrusted, config)).toBe("http://internal:8637");
  });

  it("falls back to the request URL host when no Host header exists", () => {
    const config = configWith("");
    expect(requestOrigin(fakeRequest({}), config)).toBe(
      "http://fallback.example",
    );
  });
});
