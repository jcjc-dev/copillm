import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSecureAtomic } from "../config/fsSecurity.js";
import { getCopillmHome } from "../config/home.js";
import type { PackageInfo } from "../config/packageInfo.js";
import { defaultNpmExecutable, resolveNpmUserConfigPath, withNpmUserConfig } from "./resolveAgent.js";
import { spawnAgent } from "./windowsSpawn.js";

const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org/";
const UPDATE_CHECK_TIMEOUT_MS = 3_000;
const NPM_PROCESS_STARTUP_GRACE_MS = 1_000;

interface UpdateCache {
  version: 1;
  packageName: string;
  latestVersion: null | string;
  checkedAt: number;
}

interface Output {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

interface UpdateNotifierOptions {
  packageInfo: PackageInfo;
  argv?: readonly string[];
  cacheFilePath?: string;
  env?: NodeJS.ProcessEnv;
  npmExecutable?: string;
  npmRunner?: NpmCommandRunner;
  moduleUrl?: string;
  now?: () => number;
  stderr?: Output;
}

interface FetchLatestOptions {
  env?: NodeJS.ProcessEnv;
  npmExecutable?: string;
  npmRunner?: NpmCommandRunner;
  registryUrl?: string;
  timeoutMs?: number;
}

export interface NpmCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface NpmCommandResult {
  exitCode: null | number;
  stdout: string;
}

export type NpmCommandRunner = (
  executable: string,
  args: string[],
  options: NpmCommandOptions
) => Promise<NpmCommandResult>;

export async function maybeNotifyAboutUpdate(options: UpdateNotifierOptions): Promise<void> {
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;
  const stderr = options.stderr ?? process.stderr;
  const now = options.now ?? Date.now;
  const packageInfo = options.packageInfo;
  const cacheFile = options.cacheFilePath ?? updateCachePath();

  if (!shouldRunUpdateCheck({ argv, env, moduleUrl: options.moduleUrl ?? import.meta.url, packageInfo, stderr })) {
    return;
  }

  const cache = readUpdateCache(cacheFile, packageInfo.name);
  const checkedAt = now();
  const latestVersion = await fetchLatestNpmVersion(packageInfo.name, {
    env,
    npmExecutable: options.npmExecutable,
    npmRunner: options.npmRunner,
    registryUrl: env.COPILLM_UPDATE_REGISTRY_URL,
    timeoutMs: UPDATE_CHECK_TIMEOUT_MS
  });

  if (latestVersion) {
    writeUpdateCache(cacheFile, {
      version: 1,
      packageName: packageInfo.name,
      latestVersion,
      checkedAt
    });
    notifyIfNewer(stderr, packageInfo, latestVersion);
    return;
  }

  writeUpdateCache(cacheFile, {
    version: 1,
    packageName: packageInfo.name,
    latestVersion: cache?.latestVersion ?? null,
    checkedAt
  });
  notifyIfNewer(stderr, packageInfo, cache?.latestVersion ?? null);
}

export async function fetchLatestNpmVersion(packageName: string, options: FetchLatestOptions = {}): Promise<null | string> {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS;
  const npmExecutable = options.npmExecutable ?? defaultNpmExecutable(env);
  const npmRunner = options.npmRunner ?? runNpmCommand;
  const userConfigPath = resolveNpmUserConfigPath(env);
  const registryUrl = await primaryRegistryUrl({
    env,
    npmExecutable,
    npmRunner,
    registryUrl: options.registryUrl,
    timeoutMs,
    userConfigPath
  });
  const registries = [registryUrl ?? DEFAULT_REGISTRY_URL];
  if (!sameRegistry(registries[0], DEFAULT_REGISTRY_URL)) {
    registries.push(DEFAULT_REGISTRY_URL);
  }

  for (const registry of registries) {
    const latestVersion = await npmViewLatest({
      env,
      npmExecutable,
      npmRunner,
      packageName,
      registry,
      timeoutMs,
      userConfigPath
    });
    if (latestVersion) {
      return latestVersion;
    }
  }

  return null;
}

async function primaryRegistryUrl(options: {
  env: NodeJS.ProcessEnv;
  npmExecutable: string;
  npmRunner: NpmCommandRunner;
  registryUrl?: string;
  timeoutMs: number;
  userConfigPath: null | string;
}): Promise<null | string> {
  const explicitRegistry = normalizeRegistryUrl(options.registryUrl) ??
    normalizeRegistryUrl(options.env.COPILLM_UPDATE_REGISTRY_URL);
  if (explicitRegistry) {
    return explicitRegistry;
  }

  const environmentRegistry = normalizeRegistryUrl(options.env.npm_config_registry) ??
    normalizeRegistryUrl(options.env.NPM_CONFIG_REGISTRY);
  if (environmentRegistry) {
    return environmentRegistry;
  }

  const configArgs = withNpmUserConfig(
    ["config", "get", "registry", "--location=user"],
    options.userConfigPath
  );
  const result = await runNpm(options.npmRunner, options.npmExecutable, configArgs, {
    cwd: os.homedir(),
    env: options.env,
    timeoutMs: options.timeoutMs
  });
  return result?.exitCode === 0 ? normalizeRegistryUrl(result.stdout) : null;
}

async function npmViewLatest(options: {
  env: NodeJS.ProcessEnv;
  npmExecutable: string;
  npmRunner: NpmCommandRunner;
  packageName: string;
  registry: string;
  timeoutMs: number;
  userConfigPath: null | string;
}): Promise<null | string> {
  const args = withNpmUserConfig(
    [
      "view",
      options.packageName,
      "dist-tags.latest",
      "--json",
      `--fetch-timeout=${options.timeoutMs}`,
      "--fetch-retries=0"
    ],
    options.userConfigPath
  );
  const env = withNpmRegistry(options.env, options.registry);
  const result = await runNpm(options.npmRunner, options.npmExecutable, args, {
    cwd: os.homedir(),
    env,
    timeoutMs: options.timeoutMs + NPM_PROCESS_STARTUP_GRACE_MS
  });
  if (result?.exitCode !== 0) {
    return null;
  }
  return latestFromNpmView(result.stdout);
}

async function runNpm(
  npmRunner: NpmCommandRunner,
  npmExecutable: string,
  args: string[],
  options: NpmCommandOptions
): Promise<null | NpmCommandResult> {
  try {
    return await npmRunner(npmExecutable, args, options);
  } catch {
    return null;
  }
}

function runNpmCommand(
  executable: string,
  args: string[],
  options: NpmCommandOptions
): Promise<NpmCommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let timedOut = false;
    let child: ReturnType<typeof spawnAgent>;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: NpmCommandResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    try {
      child = spawnAgent(executable, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true
      });
    } catch {
      resolve({ exitCode: null, stdout: "" });
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", () => finish({ exitCode: null, stdout }));
    child.once("close", (code) => finish({ exitCode: timedOut ? null : code, stdout }));
  });
}

