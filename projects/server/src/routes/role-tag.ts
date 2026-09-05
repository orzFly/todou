import { type CapabilityId, minRoleOf } from "@todou/shared";

/**
 * The `(role)` an endpoint summary ends with, taken from the capability
 * catalog rather than typed into the prose — a summary that spells its own
 * role goes stale the moment the gate moves, and nothing catches it.
 *
 * Summaries that say more than the role interpolate `minRoleOf` directly.
 */
export function roleTag(cap: CapabilityId): string {
  return `(${minRoleOf(cap)})`;
}
