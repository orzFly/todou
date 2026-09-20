export type ResourceQuery = Record<
  string,
  string | number | boolean | Array<string | number> | undefined
>;

export const RESOURCE_POLICIES = {
  projects: { freshnessMs: 60_000, path: /^\/projects$/ },
  project: { freshnessMs: 60_000, path: /^\/projects\/[^/]+$/ },
  statuses: { freshnessMs: 60_000, path: /^\/projects\/[^/]+\/statuses$/ },
  labels: { freshnessMs: 60_000, path: /^\/projects\/[^/]+\/labels$/ },
  members: { freshnessMs: 60_000, path: /^\/projects\/[^/]+\/members$/ },
  inbox: { freshnessMs: 5_000, path: /^\/me\/inbox$/ },
  prefs: { freshnessMs: 60_000, path: /^\/me\/prefs$/ },
  issue: { freshnessMs: 5_000, path: /^\/projects\/[^/]+\/issues\/\d+$/ },
  issues: { freshnessMs: 5_000, path: /^\/projects\/[^/]+\/issues$/ },
  "issue-counts": {
    freshnessMs: 5_000,
    path: /^\/projects\/[^/]+\/issues\/counts$/,
  },
  questions: {
    freshnessMs: 5_000,
    path: /^\/projects\/[^/]+\/issues\/\d+\/questions$/,
  },
  attachments: { freshnessMs: 5_000, path: /^\/projects\/[^/]+\/attachments$/ },
  spec: { freshnessMs: 5_000, path: /^\/projects\/[^/]+\/issues\/\d+\/spec$/ },
  "spec-files": {
    freshnessMs: 5_000,
    path: /^\/projects\/[^/]+\/issues\/\d+\/spec\/files$/,
  },
  "spec-files-version": {
    freshnessMs: Number.POSITIVE_INFINITY,
    path: /^\/projects\/[^/]+\/issues\/\d+\/spec\/files$/,
  },
  timeline: {
    freshnessMs: 5_000,
    path: /^\/projects\/[^/]+\/issues\/\d+\/timeline$/,
  },
  "network-only": { freshnessMs: 0, path: /^\// },
  "no-store": { freshnessMs: 0, path: /^\// },
} as const;
export type ResourcePolicyId = keyof typeof RESOURCE_POLICIES;
export interface ResourceDescriptor {
  apiMount: string;
  path: string;
  query?: ResourceQuery;
  representation: "json";
  policyId: ResourcePolicyId;
  policyVersion: 1;
}
export interface ResourcePolicy {
  freshnessMs: number;
  cacheable: boolean;
  retryOwner: "runtime" | "page";
  retries: number;
  deadlineMs: number;
  maxPayloadBytes: number;
}
export type InvalidationTarget =
  | { type: "user" }
  | { type: "project"; slug?: string; id?: string | number }
  | { type: "issue"; slug: string; number: number }
  | { type: "read"; slug?: string; number?: number }
  | { type: "projection"; projectionHash: string }
  | { type: "key-prefix"; queryKey: readonly unknown[] }
  | { type: "resource"; resource: ResourceDescriptor };

export function canonical(value: unknown): string {
  const seen = new Set<object>();
  const normalize = (item: unknown): unknown => {
    if (item === undefined) return null;
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object")
      throw new TypeError("Descriptor must contain JSON values");
    if (seen.has(item)) throw new TypeError("Cyclic descriptor");
    seen.add(item);
    let result: unknown;
    if (Array.isArray(item)) result = item.map(normalize);
    else {
      if (
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null
      ) {
        throw new TypeError("Descriptor must contain plain objects");
      }
      result = Object.fromEntries(
        Object.keys(item)
          .sort()
          .filter((key) => (item as Record<string, unknown>)[key] !== undefined)
          .map((key) => [
            key,
            normalize((item as Record<string, unknown>)[key]),
          ]),
      );
    }
    seen.delete(item);
    return result;
  };
  return JSON.stringify(normalize(value));
}

function hasUnsafePathCharacter(value: string): boolean {
  return (
    /[\\?#]/.test(value) ||
    [...value].some((character) => character.charCodeAt(0) <= 32)
  );
}

export function validApiPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    hasUnsafePathCharacter(value)
  )
    return false;
  try {
    return !decodeURIComponent(value)
      .split("/")
      .some(
        (part) => part === "." || part === ".." || hasUnsafePathCharacter(part),
      );
  } catch {
    return false;
  }
}

export function validateResource(
  value: unknown,
): asserts value is ResourceDescriptor {
  if (!value || typeof value !== "object")
    throw new TypeError("Invalid resource descriptor");
  const input = value as ResourceDescriptor;
  if (
    !validApiPath(input.apiMount) ||
    !validApiPath(input.path) ||
    input.representation !== "json" ||
    input.policyVersion !== 1 ||
    !Object.hasOwn(RESOURCE_POLICIES, input.policyId)
  )
    throw new TypeError("Unknown resource policy or invalid descriptor");
  if (input.query !== undefined) {
    if (
      !input.query ||
      typeof input.query !== "object" ||
      Array.isArray(input.query)
    )
      throw new TypeError("Invalid resource query");
    for (const entry of Object.values(input.query)) {
      const scalar = (item: unknown) =>
        typeof item === "string" ||
        (typeof item === "number" && Number.isFinite(item));
      if (
        entry !== undefined &&
        typeof entry !== "boolean" &&
        !scalar(entry) &&
        !(Array.isArray(entry) && entry.every(scalar))
      )
        throw new TypeError("Invalid resource query value");
    }
  }
  if (!RESOURCE_POLICIES[input.policyId].path.test(input.path))
    throw new TypeError("Resource path does not match policy");
  if (
    input.policyId === "spec-files-version" &&
    !(
      typeof input.query?.version === "number" &&
      Number.isSafeInteger(input.query.version) &&
      input.query.version > 0
    )
  )
    throw new TypeError("Immutable spec requires a fixed version");
  if (input.policyId === "spec-files" && input.query?.version !== undefined)
    throw new TypeError("Versioned spec requires immutable policy");
  if (
    input.policyId === "attachments" &&
    !(
      typeof input.query?.issue_number === "number" &&
      Number.isSafeInteger(input.query.issue_number) &&
      input.query.issue_number > 0
    )
  )
    throw new TypeError("Attachments require an issue number");
  if (canonical(input).length > 65_536)
    throw new TypeError("Resource descriptor too large");
}

export function resource(
  policyId: ResourcePolicyId,
  path: string,
  query?: ResourceQuery,
  apiMount = "/api",
): ResourceDescriptor {
  const result: ResourceDescriptor = {
    apiMount,
    path,
    query,
    representation: "json",
    policyId,
    policyVersion: 1,
  };
  validateResource(result);
  return result;
}
export function networkResource(
  path: string,
  query?: ResourceQuery,
  apiMount = "/api",
): ResourceDescriptor {
  return resource("network-only", path, query, apiMount);
}
export function policyFor(descriptor: ResourceDescriptor): ResourcePolicy {
  validateResource(descriptor);
  const cacheable =
    descriptor.policyId !== "network-only" &&
    descriptor.policyId !== "no-store";
  return {
    freshnessMs: RESOURCE_POLICIES[descriptor.policyId].freshnessMs,
    cacheable,
    retryOwner: cacheable ? "runtime" : "page",
    retries: cacheable ? 2 : 0,
    deadlineMs: 30_000,
    maxPayloadBytes: 2 * 1024 * 1024,
  };
}
export function resourceId(
  descriptor: ResourceDescriptor,
  accountEpoch = 0,
): string {
  validateResource(descriptor);
  return canonical([accountEpoch, descriptor]);
}
export function resourceScope(descriptor: ResourceDescriptor): {
  slug?: string;
  issueNumber?: number;
} {
  const match = /^\/projects\/([^/]+)(?:\/issues\/(\d+))?/.exec(
    descriptor.path,
  );
  return {
    slug: match?.[1] ? decodeURIComponent(match[1]) : undefined,
    issueNumber: match?.[2]
      ? Number(match[2])
      : descriptor.policyId === "attachments"
        ? Number(descriptor.query?.issue_number)
        : undefined,
  };
}
export function keyStartsWith(
  key: readonly unknown[],
  prefix: readonly unknown[],
): boolean {
  return (
    prefix.length <= key.length &&
    prefix.every((part, index) => canonical(part) === canonical(key[index]))
  );
}
