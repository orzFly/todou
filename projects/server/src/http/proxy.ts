import { BlockList, isIP } from "node:net";
import { ConfigError } from "@todou/shared/config";
import type { Config } from "../config.ts";

/**
 * The single source of proxy trust: forwarded headers (X-Forwarded-Proto,
 * X-Forwarded-Host, and the forward-mode identity header) are only believed
 * when the TCP peer matches http.trusted_proxies.
 */
export type TrustedPeerCheck = ((addr: string) => boolean) & {
  /** node BlockList's rules — what the matcher holds, not a config echo.
   *  Sorted lexicographically: node's own order is undocumented and groups
   *  by kind/family, so it must not leak into output or tests. */
  readonly rules: readonly string[];
};

export function compileTrustedProxies(entries: string[]): TrustedPeerCheck {
  const list = new BlockList();
  for (const entry of entries) {
    const [addr, prefix, ...rest] = entry.split("/");
    const family = familyOf(addr ?? "");
    if (!addr || family === null || rest.length > 0) {
      throw new ConfigError(
        `http.trusted_proxies: "${entry}" is not an IP address or CIDR block`,
      );
    }
    if (prefix === undefined) {
      list.addAddress(addr, family);
    } else {
      const bits = Number(prefix);
      const max = family === "ipv4" ? 32 : 128;
      if (!/^\d+$/.test(prefix) || !Number.isInteger(bits) || bits > max) {
        throw new ConfigError(
          `http.trusted_proxies: "${entry}" has an invalid prefix length`,
        );
      }
      list.addSubnet(addr, bits, family);
    }
  }
  const check = (addr: string) => {
    const normalized = normalizeMapped(addr);
    const family = familyOf(normalized);
    return family !== null && list.check(normalized, family);
  };
  return Object.assign(check, { rules: [...list.rules].sort() });
}

/**
 * The one-line answer to "did my trusted_proxies actually compile", printed
 * once at startup before anything else can fail. Pure so the wording is
 * unit-testable; the caller owns the printing.
 */
export function describeTrustedProxies(config: Config): string {
  const rules = config.isTrustedPeer.rules;
  if (rules.length === 0) {
    return "http.trusted_proxies compiled to: (nothing — no peer can ever be trusted)";
  }
  return `http.trusted_proxies compiled to: ${rules.join(" | ")}`;
}

function familyOf(addr: string): "ipv4" | "ipv6" | null {
  const version = isIP(addr);
  return version === 4 ? "ipv4" : version === 6 ? "ipv6" : null;
}

/** node reports IPv4 peers of dual-stack sockets as "::ffff:1.2.3.4". */
function normalizeMapped(addr: string): string {
  const lower = addr.toLowerCase();
  if (
    lower.startsWith("::ffff:") &&
    isIP(lower.slice("::ffff:".length)) === 4
  ) {
    return lower.slice("::ffff:".length);
  }
  return addr;
}

/**
 * Structural slice of a Hono context — narrow on purpose so unit tests can
 * pass plain objects and non-node adapters degrade to "no peer address".
 */
export type RequestLike = {
  req: { header: (name: string) => string | undefined; url: string };
  env: unknown;
};

export function remoteAddrOf(c: RequestLike): string | null {
  const env = c.env as
    | { incoming?: { socket?: { remoteAddress?: unknown } } }
    | undefined;
  const addr = env?.incoming?.socket?.remoteAddress;
  return typeof addr === "string" && addr !== "" ? addr : null;
}

/**
 * Why a request is not trusted. `addr` is for server logs only — returning
 * it in a response hands an address that may belong to another reverse
 * proxy to anyone who can reach the backend port (T-333).
 */
export type PeerTrust =
  | { trusted: true; addr: string }
  | { trusted: false; reason: "no-peer" }
  | { trusted: false; reason: "not-listed"; addr: string };

export function peerTrust(c: RequestLike, config: Config): PeerTrust {
  const addr = remoteAddrOf(c);
  if (addr === null) return { trusted: false, reason: "no-peer" };
  return config.isTrustedPeer(addr)
    ? { trusted: true, addr }
    : { trusted: false, reason: "not-listed", addr };
}

export function isTrustedRequest(c: RequestLike, config: Config): boolean {
  return peerTrust(c, config).trusted;
}

/** Chained proxies append to X-Forwarded-*; the first token is the origin-facing value. */
function firstToken(value: string): string {
  return (value.split(",")[0] ?? "").trim();
}

export function requestProto(c: RequestLike, config: Config): "http" | "https" {
  if (isTrustedRequest(c, config)) {
    const forwarded = c.req.header("x-forwarded-proto");
    if (forwarded !== undefined && firstToken(forwarded) === "https") {
      return "https";
    }
  }
  // The server itself only speaks plain HTTP; TLS always terminates upstream.
  return "http";
}

/**
 * The origin the client is talking to, for building absolute URLs (the oidc
 * redirect_uri). Explicit http.public_origin wins; otherwise derived from
 * the request, believing X-Forwarded-Host only from a trusted peer.
 */
export function requestOrigin(c: RequestLike, config: Config): string {
  if (config.http.public_origin !== undefined) {
    return config.http.public_origin;
  }
  const forwardedHost = isTrustedRequest(c, config)
    ? c.req.header("x-forwarded-host")
    : undefined;
  const host =
    (forwardedHost !== undefined ? firstToken(forwardedHost) : undefined) ??
    c.req.header("host") ??
    // Synthetic requests (tests, non-node adapters) carry the host only in
    // the URL.
    new URL(c.req.url).host;
  return `${requestProto(c, config)}://${host}`;
}
