import fs from "node:fs";
import { z } from "zod";
import { modelsCacheReadPath } from "../config/home.js";

export type AnthropicFamily = "opus" | "sonnet" | "haiku";

export const ANTHROPIC_FAMILIES: readonly AnthropicFamily[] = ["opus", "sonnet", "haiku"] as const;

const SUFFIX_BLOCKLIST = [
  "-high",
  "-xhigh",
  "-low",
  "-min",
  "-1m",
  "-internal",
  "-preview",
  "-beta",
  "-experimental",
  "-canary"
];

export interface AnthropicDefaults {
  opus: null | string;
  sonnet: null | string;
  haiku: null | string;
}

const CachedSchema = z.object({
  models: z.array(z.object({ id: z.string() }).passthrough())
});

export function computeAnthropicDefaults(modelIds: readonly string[]): AnthropicDefaults {
  const byFamily: Record<AnthropicFamily, string[]> = { opus: [], sonnet: [], haiku: [] };
  for (const id of modelIds) {
    const family = detectFamily(id);
    if (family) {
      byFamily[family].push(id);
    }
  }
  return {
    opus: pickPlainLatest(byFamily.opus),
    sonnet: pickPlainLatest(byFamily.sonnet),
    haiku: pickPlainLatest(byFamily.haiku)
  };
}

export function readModelIdsFromCache(): string[] {
  const file = modelsCacheReadPath();
  if (!fs.existsSync(file)) {
    return [];
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const parsed = CachedSchema.safeParse(raw);
    if (!parsed.success) {
      return [];
    }
    return parsed.data.models.map((model) => model.id);
  } catch {
    return [];
  }
}

export function buildClaudeExportCommand(input: {
  port: number;
  callerSecret: null | string;
  defaults: AnthropicDefaults;
  enableGatewayDiscovery: boolean;
}): string {
  const token = input.callerSecret ?? "copillm-local";
  const parts: string[] = [
    `ANTHROPIC_BASE_URL=http://127.0.0.1:${input.port}/anthropic`,
    `ANTHROPIC_AUTH_TOKEN=${token}`
  ];
  if (input.defaults.opus) {
    parts.push(`ANTHROPIC_DEFAULT_OPUS_MODEL=${input.defaults.opus}`);
  }
  if (input.defaults.sonnet) {
    parts.push(`ANTHROPIC_DEFAULT_SONNET_MODEL=${input.defaults.sonnet}`);
  }
  if (input.defaults.haiku) {
    parts.push(`ANTHROPIC_DEFAULT_HAIKU_MODEL=${input.defaults.haiku}`);
  }
  if (input.enableGatewayDiscovery) {
    parts.push(`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`);
  }
  parts.push(`claude`);
  return parts.join(" ");
}

function detectFamily(modelId: string): null | AnthropicFamily {
  if (typeof modelId !== "string" || modelId.length === 0) {
    return null;
  }
  const lower = modelId.toLowerCase();
  if (!lower.startsWith("claude")) {
    return null;
  }
  if (lower.includes("opus")) {
    return "opus";
  }
  if (lower.includes("sonnet")) {
    return "sonnet";
  }
  if (lower.includes("haiku")) {
    return "haiku";
  }
  return null;
}

function pickPlainLatest(ids: readonly string[]): null | string {
  if (ids.length === 0) {
    return null;
  }
  const plain = ids.filter((id) => !hasBlockedSuffix(id));
  const candidates = plain.length > 0 ? plain.slice() : ids.slice();
  candidates.sort((a, b) => compareVersionDescending(a, b));
  return candidates[0];
}

function hasBlockedSuffix(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return SUFFIX_BLOCKLIST.some((suffix) => lower.includes(suffix));
}

function compareVersionDescending(a: string, b: string): number {
  const va = parseVersionInfo(a);
  const vb = parseVersionInfo(b);
  const length = Math.max(va.version.length, vb.version.length);
  for (let i = 0; i < length; i += 1) {
    const left = va.version[i] ?? 0;
    const right = vb.version[i] ?? 0;
    if (left !== right) {
      return right - left;
    }
  }
  if (va.date !== vb.date) {
    return vb.date - va.date;
  }
  return b.localeCompare(a);
}

interface VersionInfo {
  version: number[];
  date: number;
}

function parseVersionInfo(modelId: string): VersionInfo {
  let stripped = modelId;
  let date = 0;
  const dateMatch = modelId.match(/-(\d{4})-?(\d{2})-?(\d{2})$/);
  if (dateMatch && typeof dateMatch.index === "number") {
    date = Number.parseInt(`${dateMatch[1]}${dateMatch[2]}${dateMatch[3]}`, 10);
    stripped = modelId.slice(0, dateMatch.index);
  }
  const versionMatches = stripped.match(/(\d+(?:[.\-_]\d+)*)/g);
  if (!versionMatches || versionMatches.length === 0) {
    return { version: [], date };
  }
  const last = versionMatches[versionMatches.length - 1];
  const version = last.split(/[.\-_]/).map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  });
  return { version, date };
}
