import fs from "node:fs";
import path from "node:path";
import type { PiModelProviderConfig } from "./schema.js";

/**
 * Profile-scoped pi model providers: copillm discovers the model list from an
 * OpenAI-style `/{discovery_path}` route (e.g. a local vLLM/Ollama/DeepSeek
 * endpoint) and renders the provider into pi's `models.json`, so pi can connect
 * and use those models alongside the copillm proxy catalog. The provider's
 * apiKey is kept as a literal or an environment-variable reference — never a
 * resolved secret written to disk.
 *
 * Discovery is best-effort: a failed or slow endpoint falls back to the
 * profile's static `models` list (or an empty list with a note), so a
 * sleeping laptop server doesn't block `copillm pi`.
 */

export const DISCOVERY_TIMEOUT_MS = 5_000;

interface DiscoveredModel {
  id: string;
  contextWindow?: number;
}

interface PiModelEntry {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
  samplingParams?: Record<string, unknown>;
  thinkingLevelMap?: Record<string, unknown>;
}

/**
 * Query `{baseUrl}{discoveryPath}` and return the discovered model ids.
 * Returns null when the endpoint is unreachable or returns no usable list.
 */
export async function discoverPiModels(
  provider: PiModelProviderConfig,
  fetchImpl: typeof fetch = fetch
): Promise<null | DiscoveredModel[]> {
  const baseUrl = provider.base_url.replace(/\/+$/, "");
  const discoveryPath = provider.discovery_path.startsWith("/")
    ? provider.discovery_path
    : `/${provider.discovery_path}`;
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}${discoveryPath}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  try {
    const payload = (await response.json()) as { data?: unknown };
    if (!Array.isArray(payload?.data)) {
      return null;
    }
    const out: DiscoveredModel[] = [];
    for (const item of payload.data) {
      if (!item || typeof item !== "object") continue;
      const id = (item as { id?: unknown }).id;
      if (typeof id !== "string" || id.length === 0) continue;
      const entry: DiscoveredModel = { id };
      const maxModelLen = (item as { max_model_len?: unknown }).max_model_len;
      if (typeof maxModelLen === "number" && Number.isFinite(maxModelLen) && maxModelLen > 0) {
        entry.contextWindow = maxModelLen;
      }
      out.push(entry);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Render one profile provider into pi's `models.json` provider shape. Static
 * model metadata wins for ids present in the static list; discovered ids that
 * are not statically listed are appended (with contextWindow from the endpoint
 * when reported).
 */
export function renderPiModelProvider(
  provider: PiModelProviderConfig,
  discovered: null | DiscoveredModel[]
): Record<string, unknown> {
  const staticModels = provider.models ?? [];
  const byId = new Map<string, PiModelEntry>();
  for (const model of staticModels) {
    const entry: PiModelEntry = { id: model.id };
    if (model.name !== undefined) entry.name = model.name;
    if (model.contextWindow !== undefined) entry.contextWindow = model.contextWindow;
    if (model.maxTokens !== undefined) entry.maxTokens = model.maxTokens;
    if (model.reasoning !== undefined) entry.reasoning = model.reasoning;
    if (model.input !== undefined) entry.input = model.input;
    if (model.samplingParams !== undefined) entry.samplingParams = model.samplingParams;
    if (model.thinkingLevelMap !== undefined) entry.thinkingLevelMap = model.thinkingLevelMap;
    byId.set(model.id, entry);
  }
  for (const model of discovered ?? []) {
    if (byId.has(model.id)) {
      const existing = byId.get(model.id)!;
      if (existing.contextWindow === undefined && model.contextWindow !== undefined) {
        existing.contextWindow = model.contextWindow;
      }
      continue;
    }
    const entry: PiModelEntry = { id: model.id };
    if (model.contextWindow !== undefined) entry.contextWindow = model.contextWindow;
    byId.set(model.id, entry);
  }

  const out: Record<string, unknown> = {
    baseUrl: provider.base_url.replace(/\/+$/, ""),
    api: provider.api,
    models: [...byId.values()]
  };
  if (provider.name) out.name = provider.name;
  if (provider.api_key) {
    out.apiKey = provider.api_key;
  } else if (provider.api_key_env) {
    // Env-reference; pi interpolates ${NAME} at request time.
    out.apiKey = `$${provider.api_key_env}`;
  }
  return out;
}

/**
 * Discover + merge every profile pi_models provider into `<agentDir>/models.json`,
 * preserving unrelated providers (e.g. the copillm proxy catalog or the native
 * Copilot base-URL pin). Returns human-readable notes for the launcher.
 */
export async function discoverAndWritePiModels(
  agentDir: string,
  providers: Record<string, PiModelProviderConfig>,
  fetchImpl: typeof fetch = fetch
): Promise<string[]> {
  const notes: string[] = [];
  if (Object.keys(providers).length === 0) {
    return notes;
  }
  const modelsPath = path.join(agentDir, "models.json");
  const doc = readModelsJson(modelsPath);

  for (const [providerId, provider] of Object.entries(providers)) {
    let discovered: null | DiscoveredModel[] = null;
    if (provider.discover_models) {
      discovered = await discoverPiModels(provider, fetchImpl);
    }
    const hasModels =
      (provider.models?.length ?? 0) > 0 || (discovered?.length ?? 0) > 0;
    if (!hasModels) {
      notes.push(
        `pi_models "${providerId}": discovery failed at ${provider.base_url}${provider.discovery_path} and no static models configured; provider omitted.`
      );
      continue;
    }
    if (discovered === null && (provider.models?.length ?? 0) === 0) {
      notes.push(
        `pi_models "${providerId}": discovery failed; using static models.`
      );
    }
    const rendered = renderPiModelProvider(provider, discovered);
    doc.providers[providerId] = rendered;
    const renderedModels = rendered.models as unknown;
    const modelCount = Array.isArray(renderedModels) ? renderedModels.length : 0;
    notes.push(
      `pi_models "${providerId}" → ${modelCount} model(s) at ${provider.base_url}`
    );
  }

  fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
  fs.writeFileSync(modelsPath, `${JSON.stringify(doc, null, 2)}\n`);
  return notes;
}

function readModelsJson(modelsPath: string): { providers: Record<string, unknown> } {
  try {
    const parsed = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const providers = (parsed as { providers?: unknown }).providers;
      if (providers && typeof providers === "object" && !Array.isArray(providers)) {
        return { providers: providers as Record<string, unknown> };
      }
      return { providers: {} };
    }
  } catch {
    // Missing or corrupt — start fresh.
  }
  return { providers: {} };
}
