import fs from "node:fs";
import { setTimeout as defaultSleep } from "node:timers/promises";
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

/**
 * Optional dependency-injection seam for tests. Production callers pass
 * nothing and we use the global `fetch` + `node:timers/promises` sleep.
 *
 * `timeoutMs` bounds each individual fetch so a hung Copilot edge can't
 * pin `copillm start` for the lifetime of the process. The previous
 * version had no timeout — a black-hole network meant an indefinite hang.
 */
export interface ModelDiscoveryDeps {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  timeoutMs?: number;
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

/**
 * Per-attempt timeout for the `/models` fetch. The catalog is typically
 * <50ms on a healthy connection, so 15s leaves plenty of room for slow
 * networks without freezing `copillm start` for a full minute.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/**
 * Exponential backoff base for `listModelsUnion` retry loop. Mirrors the
 * 200ms / 400ms / 800ms shape used by `src/server/upstream/copilotClient.ts`
 * and the new `CopilotTokenManager.exchange()` retry path. Boundary rules
 * (`eslint.config.js`) keep `models` from importing the shared
 * `retryPolicy.ts`, so we re-declare the small handful of constants here
 * rather than introduce a new architectural dependency.
 */
const DEFAULT_BACKOFF_BASE_MS = 200;

/**
 * Statuses worth retrying — same set as `retryPolicy.ts`. 401/403/404 are
 * NOT here because they signal terminal credential / endpoint failures
 * and retrying just delays the error the user needs to see.
 *
 * `canUseCacheFallback` (further down) is intentionally MORE permissive:
 * it also includes 401/403/408 so that a misbehaving upstream serving 401
 * to a perfectly-good token can degrade to the cached snapshot instead of
 * surfacing a misleading auth error.
 */
const RETRYABLE_DISCOVERY_STATUSES: ReadonlySet<number> = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export function accountBaseUrl(accountType: AccountType): string {
  return copilotBaseUrl(accountType);
}

export async function listModels(
  accountType: AccountType,
  bearerToken: string,
  deps?: ModelDiscoveryDeps
): Promise<ModelDiscoveryResult> {
  const fetchImpl = deps?.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = deps?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

  try {
    const response = await fetchImpl(`${accountBaseUrl(accountType)}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/json",
        "User-Agent": "copillm/0.1.0"
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      throw new ModelDiscoveryHttpError(response.status);
    }
    const payload = (await response.json()) as unknown;
    const candidateModels = extractModelArray(payload);
    const parsed = z.array(ModelSchema).safeParse(candidateModels);
    if (!parsed.success) {
      throw new ModelDiscoverySchemaError("Model discovery response is invalid.");
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

/**
 * Run multiple discovery attempts and union the results across them.
 *
 * Two changes from the previous version:
 *
 *   1. **Exponential backoff between attempts** — was a tight loop that
 *      hammered Copilot 3× immediately on a 429 burst, extending the
 *      rate-limit lockout. Now sleeps 200ms × 2^(attempt-1) between
 *      iterations, matching the curve used in `copilotClient.ts` and the
 *      token-exchange retry.
 *   2. **Short-circuit on terminal failures** — a schema-invalid 200 or
 *      a `Model discovery failed and no cache snapshot is available`
 *      surface no longer retries; both are deterministic failures that
 *      retrying can't fix and the misleading "across all attempts" error
 *      hid the real cause.
 *
 * `attempts` keeps its previous default of 3 for callers that don't
 * specify. Each attempt's own retry budget lives inside `listModels`'s
 * cache-fallback path; this loop runs once per upstream call.
 */
export async function listModelsUnion(
  accountType: AccountType,
  bearerToken: string,
  attempts = 3,
  deps?: ModelDiscoveryDeps
): Promise<ModelDiscoveryResult> {
  const sleepImpl = deps?.sleepImpl ?? ((ms) => defaultSleep(ms));
  const seen = new Map<string, CopilotModel>();
  let lastResult: ModelDiscoveryResult | null = null;
  let lastError: unknown;
  let consecutiveFailures = 0;

  for (let i = 0; i < attempts; i += 1) {
    try {
      const result = await listModels(accountType, bearerToken, deps);
      lastResult = result;
      consecutiveFailures = 0;
      for (const model of result.models) {
        if (typeof model.id === "string" && !seen.has(model.id)) {
          seen.set(model.id, model);
        }
      }
    } catch (error) {
      lastError = error;
      consecutiveFailures += 1;
      // Schema failures are deterministic — same response shape, same error.
      // Don't burn the rest of the retry budget; surface the real cause now.
      if (error instanceof ModelDiscoverySchemaError) {
        throw error;
      }
      // HTTP failures that aren't on the retryable list (e.g. 401/403 with
      // no cache, 404) are also deterministic. The cache-fallback path
      // inside `listModels` has already had its chance to engage; if we got
      // here it didn't.
      if (error instanceof ModelDiscoveryHttpError && !RETRYABLE_DISCOVERY_STATUSES.has(error.status)) {
        throw error;
      }
    }
    // Only sleep between attempts if the most recent attempt FAILED. Sleeping
    // between successful attempts would burn wall-clock for no benefit when
    // the union is already populated. Sleep schedule mirrors the rest of the
    // codebase: 200ms × 2^(failure-1), so 200 → 400 → 800 between failures.
    if (i < attempts - 1 && consecutiveFailures > 0) {
      await sleepImpl(DEFAULT_BACKOFF_BASE_MS * Math.pow(2, consecutiveFailures - 1));
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

export class ModelDiscoveryHttpError extends Error {
  constructor(public readonly status: number) {
    super(`Model discovery failed (${status}).`);
    this.name = "ModelDiscoveryHttpError";
  }
}

export class ModelDiscoverySchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelDiscoverySchemaError";
  }
}

/**
 * Statuses + error types that allow degrading to the on-disk cache instead
 * of failing the caller.
 *
 * Widened from the previous `429 || >= 500` to include 401, 403, 408 — the
 * exact case the seed audit hit: a transient 401 from `api.github.com/...`
 * or its proxy in front of `/models` would re-throw and tell the user
 * `Model discovery failed and no cache snapshot is available.` even when
 * a perfectly good cached catalog existed. With this widening, a fresh
 * cache (typical for users who've run `copillm start` recently) hides the
 * blip from agent surfaces.
 *
 * Schema errors are intentionally NOT cache-eligible: a 200 with a body
 * shape we don't recognize is a deterministic failure that the cache
 * can't paper over, and surfacing the real `Model discovery response is
 * invalid.` error is more useful than silently serving stale data.
 *
 * Non-HTTP errors (transport / AbortError / generic) DO fall back — those
 * are exactly the kinds of transient failures the cache exists for.
 */
function canUseCacheFallback(error: unknown): boolean {
  if (error instanceof ModelDiscoverySchemaError) {
    return false;
  }
  if (error instanceof ModelDiscoveryHttpError) {
    return CACHE_FALLBACK_STATUSES.has(error.status) || error.status >= 500;
  }
  return true;
}

const CACHE_FALLBACK_STATUSES: ReadonlySet<number> = new Set([401, 403, 408, 409, 425, 429]);

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
