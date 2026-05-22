import fs from "node:fs";
import { z } from "zod";
import type { AccountType } from "../types/index.js";
import { modelsCachePath, modelsCacheReadPath } from "../config/home.js";
import { writeFileSecureAtomic } from "../config/fsSecurity.js";
import { copilotBaseUrl } from "../config/upstream.js";

export interface CopilotModel {
  id: string;
  [key: string]: unknown;
}

export interface ModelDiscoveryResult {
  models: CopilotModel[];
  source: "live" | "cache";
  stale: boolean;
  cacheAgeSeconds: null | number;
  warning: null | string;
}

export interface ModelIdResolution {
  input: string;
  resolvedId: string;
  rule: string;
}

const ModelSchema = z
  .object({
    id: z.string().min(1)
  })
  .passthrough();

const ModelsCacheSchema = z.object({
  version: z.literal(1),
  accountType: z.enum(["individual", "business", "enterprise"]),
  savedAtIso: z.string(),
  models: z.array(ModelSchema)
});

const MODEL_RESOLUTION_RULES: ReadonlyArray<{ id: string; normalize: (value: string) => string }> = [
  { id: "exact", normalize: (value) => value },
  { id: "case-insensitive", normalize: (value) => value.toLowerCase() },
  { id: "separator-normalized", normalize: (value) => normalizeModelId(value) },
  { id: "snapshot-trimmed", normalize: (value) => trimDateSnapshot(normalizeModelId(value)) }
];

export function accountBaseUrl(accountType: AccountType): string {
  return copilotBaseUrl(accountType);
}

export async function listModels(accountType: AccountType, bearerToken: string): Promise<ModelDiscoveryResult> {
  try {
    const response = await fetch(`${accountBaseUrl(accountType)}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/json",
        "User-Agent": "copillm/0.1.0"
      }
    });
    if (!response.ok) {
      throw new ModelDiscoveryHttpError(response.status);
    }
    const payload = (await response.json()) as unknown;
    const candidateModels = extractModelArray(payload);
    const parsed = z.array(ModelSchema).safeParse(candidateModels);
    if (!parsed.success) {
      throw new Error("Model discovery response is invalid.");
    }
    saveModelCache(accountType, parsed.data);
    return {
      models: parsed.data,
      source: "live",
      stale: false,
      cacheAgeSeconds: 0,
      warning: null
    };
  } catch (error) {
    if (!canUseCacheFallback(error)) {
      throw error;
    }
    const cached = readModelCache(accountType);
    if (!cached) {
      const detail = error instanceof Error ? error.message : "unknown error";
      throw new Error(`Model discovery failed and no cache snapshot is available: ${detail}`);
    }
    return {
      models: cached.models,
      source: "cache",
      stale: true,
      cacheAgeSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(cached.savedAtIso)) / 1_000)),
      warning: "Using stale model snapshot because upstream discovery is unreachable."
    };
  }
}

export async function listModelsUnion(
  accountType: AccountType,
  bearerToken: string,
  attempts = 3
): Promise<ModelDiscoveryResult> {
  const seen = new Map<string, CopilotModel>();
  let lastResult: ModelDiscoveryResult | null = null;
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const result = await listModels(accountType, bearerToken);
      lastResult = result;
      for (const model of result.models) {
        if (typeof model.id === "string" && !seen.has(model.id)) {
          seen.set(model.id, model);
        }
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (lastResult === null) {
    throw lastError ?? new Error("Model discovery failed across all attempts.");
  }
  return {
    ...lastResult,
    models: Array.from(seen.values())
  };
}

function extractModelArray(payload: unknown): unknown {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const candidate = payload as {
    data?: unknown;
    models?: unknown;
    value?: unknown;
    available_models?: unknown;
  };

  if (Array.isArray(candidate.data)) {
    return candidate.data;
  }
  if (Array.isArray(candidate.models)) {
    return candidate.models;
  }
  if (Array.isArray(candidate.value)) {
    return candidate.value;
  }
  if (Array.isArray(candidate.available_models)) {
    return candidate.available_models;
  }
  if (candidate.data && typeof candidate.data === "object") {
    const nested = candidate.data as { models?: unknown; value?: unknown };
    if (Array.isArray(nested.models)) {
      return nested.models;
    }
    if (Array.isArray(nested.value)) {
      return nested.value;
    }
  }
  return payload;
}

export function resolveModelId(inputModelId: string, availableModelIds: readonly string[]): null | { id: string; rule: string } {
  const direct = availableModelIds.find((id) => id === inputModelId);
  if (direct) {
    return { id: direct, rule: "exact" };
  }

  for (const rule of MODEL_RESOLUTION_RULES.slice(1)) {
    const normalizedInput = rule.normalize(inputModelId);
    const matches = availableModelIds.filter((candidate) => rule.normalize(candidate) === normalizedInput);
    if (matches.length === 1) {
      return { id: matches[0], rule: rule.id };
    }
    if (matches.length > 1) {
      throw new Error(
        `Model "${inputModelId}" is ambiguous under "${rule.id}" rule: ${matches.join(", ")}. Select an exact model id.`
      );
    }
  }
  return null;
}

export function resolveModelSelections(
  requestedModelIds: readonly string[],
  models: readonly CopilotModel[]
): { resolved: ModelIdResolution[]; unresolved: string[] } {
  const availableModelIds = models.map((model) => model.id);
  const resolved: ModelIdResolution[] = [];
  const unresolved: string[] = [];

  for (const input of requestedModelIds) {
    const match = resolveModelId(input, availableModelIds);
    if (!match) {
      unresolved.push(input);
      continue;
    }
    resolved.push({ input, resolvedId: match.id, rule: match.rule });
  }

  return { resolved, unresolved };
}

class ModelDiscoveryHttpError extends Error {
  constructor(public readonly status: number) {
    super(`Model discovery failed (${status}).`);
  }
}

function canUseCacheFallback(error: unknown): boolean {
  if (error instanceof ModelDiscoveryHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  return true;
}

function saveModelCache(accountType: AccountType, models: CopilotModel[]): void {
  const payload = {
    version: 1 as const,
    accountType,
    savedAtIso: new Date().toISOString(),
    models
  };
  writeFileSecureAtomic(modelsCachePath(), JSON.stringify(payload, null, 2), 0o600);
}

function readModelCache(accountType: AccountType): null | { savedAtIso: string; models: CopilotModel[] } {
  const filePath = modelsCacheReadPath();
  if (!fs.existsSync(filePath)) {
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
  const parsed = ModelsCacheSchema.safeParse(raw);
  if (!parsed.success || parsed.data.accountType !== accountType) {
    return null;
  }
  return {
    savedAtIso: parsed.data.savedAtIso,
    models: parsed.data.models
  };
}

function normalizeModelId(value: string): string {
  return value.trim().toLowerCase().replace(/[\s._]+/g, "-");
}

function trimDateSnapshot(value: string): string {
  return value.replace(/-\d{4}-\d{2}-\d{2}$/, "");
}