function withNpmRegistry(env: NodeJS.ProcessEnv, registryUrl: string): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const key of Object.keys(result)) {
    if (key.toLowerCase() === "npm_config_registry") {
      delete result[key];
    }
  }
  result.npm_config_registry = registryUrl;
  return result;
}

function normalizeRegistryUrl(value: null | string | undefined): null | string {
  if (!value || value.trim().length === 0) {
    return null;
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function sameRegistry(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    const normalizePath = (value: string): string => value.replace(/\/+$/, "");
    return leftUrl.origin === rightUrl.origin &&
      normalizePath(leftUrl.pathname) === normalizePath(rightUrl.pathname) &&
      leftUrl.search === rightUrl.search;
  } catch {
    return left.trim().replace(/\/+$/, "").toLowerCase() ===
      right.trim().replace(/\/+$/, "").toLowerCase();
  }
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareSemver(candidate, current) > 0;
}

/**
 * Parse `"1" | "true" | "yes" | "on"` → true, `"0" | "false" | "no" | "off"` → false,
 * anything else → null. Exposed so the status command can mirror the
 * `COPILLM_UPDATE_CHECK` opt-out semantics without re-implementing the parsing.
 */
export function parseBooleanOverride(value: undefined | string): null | boolean {
  if (value === undefined) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return null;
}

function shouldRunUpdateCheck(opts: {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  moduleUrl: string;
  packageInfo: PackageInfo;
  stderr: Output;
}): boolean {
  if (opts.stderr.isTTY !== true) return false;
  if (isTruthyCi(opts.env.CI) || isTruthyCi(opts.env.CONTINUOUS_INTEGRATION)) return false;
  if (opts.env.NODE_ENV === "test") return false;
  if ("NO_UPDATE_NOTIFIER" in opts.env) return false;
  if (hasArg(opts.argv, "--no-update-notifier")) return false;
  if (hasArg(opts.argv, "--version") || hasArg(opts.argv, "-V") || hasArg(opts.argv, "--help") || hasArg(opts.argv, "-h")) return false;
  if (hasArg(opts.argv, "--json")) return false;
  if (opts.argv.slice(2).includes("daemon")) return false;

  const override = parseBooleanOverride(opts.env.COPILLM_UPDATE_CHECK);
  if (override !== null) {
    return override;
  }

  return isNpmInstalledRuntime(opts.moduleUrl, opts.packageInfo.name);
}

function isNpmInstalledRuntime(moduleUrl: string, packageName: string): boolean {
  let modulePath: string;
  try {
    modulePath = fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
  const normalized = modulePath.split(path.sep).join("/").toLowerCase();
  const marker = `/node_modules/${packageName.toLowerCase()}/`;
  return normalized.includes(marker);
}

function updateCachePath(): string {
  return path.join(getCopillmHome(), "update-check.json");
}

function readUpdateCache(filePath: string, packageName: string): null | UpdateCache {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return parseUpdateCache(parsed, packageName);
  } catch {
    return null;
  }
}

function writeUpdateCache(filePath: string, cache: UpdateCache): void {
  try {
    writeFileSecureAtomic(filePath, `${JSON.stringify(cache, null, 2)}\n`, 0o600);
  } catch {
    // Update checks are advisory and must never prevent the CLI from starting.
  }
}

function parseUpdateCache(value: unknown, packageName: string): null | UpdateCache {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as {
    version?: unknown;
    packageName?: unknown;
    latestVersion?: unknown;
    checkedAt?: unknown;
  };
  if (candidate.version !== 1 || candidate.packageName !== packageName) {
    return null;
  }
  if (candidate.latestVersion !== null && typeof candidate.latestVersion !== "string") {
    return null;
  }
  if (typeof candidate.checkedAt !== "number" || !Number.isFinite(candidate.checkedAt)) {
    return null;
  }
  return {
    version: 1,
    packageName,
    latestVersion: candidate.latestVersion,
    checkedAt: candidate.checkedAt
  };
}

function latestFromNpmView(value: string): null | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.trim()) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "string") {
    return null;
  }
  const latest = parsed.trim();
  return parseSemver(latest) ? latest : null;
}

