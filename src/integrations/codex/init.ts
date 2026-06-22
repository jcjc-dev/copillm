import fs from "node:fs";
import path from "node:path";
import { stringify as stringifyToml } from "smol-toml";
import { loadStoredCredential, type StoredCredential } from "../../auth/credentials.js";
import { loadConfig } from "../../config/config.js";
import { listModelsUnion, type ModelDiscoveryResult } from "../../models/discovery.js";
import { ensureSecureDirectory, writeFileSecureAtomic } from "../../config/fsSecurity.js";
import { buildCodexCatalog } from "../../server/codexSchema.js";
import { inspectLock } from "../../server/lock.js";
import type { AppConfig } from "../../types/index.js";

/**
 * Slugs that flow into `~/.codex/config.toml` must be drawn from a conservative
 * charset. Codex model ids in the upstream Copilot catalog use letters, digits,
 * dot, dash, and underscore (e.g. `claude-sonnet-4.6`, `gpt-5.2-codex`); a
 * future catalog entry with a quote, brace, or newline would let the renderer
 * close one TOML string and inject a new table. We refuse to render anything
 * outside this charset so the renderer's safety doesn't depend on TOML
 * serialiser behaviour alone.
 */
const CODEX_SLUG_PATTERN = /^[A-Za-z0-9._-]+$/;

export class CodexInitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CodexInitError";
  }
}

export interface CodexInitOptions {
  outDir: string;
  model: string | null;
  port: number;
  providerId: string;
  reasoningEffort: string | null;
  /**
   * Optional pre-loaded context. When provided, `generateCodexHome` skips
   * its own `loadConfig` / `loadStoredCredential` / `listModelsUnion` calls
   * and uses the supplied values. The CLI `start` command uses this to
   * collapse 3 redundant token exchanges + 3 model-discovery calls into 1
   * across the daemon + codex + pi init steps.
   *
   * When omitted, behaviour is unchanged — `copillm codex`, `copillm env
   * codex`, and any other standalone caller continues to work as before.
   */
  precomputed?: PrecomputedStartContext;
  /**
   * Path prefix to inject before `/codex/v1` in the generated `base_url`,
   * e.g. `/work` to route Codex at the `work` account. Empty/omitted = the
   * default account (unprefixed).
   */
  pathPrefix?: string;
  /**
   * Discover models as a specific account (its token + per-account cache)
   * instead of the default. Used when launching against a named account so
   * the default-model pick reflects that account's catalog.
   */
  account?: AccountDiscoveryOverride;
}

/**
 * Override for model discovery so codex/pi home generation reflects a specific
 * account's catalog (and writes to that account's model cache).
 */
export interface AccountDiscoveryOverride {
  accountType: AppConfig["accountType"];
  githubToken: string;
  cacheId: string | undefined;
}

/**
 * Context shared across the daemon + codex + pi steps of `copillm start`.
 *
 * Without sharing, each step independently re-runs `loadStoredCredential`
 * (a keychain read), `loadConfig` (a YAML parse), and `listModelsUnion`
 * (multiple Copilot `/models` fetches). The token exchange itself is now
 * gone from these sites (see PR 2 commit), but the remaining work is still
 * worth deduping — it cuts keychain audit-log entries and removes more
 * flake surface on the catalog fetch.
 */
export interface PrecomputedStartContext {
  creds: StoredCredential;
  config: AppConfig;
  discovery: ModelDiscoveryResult;
}

export interface CodexInitResult {
  outDir: string;
  configPath: string;
  modelCount: number;
  defaultModel: string;
  proxyUrl: string;
  exportCommand: string;
}

