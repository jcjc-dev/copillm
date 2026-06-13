import fs from "node:fs";
import path from "node:path";
import { type CopilotModel } from "../../models/discovery.js";
import { ensureSecureDirectory, writeFileSecureAtomic } from "../../config/fsSecurity.js";
import { piAgentDir } from "../../config/home.js";
import { resolveStartContext, type PrecomputedStartContext } from "../codex/init.js";

/**
 * pi (`@earendil-works/pi-coding-agent`) reads its config from
 * `<agentDir>/models.json`. pi resolves `<agentDir>` from the
 * `PI_CODING_AGENT_DIR` env var when set, falling back to `~/.pi/agent`.
 *
 * copillm owns that path via `piAgentDir()` (see `src/config/home.ts`): it
 * defaults to `<COPILLM_HOME>/pi/agent` and copillm exports `PI_CODING_AGENT_DIR`
 * to it when launching pi (see `buildPiEnvBundle`). This keeps copillm out of
 * the user's real `~/.pi`, and makes dev/prod isolation automatic (the dev home
 * relocates it). We still back up any pre-existing file the first time we touch
 * a path, in case the user pointed `PI_CODING_AGENT_DIR` at an existing dir.
 */

export interface PiInitOptions {
  /** Output directory under copillm's home, kept for parity with codex; we mirror
   *  the generated models.json there as well so users can inspect / re-apply it. */
  outDir: string;
  /** Local proxy port. */
  port: number;
  /** Provider key prefix in pi's models.json. The Anthropic-surface provider
   *  uses this id verbatim; the OpenAI-responses provider appends `-responses`. */
  providerId: string;
  /**
   * Optional pre-loaded context shared with the daemon + codex steps of
   * `copillm start`. When omitted, `generatePiHome` loads its own creds /
   * config / discovery — preserving today's standalone behaviour for
   * `copillm pi`, `copillm env pi`, and any other one-shot invocation.
   */
  precomputed?: PrecomputedStartContext;
}

export interface PiInitResult {
  /** copillm-owned mirror dir (e.g. `~/.copillm/pi/`). */
  outDir: string;
  /** Mirror of models.json kept under copillm's home for inspection. */
  mirrorPath: string;
  /** The actual file pi reads at launch (`<PI_CODING_AGENT_DIR>/models.json`). */
  configPath: string;
  /** If a pre-existing models.json was backed up, the backup path. */
  backupPath: string | null;
  /** Total number of model entries across all providers. */
  modelCount: number;
  /** Number of models routed through the Anthropic-messages provider. */
  anthropicModelCount: number;
  /** Number of models routed through the OpenAI-responses provider. */
  responsesModelCount: number;
  /** http://127.0.0.1:<port>/anthropic */
  proxyUrl: string;
  /** http://127.0.0.1:<port>/codex/v1 */
  responsesProxyUrl: string;
}

/**
 * Shape of an entry in pi's `models.json` provider list. Mirrors
 * `ModelDefinitionSchema` in `@earendil-works/pi-coding-agent`'s model
 * registry: only `id` is required, everything else is optional. We populate
 * `contextWindow` and `maxTokens` from the upstream Copilot catalog's
 * `capabilities.limits` so pi's context-overflow / autocompact logic uses the
 * model's real budget instead of pi's 128_000 / 16_384 defaults.
 */
interface PiModelEntry {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
}

interface PiProviderEntry {
  baseUrl: string;
  api: "anthropic-messages" | "openai-responses" | "openai-completions";
  apiKey: string;
  models: PiModelEntry[];
}

interface PiModelsConfig {
  providers: Record<string, PiProviderEntry>;
}