function notifyIfNewer(stderr: Output, packageInfo: PackageInfo, latestVersion: null | string): void {
  if (!latestVersion || !isNewerVersion(latestVersion, packageInfo.version)) {
    return;
  }
  stderr.write(
    [
      "",
      `copillm ${latestVersion} is available (current ${packageInfo.version}).`,
      "Update with: npm install -g copillm",
      "Release notes: https://github.com/jcjc-dev/copillm/releases/latest",
      ""
    ].join("\n")
  );
}

function hasArg(argv: readonly string[], arg: string): boolean {
  return argv.slice(2).includes(arg);
}

function isTruthyCi(value: undefined | string): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

function compareSemver(left: string, right: string): number {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (!parsedLeft || !parsedRight) {
    return 0;
  }

  for (let i = 0; i < 3; i += 1) {
    const delta = parsedLeft.core[i] - parsedRight.core[i];
    if (delta !== 0) {
      return delta;
    }
  }

  if (parsedLeft.prerelease === parsedRight.prerelease) {
    return 0;
  }
  if (parsedLeft.prerelease === null) {
    return 1;
  }
  if (parsedRight.prerelease === null) {
    return -1;
  }
  return parsedLeft.prerelease.localeCompare(parsedRight.prerelease);
}

function parseSemver(value: string): null | { core: [number, number, number]; prerelease: null | string } {
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) {
    return null;
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? null
  };
}