export async function generateCodexHome(options: CodexInitOptions): Promise<CodexInitResult> {
  const { discovery } = await resolveStartContext(options.precomputed, options.account);
  const catalog = buildCodexCatalog(discovery.models);
  if (catalog.models.length === 0) {
    throw new Error("No Codex-eligible models found in the live catalog.");
  }

  const port = options.port;
  const prefix = options.pathPrefix ?? "";
  const proxyUrl = `http://127.0.0.1:${port}${prefix}/codex/v1`;
  const baseUrl = proxyUrl;
  const defaultModel = options.model ?? pickDefaultModel(catalog.models.map((model) => model.slug));
  if (!catalog.models.some((model) => model.slug === defaultModel)) {
    throw new Error(
      `Requested model "${defaultModel}" is not in the eligible catalog. Available: ${catalog.models.map((model) => model.slug).join(", ")}`
    );
  }

  const absOutDir = path.resolve(options.outDir);
  ensureSecureDirectory(absOutDir);

  const configPath = path.join(absOutDir, "config.toml");
  const reasoningEffort = options.reasoningEffort ?? "medium";
  // Defence in depth: guard the inputs that land in the rendered file by
  // refusing anything that isn't a conservative slug, BEFORE the serialiser
  // ever sees them. `renderConfigToml` itself relies on `stringifyToml` to
  // escape any remaining metacharacters, but rejecting outright keeps the
  // failure mode loud (a clear error at startup rather than a quietly mangled
  // config file on disk).
  assertCodexSlug(defaultModel, "model");
  assertCodexSlug(options.providerId, "model_provider");
  assertCodexSlug(reasoningEffort, "model_reasoning_effort");
  const tomlBody = renderConfigToml({
    model: defaultModel,
    reasoningEffort,
    providerId: options.providerId,
    baseUrl
  });
  writeFileSecureAtomic(configPath, tomlBody, 0o600);

  return {
    outDir: absOutDir,
    configPath,
    modelCount: catalog.models.length,
    defaultModel,
    proxyUrl,
    exportCommand: `CODEX_HOME=${absOutDir} codex`
  };
}

/**
 * Load credentials / config / model discovery once. When the caller has
 * already done this work (e.g. `copillm start` orchestrating multiple init
 * steps), it can pass them in via `precomputed` to skip the work.
 *
 * Exported so `generatePiHome` (and any future agent init) can use the
 * same loader and the same "if precomputed, reuse it" contract.
 */
export async function resolveStartContext(
  precomputed?: PrecomputedStartContext,
  account?: AccountDiscoveryOverride
): Promise<PrecomputedStartContext> {
  if (precomputed) {
    return precomputed;
  }
  const config = loadConfig();
  if (account) {
    const discovery = await listModelsUnion(account.accountType, account.githubToken, 3, undefined, account.cacheId);
    return {
      config,
      creds: { token: account.githubToken, accountType: account.accountType, source: "session" },
      discovery
    };
  }
  const creds = await loadStoredCredential();
  if (!creds) {
    throw new Error("Not authenticated. Run `copillm login` first.");
  }
  const discovery = await listModelsUnion(config.accountType, creds.token, 3);
  return { config, creds, discovery };
}

function pickDefaultModel(slugs: readonly string[]): string {
  const preferred = ["gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.4", "gpt-5.2", "claude-opus-4.5", "claude-sonnet-4.6"];
  for (const candidate of preferred) {
    if (slugs.includes(candidate)) {
      return candidate;
    }
  }
  return slugs[0];
}

function renderConfigToml(input: {
  model: string;
  reasoningEffort: string;
  providerId: string;
  baseUrl: string;
}): string {
  // Build a plain document tree and let smol-toml serialise it. String values
  // get the same quote/escape rules every TOML writer applies, so a
  // hypothetical malicious model id containing a `"` survives as an escaped
  // character inside a quoted string instead of closing one and opening a new
  // table block. The slug-allowlist gate above would have already rejected
  // this case, but the structured serializer is the second layer.
  const doc: Record<string, unknown> = {
    model: input.model,
    model_provider: input.providerId,
    model_reasoning_effort: input.reasoningEffort,
    approvals_reviewer: "user",
    model_providers: {
      [input.providerId]: {
        name: "copillm",
        base_url: input.baseUrl,
        wire_api: "responses",
        requires_openai_auth: false
      }
    }
  };
  const preamble = [
    `# Generated by \`copillm start\` on ${new Date().toISOString()}`,
    `# Use with: CODEX_HOME=<this directory> codex`,
    ``
  ].join("\n");
  return `${preamble}\n${stringifyToml(doc).trimEnd()}\n`;
}

function assertCodexSlug(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0 || !CODEX_SLUG_PATTERN.test(value)) {
    throw new CodexInitError(
      `Refusing to render codex config: ${field}="${value}" contains characters outside [A-Za-z0-9._-]. ` +
        `This indicates a corrupted or upstream-tampered model catalog.`
    );
  }
}

export function defaultOutputDir(home: string): string {
  return path.join(home, "codex");
}

export function listExistingCodexHomes(home: string): string[] {
  const dir = path.join(home, "codex");
  if (!fs.existsSync(dir)) {
    return [];
  }
  return [dir];
}

export function proxyPortFromLock(): number | null {
  const inspection = inspectLock();
  if (inspection.state === "running") {
    return inspection.lock.port;
  }
  return null;
}