export async function generatePiHome(options: PiInitOptions): Promise<PiInitResult> {
  const { discovery } = await resolveStartContext(options.precomputed);
  const eligible = discovery.models.filter(isPickerEligible);

  // Split the catalog by which upstream endpoint each model supports. Models
  // that advertise `/chat/completions` flow through copillm's Anthropic surface
  // (the proxy translates Anthropic-messages → OpenAI chat completions
  // upstream). Models that only advertise `/responses` (newer GPT-5.x
  // responses-only variants, codex-class models) flow through copillm's
  // `/codex/v1/responses` route and surface in pi as a second provider using
  // pi's `openai-responses` api. A model that supports both endpoints is
  // exposed via the Anthropic-messages path only, so pi's picker doesn't
  // double-list it.
  const anthropicEligible = uniqueByModelId(eligible.filter(supportsChatCompletions));
  const responsesEligible = uniqueByModelId(
    eligible.filter((m) => !supportsChatCompletions(m) && supportsResponses(m))
  );

  if (anthropicEligible.length === 0 && responsesEligible.length === 0) {
    throw new Error("No models discovered for pi config.");
  }

  const proxyUrl = `http://127.0.0.1:${options.port}/anthropic`;
  // OpenAI SDK posts to `<baseUrl>/responses`, so the baseUrl must include `/v1`.
  const responsesProxyUrl = `http://127.0.0.1:${options.port}/codex/v1`;
  const providerId = options.providerId.trim().length > 0 ? options.providerId : "copillm";
  const responsesProviderId = `${providerId}-responses`;

  const providers: Record<string, PiProviderEntry> = {};
  if (anthropicEligible.length > 0) {
    providers[providerId] = {
      baseUrl: proxyUrl,
      api: "anthropic-messages",
      apiKey: "copillm-local",
      models: anthropicEligible.map(toPiModelEntry)
    };
  }
  if (responsesEligible.length > 0) {
    providers[responsesProviderId] = {
      baseUrl: responsesProxyUrl,
      api: "openai-responses",
      apiKey: "copillm-local",
      models: responsesEligible.map(toPiModelEntry)
    };
  }

  const payload: PiModelsConfig = { providers };
  const json = `${JSON.stringify(payload, null, 2)}\n`;

  // 1. Write copillm-owned mirror under ~/.copillm/pi/models.json
  const absOutDir = path.resolve(options.outDir);
  ensureSecureDirectory(absOutDir);
  const mirrorPath = path.join(absOutDir, "models.json");
  writeFileSecureAtomic(mirrorPath, json, 0o600);

  // 2. Write the real config pi reads at launch, backing up any pre-existing file.
  const configPath = piModelsJsonPath();
  const backupPath = backupIfMismatch(configPath, json);
  ensureSecureDirectory(path.dirname(configPath));
  writeFileSecureAtomic(configPath, json, 0o600);

  return {
    outDir: absOutDir,
    mirrorPath,
    configPath,
    backupPath,
    modelCount: anthropicEligible.length + responsesEligible.length,
    anthropicModelCount: anthropicEligible.length,
    responsesModelCount: responsesEligible.length,
    proxyUrl,
    responsesProxyUrl
  };
}

export function defaultOutputDir(home: string): string {
  return path.join(home, "pi");
}

/** Absolute path to pi's `models.json`, under the copillm-owned pi agent dir. */
export function piModelsJsonPath(): string {
  return path.join(piAgentDir(), "models.json");
}

/**
 * Eligibility filter shared by both pi providers. Mirrors the gating in
 * `/anthropic/v1/models` and `/codex/v1/models`: a model must be marked
 * picker-enabled by the upstream catalog and its policy must not be disabled.
 * We deliberately do NOT filter by vendor name (so OpenAI- and Gemini-family
 * models surface in pi alongside Anthropic ones); per-endpoint filtering is
 * done by the caller via `supportsChatCompletions` / `supportsResponses`.
 */
function isPickerEligible(model: CopilotModel): boolean {
  if (typeof model.id !== "string" || model.id.length === 0) return false;
  if (getNested<boolean>(model, "model_picker_enabled") !== true) return false;
  const policyState = getNested<string>(model, "policy", "state");
  if (typeof policyState === "string" && policyState !== "enabled") return false;
  return true;
}

function supportsChatCompletions(model: CopilotModel): boolean {
  return getEndpointList(model).includes("/chat/completions");
}

function supportsResponses(model: CopilotModel): boolean {
  return getEndpointList(model).includes("/responses");
}

function getEndpointList(model: CopilotModel): string[] {
  const raw = (model as { supported_endpoints?: unknown }).supported_endpoints;
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

function toPiModelEntry(model: CopilotModel): PiModelEntry {
  const entry: PiModelEntry = { id: model.id };
  const contextWindow = getNested<number>(model, "capabilities", "limits", "max_context_window_tokens");
  if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
    entry.contextWindow = contextWindow;
  }
  const maxOutput = getNested<number>(model, "capabilities", "limits", "max_output_tokens");
  if (typeof maxOutput === "number" && Number.isFinite(maxOutput) && maxOutput > 0) {
    entry.maxTokens = maxOutput;
  }
  return entry;
}

function uniqueByModelId(models: CopilotModel[]): CopilotModel[] {
  const seen = new Set<string>();
  const out: CopilotModel[] = [];
  for (const m of models) {
    const id = typeof m.id === "string" ? m.id : "";
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(m);
  }
  return out;
}

function getNested<T>(source: unknown, ...path: string[]): undefined | T {
  let cur: unknown = source;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur as undefined | T;
}

/**
 * If `target` exists and its contents differ from the new payload, copy it
 * aside to a timestamped `.bak`. Returns the backup path, or null when no
 * backup was needed. Best-effort: failures don't block the write — we'd
 * rather configure pi correctly than abort because of a backup error.
 */
function backupIfMismatch(target: string, newContent: string): string | null {
  let existing: string;
  try {
    existing = fs.readFileSync(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
  if (existing === newContent) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${target}.copillm-backup-${stamp}.bak`;
  try {
    fs.copyFileSync(target, backupPath);
    return backupPath;
  } catch {
    return null;
  }
}
