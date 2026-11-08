import type { Config } from "../config.ts";

/**
 * Who may sign in at all, decided from what the IdP or proxy asserts about
 * an identity. Every setting left empty admits everyone: the gate exists for
 * deployments whose IdP admits more people than the instance should, and
 * leaving it open is a documented choice, not an oversight.
 */
export type AdmissionPolicy = {
  requireEmailVerified: boolean;
  /** Lowercase, no leading "@". */
  allowedEmailDomains: readonly string[];
  allowedGroups: readonly string[];
};

export type AdmissionFacts = {
  email: unknown;
  emailVerified?: unknown;
  groups: unknown;
};

export function oidcAdmissionPolicy(config: Config): AdmissionPolicy {
  const cfg = config.auth.oidc;
  return {
    requireEmailVerified: cfg.require_email_verified,
    allowedEmailDomains: cfg.allowed_email_domains,
    allowedGroups: cfg.allowed_groups,
  };
}

export function forwardAdmissionPolicy(config: Config): AdmissionPolicy {
  const cfg = config.auth.forward;
  return {
    requireEmailVerified: false,
    allowedEmailDomains: cfg.allowed_email_domains,
    allowedGroups: cfg.allowed_groups,
  };
}

export function admissionActive(policy: AdmissionPolicy): boolean {
  return (
    policy.requireEmailVerified ||
    policy.allowedEmailDomains.length > 0 ||
    policy.allowedGroups.length > 0
  );
}

/** Why the identity is refused, for the server log; null admits it. */
export function admissionRefusal(
  policy: AdmissionPolicy,
  facts: AdmissionFacts,
): string | null {
  // Some IdPs (Cognito's userinfo among them) send the flag as a string.
  if (
    policy.requireEmailVerified &&
    facts.emailVerified !== true &&
    facts.emailVerified !== "true"
  ) {
    return "email is not verified";
  }
  if (policy.allowedEmailDomains.length > 0) {
    const email = typeof facts.email === "string" ? facts.email : "";
    const at = email.lastIndexOf("@");
    const domain = at < 0 ? "" : email.slice(at + 1).toLowerCase();
    // Exact match only: a subdomain is a different administrative domain.
    if (!policy.allowedEmailDomains.includes(domain)) {
      return `email ${JSON.stringify(email)} is outside allowed_email_domains`;
    }
  }
  if (policy.allowedGroups.length > 0) {
    const groups = groupList(facts.groups);
    if (!groups.some((group) => policy.allowedGroups.includes(group))) {
      return `groups ${JSON.stringify(groups)} share none with allowed_groups`;
    }
  }
  return null;
}

/** A claim may carry one group as a bare string; a header carries a
 *  comma-separated list, which is how oauth2-proxy and Authelia send it. */
function groupList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
  }
  return [];
}
