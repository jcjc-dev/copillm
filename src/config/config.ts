import fs from "node:fs";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { z } from "zod";
import type { AppConfig } from "../types/index.js";
import { configPath, configReadPath, getCopillmHome } from "./home.js";
import { ensureSecureDirectory, writeFileSecureAtomic } from "./fsSecurity.js";

const ConfigSchema = z.object({
  preferredPort: z.number().int().min(1).max(65535).default(4141),
  requireCallerSecret: z.boolean().default(false),
  selectedModels: z.array(z.string()).default([]),
  accountType: z.enum(["individual", "business", "enterprise"]).default("individual")
});

const DEFAULT_CONFIG: AppConfig = {
  preferredPort: 4141,
  requireCallerSecret: false,
  selectedModels: [],
  accountType: "individual"
};

export function ensureAppHome(): void {
  ensureSecureDirectory(getCopillmHome());
}

export function loadConfig(): AppConfig {
  const file = configReadPath();
  if (!fs.existsSync(file)) {
    saveConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
  const raw = readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (error) {
    throw new Error(`Invalid YAML in config file: ${file}`, { cause: error });
  }
  return parseConfigValue(parsed, file);
}

export function saveConfig(config: AppConfig): void {
  ensureAppHome();
  const normalized = parseConfigValue(config, "runtime");
  writeFileSecureAtomic(configPath(), YAML.stringify(normalized), 0o600);
}

function parseConfigValue(value: unknown, source: string): AppConfig {
  const candidate = value ?? {};
  const result = ConfigSchema.safeParse(candidate);
  if (result.success) {
    return result.data;
  }
  const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
  throw new Error(`Invalid config schema in ${source}: ${issues}`);
}
