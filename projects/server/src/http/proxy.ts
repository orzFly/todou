import { BlockList, isIP } from "node:net";
import { ConfigError } from "@todou/shared/config";
import type { Config } from "../config.ts";

/**
 * The single source of proxy trust: forwarded headers (X-Forwarded-Proto,
 * X-Forwarded-Host, and the forward-mode identity header) are only believed
 * when the TCP peer matches http.trusted_proxies.
 */
export function compileTrustedProxies(
  entries: string[],
): (addr: string) => boolean {
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
  return (addr) => {
    const normalized = normalizeMapped(addr);
    const family = familyOf(normalized);
    return family !== null && list.check(normalized, family);
  };
}

function familyOf(addr: string): "ipv4" | "ipv6" | null {
  const version = isIP(addr);
  return version === 4 ? "ipv4" : version === 6 ? "ipv6" : null;
}

/** node reports IPv4 peers of dual-stack sockets as "::ffff:1.2.3.4". */
function normalizeMapped(addr: string): string {
  const lower = addr.toLowerCase();
  if (lower.startsWith("::ffff:") && isIP(lower.slice("::ffff:".length)) === 4) {
    return lower.slice("::ffff:".length);
  }
  return addr;
}

/**
 * Structural slice of a Hono context — narrow on purpose so unit tests can
 * pass plain objects and non-node adapters degrade to "no peer address".
 */
export type RequestLike = {
  req: { header: (name: string) => string | undefined };
  env: unknown;
};

export function remoteAddrOf(c: RequestLike): string | null {
  const env = c.env as
    | { incoming?: { socket?: { remoteAddress?: unknown } } }
    | undefined;
  const addr = env?.incoming?.socket?.remoteAddress;
  return typeof addr === "string" && addr !== "" ? addr : null;
}

export function isTrustedRequest(c: RequestLike, config: Config): boolean {
  const addr = remoteAddrOf(c);
  return addr !== null && config.isTrustedPeer(addr);
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
    forwardedHost !== undefined ? firstToken(forwardedHost) : c.req.header("host");
  if (!host) {
    throw new Error(
      "cannot derive the request origin (no Host header); set http.public_origin",
    );
  }
  return `${requestProto(c, config)}://${host}`;
}
