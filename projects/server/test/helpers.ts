import { type Config, loadConfig } from "../src/config.ts";
import { DbRouter } from "../src/db/router.ts";

export type PlacementMode = "shared" | "dedicated" | "dedicated-bucketed";

export const PLACEMENTS: PlacementMode[] = [
  "shared",
  "dedicated",
  "dedicated-bucketed",
];

let instance = 0;

/**
 * In-memory config for one test suite. Each call gets distinct pglite
 * memory URLs so suites never share state. "dedicated-bucketed" exercises
 * a user-written ${} expression that maps several projects onto one target.
 */
export function testConfig(
  placement: PlacementMode = "shared",
  overrides?: { maxOpen?: number; urlTemplate?: string },
): Config {
  const run = `r${instance++}`;
  const lines = [
    "[database]",
    `system = "pglite://memory/${run}-system"`,
    "[database.projects]",
  ];
  if (placement === "shared") {
    lines.push('placement = "shared"');
  } else {
    const template =
      overrides?.urlTemplate ??
      (placement === "dedicated"
        ? `pglite://memory/${run}-p\${project.id}`
        : `pglite://memory/${run}-b\${project.id % 2}`);
    lines.push('placement = "dedicated"');
    lines.push(`url_template = '${template}'`);
  }
  if (overrides?.maxOpen) {
    lines.push(`max_open = ${overrides.maxOpen}`);
  }
  return loadConfig({ tomlSource: lines.join("\n"), env: {} });
}

export async function makeRouter(
  placement: PlacementMode = "shared",
  overrides?: { maxOpen?: number; urlTemplate?: string },
): Promise<{ config: Config; router: DbRouter }> {
  const config = testConfig(placement, overrides);
  const router = await DbRouter.open(config);
  return { config, router };
}
