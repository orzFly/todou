import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadTomlConfig } from "@todou/shared/config";
import { stringify } from "smol-toml";
import { z } from "zod";

export const Binding = z.object({
  /** git remote URL of the repository this binding applies to. */
  remote: z.string(),
  server: z.string(),
  project: z.string(),
});
export type Binding = z.infer<typeof Binding>;

export const ServerEntry = z.object({
  /** Default identity; optional so a server may hold only named profiles. */
  token: z.string().optional(),
  /** Named token profiles, e.g. tokens."claude-code". */
  tokens: z.record(z.string(), z.string()).default({}),
});
export type ServerEntry = z.infer<typeof ServerEntry>;

export const CliConfig = z.object({
  default_server: z.string().optional(),
  servers: z.record(z.string(), ServerEntry).default({}),
  bindings: z.array(Binding).default([]),
});
export type CliConfig = z.infer<typeof CliConfig>;

export type Env = Record<string, string | undefined>;

export function configPath(env: Env = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "todou", "config.toml");
}

export function loadCliConfig(env: Env = process.env): CliConfig {
  return loadTomlConfig({
    schema: CliConfig,
    path: configPath(env),
    optional: true,
  });
}

/** Tokens live here, so the directory is 0700 and the file 0600. */
export function saveCliConfig(config: CliConfig, env: Env = process.env): void {
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Round-trip through JSON to drop undefined optionals smol-toml rejects.
  const doc = JSON.parse(JSON.stringify(config)) as {
    servers?: Record<string, { tokens?: Record<string, string> }>;
  } & Record<string, unknown>;
  // Empty profile tables would render as noisy empty [servers.X.tokens]
  // sections; the schema defaults them back on load.
  for (const entry of Object.values(doc.servers ?? {})) {
    if (entry.tokens && Object.keys(entry.tokens).length === 0) {
      delete entry.tokens;
    }
  }
  writeFileSync(path, `${stringify(doc)}\n`, { mode: 0o600 });
  // writeFileSync applies mode only on create; tighten pre-existing files too.
  chmodSync(path, 0o600);
}

/** Origins are dictionary keys; a trailing slash would silently fork entries. */
export function normalizeServer(origin: string): string {
  return origin.replace(/\/+$/, "");
}
