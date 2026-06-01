import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSecureAtomic } from "../config/fsSecurity.js";
import { getCopillmHome } from "../config/home.js";
import type { PackageInfo } from "./packageInfo.js";

const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org";
const UPDATE_CHECK_TIMEOUT_MS = 3_000;

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
  fetchImpl?: typeof fetch;
  moduleUrl?: string;
  now?: () => number;
  stderr?: Output;
}

interface FetchLatestOptions {
  fetchImpl?: typeof fetch;
  registryUrl?: string;
  timeoutMs?: number;
}

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
    fetchImpl: options.fetchImpl,
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
  const registryUrl = options.registryUrl && options.registryUrl.trim().length > 0
    ? options.registryUrl.trim()
    : DEFAULT_REGISTRY_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);

  try {
    const response = await fetchImpl(distTagsUrl(packageName, registryUrl), {
      headers: { accept: "application/json" },
      signal
    });
    if (!response.ok) {
      return null;
    }
    return latestFromDistTags(await response.json());
  } catch {
    return null;
  }
}

export function distTagsUrl(packageName: string, registryUrl = DEFAULT_REGISTRY_URL): string {
  return `${registryUrl.replace(/\/+$/, "")}/-/package/${encodeURIComponent(packageName)}/dist-tags`;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareSemver(candidate, current) > 0;
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

function latestFromDistTags(value: unknown): null | string {
  if (!value || typeof value !== "object") {
    return null;
  }
  const latest = (value as { latest?: unknown }).latest;
  return typeof latest === "string" && latest.trim().length > 0 ? latest.trim() : null;
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

function parseBooleanOverride(value: undefined | string): null | boolean {
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
