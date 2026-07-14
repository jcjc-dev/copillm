import fs from "node:fs";
import path from "node:path";
import { spawnSync, type SpawnSyncOptionsWithBufferEncoding } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { getCopillmHome } from "../config/home.js";
import {
  type AgentIntegration,
  type AgentName,
  AGENT_REGISTRY
} from "../integrations/registry.js";
import { buildWindowsCmdInvocation } from "./windowsSpawn.js";

export type { AgentName };
export type ResolveSource = "path" | "cache" | "installed";

export interface ResolveOptions {
  pinnedSpec?: string;
  /**
   * Where the pin came from. `env` is the most-untrusted source (a project's
   * direnv `.envrc` or CI-side env can carry it); `cli` is what the user just
   * typed on the command line. The validator is stricter for `env`.
   * Defaults to `cli` so legacy callers keep their old (more permissive)
   * behaviour.
   */
  pinnedSource?: PinSource;
  preferPath?: boolean;
  cacheRoot?: string;
  npmExecutable?: string;
  offline?: boolean;
  log?: (line: string) => void;
}

export interface ResolveResult {
  source: ResolveSource;
  binPath: string;
  version: string;
  packageName: string;
  cacheDir: null | string;
  prunedCount: number;
  displayLine: string;
}

export function packageNameFor(agent: AgentName): string {
  return AGENT_REGISTRY[agent].npmPackage;
}

export function binNameFor(agent: AgentName): string {
  return AGENT_REGISTRY[agent].binName;
}

interface ParsedPin {
  packageName: string;
  version: null | string;
}

export type PinSource = "env" | "cli";

export class InvalidPinSpecError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidPinSpecError";
  }
}

/**
 * Conservative version-range pattern. Must START with a digit or a semver
 * range operator (^ ~ > < = *) and continue with semver-charset characters.
 * Refuses spaces and shell metacharacters (`& | ; < > ( ) ^ " ' \``) so a
 * spec like `1.0.0 & echo PWNED` can never reach `spawnSync` even if the
 * caller forgot to use the windowsSpawn helper.
 *
 * Deliberately rejects strings that look like package names (`evil-pkg`) —
 * those flow through the package-name path that requires equality with the
 * official package name for this agent.
 */
const SAFE_VERSION_PATTERN = /^[\d^~><=*][\w.+~^*><=\-]*$/;

/**
 * Parse `--copillm-use` / `COPILLM_<AGENT>_VERSION`. The `source` argument
 * decides how much we trust the input:
 *
 *   • source: "env"  — accept ONLY a bare version range. A malicious
 *     `.envrc`, direnv config, or CI variable can carry `evil-pkg@1.0.0`,
 *     which the old parser would happily install as `evil-pkg`. With this
 *     restriction the worst an env-supplied pin can do is pin a (possibly
 *     non-existent) version of the OFFICIAL package.
 *
 *   • source: "cli"  — accept the bare version form AND the `<pkg>@<ver>`
 *     form, but require `pkg` to equal the official package for the agent
 *     when both are present. This preserves the documented `--copillm-use
 *     @anthropic-ai/claude-code@1.4.7` pattern while still refusing
 *     `--copillm-use evil-pkg@1.0.0`.
 *
 * Throws `InvalidPinSpecError` on rejection so the CLI surfaces a clear
 * message to the user instead of silently installing arbitrary code.
 */
export function parsePinSpec(agent: AgentName, raw: string, source: PinSource = "cli"): ParsedPin {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { packageName: AGENT_REGISTRY[agent].npmPackage, version: null };
  }
  const officialPkg = AGENT_REGISTRY[agent].npmPackage;
  const lookLikeBareVersion = SAFE_VERSION_PATTERN.test(trimmed);
  if (lookLikeBareVersion) {
    return { packageName: officialPkg, version: trimmed };
  }
  if (source === "env") {
    throw new InvalidPinSpecError(
      `COPILLM_${agent.toUpperCase()}_VERSION must be a bare semver range (e.g. "1.4.7" or "^1.0.0"); got "${trimmed}". ` +
        `Refusing to install an env-supplied package spec — only the version field is configurable from the environment.`
    );
  }
  // CLI source: still allow the documented `<pkg>@<ver>` form, but only when
  // `pkg` matches the official package for this agent.
  const isScoped = trimmed.startsWith("@");
  const lastAt = trimmed.lastIndexOf("@");
  if (lastAt > 0 && (!isScoped || lastAt > 0)) {
    const pkg = trimmed.slice(0, lastAt);
    const ver = trimmed.slice(lastAt + 1);
    if (pkg && ver) {
      if (pkg !== officialPkg) {
        throw new InvalidPinSpecError(
          `--copillm-use may only pin the official package "${officialPkg}" for agent "${agent}"; got "${pkg}". ` +
            `If you need a custom package, install it manually and pass --copillm-use <bare-version>.`
        );
      }
      if (!SAFE_VERSION_PATTERN.test(ver)) {
        throw new InvalidPinSpecError(
          `Version "${ver}" contains characters outside [A-Za-z0-9._+~^*><=-]; refusing to forward to npm.`
        );
      }
      return { packageName: pkg, version: ver };
    }
  }
  // Bare package name with no version separator — treat as package-only.
  // Same allowlist gate so a malicious env var can't slip through via a
  // future caller that passes source="cli".
  if (trimmed === officialPkg) {
    return { packageName: officialPkg, version: null };
  }
  throw new InvalidPinSpecError(
    `Could not parse pin spec "${trimmed}". Expected a bare version range, "${officialPkg}@<version>", or "${officialPkg}".`
  );
}

export async function resolveAgent(agent: AgentName, opts: ResolveOptions = {}): Promise<ResolveResult> {
  const cacheRoot = opts.cacheRoot ?? path.join(getCopillmHome(), "bin");
  const npmExe = opts.npmExecutable ?? defaultNpmExecutable();
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  const integration = AGENT_REGISTRY[agent];
  const pin = opts.pinnedSpec
    ? parsePinSpec(agent, opts.pinnedSpec, opts.pinnedSource ?? "cli")
    : { packageName: integration.npmPackage, version: null };
  const pkg = pin.packageName;
  const binName = integration.binName;
  const agentRoot = path.join(cacheRoot, agent);

  // 1. PATH lookup (opt-in only).
  // PATH lookup is OFF by default so the running agent version is always the one copillm
  // manages in its cache. Users who want to fall back to a system-installed binary can opt
  // in via the COPILLM_USE_SYSTEM_AGENT env var (wired in launchAgent.ts) or by passing
  // `preferPath: true` directly. Pinned versions always skip this branch.
  if (!pin.version && opts.preferPath === true) {
    const found = findOnPath(binName);
    if (found) {
      const v = probeVersion(found) ?? "unknown";
      return {
        source: "path",
        binPath: found,
        version: v,
        packageName: pkg,
        cacheDir: null,
        prunedCount: 0,
        displayLine: `\u2192 ${binName} (system PATH, ${found}${v !== "unknown" ? `, v${v}` : ""})`
      };
    }
  }

  // 2. Determine target version. If we can reach npm we ask for `latest`;
  // otherwise we fall through to whatever's already cached so the user can
  // keep working when the registry is unreachable (corp proxy, npm outage,
  // airplane mode, etc.).
  let target = pin.version;
  let viewError: null | Error = null;
  if (!target && !opts.offline) {
    try {
      target = npmViewLatest(npmExe, pkg);
    } catch (err) {
      viewError = err instanceof Error ? err : new Error(String(err));
    }
  }

  // 3. Cache lookup
  if (target) {
    const cached = findCachedVersion(agentRoot, target, integration);
    if (cached) {
      return {
        source: "cache",
        binPath: cached.binPath,
        version: target,
        packageName: pkg,
        cacheDir: cached.dir,
        prunedCount: 0,
        displayLine: `\u2192 ${binName} (cached, ${displayPath(cached.dir)}, v${target})`
      };
    }
  } else {
    // Either --offline or we couldn't reach npm to ask "what's latest?".
    // Use the newest known-good install on disk.
    const last = pickLastCached(agentRoot, integration);
    if (last) {
      if (viewError) {
        log(`\u26a0 could not reach npm registry to check for updates (${viewError.message}); using cached ${binName} v${last.version}`);
      }
      return {
        source: "cache",
        binPath: last.binPath,
        version: last.version,
        packageName: pkg,
        cacheDir: last.dir,
        prunedCount: 0,
        displayLine: `\u2192 ${binName} (cached fallback, ${displayPath(last.dir)}, v${last.version})`
      };
    }
    if (viewError) {
      throw new Error(`${binName} not installed and could not reach npm registry to download it: ${viewError.message}`);
    }
    throw new Error(`${binName} not installed and no cache available (offline).`);
  }

  if (opts.offline) {
    throw new Error(`${binName}@${target} not in cache and --offline is set.`);
  }

  // 4. Install. We normally install directly into the canonical version
  // directory and write `version.txt` LAST as the completion marker. If an
  // already-corrupted Windows cache is still held open by a running agent,
  // install a complete replacement beside it instead of requiring the user
  // to stop that process.
  log(`\u2192 ${binName} (installing ${pkg}@${target} into ${displayPath(agentRoot)} \u2026)`);
  fs.mkdirSync(agentRoot, { recursive: true });

  const lockFile = path.join(agentRoot, ".lock");
  await acquireFileLock(lockFile, 5 * 60 * 1000);
  try {
    // Re-check after acquiring lock — another invocation may have just installed it.
    const finalDir = path.join(agentRoot, target);
    const recheck = findCachedVersion(agentRoot, target, integration);
    if (recheck) {
      return {
        source: "cache",
        binPath: recheck.binPath,
        version: target,
        packageName: pkg,
        cacheDir: recheck.dir,
        prunedCount: 0,
        displayLine: `\u2192 ${binName} (cached, ${displayPath(recheck.dir)}, v${target})`
      };
    }

    // A markerless cache may predate the completion-marker contract. If its
    // binary still passes the same smoke test used after installation, adopt
    // it in place instead of deleting a potentially running Windows agent.
    const unmarkedBin = findUnmarkedUsableBin(finalDir, integration);
    if (unmarkedBin) {
      fs.writeFileSync(path.join(finalDir, "version.txt"), `${target}\n`);
      return {
        source: "cache",
        binPath: unmarkedBin,
        version: target,
        packageName: pkg,
        cacheDir: finalDir,
        prunedCount: 0,
        displayLine: `\u2192 ${binName} (cached, ${displayPath(finalDir)}, v${target})`
      };
    }

    // Wipe any partial state (missing marker means a previous attempt was
    // interrupted) before we re-run npm into the same prefix.
    let installDir = finalDir;
    if (fs.existsSync(finalDir)) {
      try {
        fs.rmSync(finalDir, { recursive: true, force: true });
      } catch (error) {
        if (!isWindowsCacheInUseError(error)) throw error;
        installDir = fs.mkdtempSync(path.join(agentRoot, `${target}.repair-`));
        log(
          `\u26a0 ${binName} v${target} cache is in use by another Windows process; ` +
          `installing a replacement at ${displayPath(installDir)}`
        );
      }
    }
    fs.mkdirSync(installDir, { recursive: true });

    const spec = `${pkg}@${target}`;
    // Lifecycle scripts stay disabled. Integrations that publish their native
    // executable in an optional platform package declare its package prefix
    // in the registry, allowing the resolver to use that binary directly.
    const installArgs = [
      "install",
      "--prefix",
      installDir,
      "--no-audit",
      "--no-fund",
      "--omit=dev",
      "--include=optional",
      "--ignore-scripts",
      spec
    ];
    const installResult = spawnSyncSafe(npmExe, installArgs, {
      stdio: ["ignore", "inherit", "inherit"]
    });
    if (installResult.status !== 0) {
      cleanupFailedInstall(installDir);
      const msg = installResult.error ? `: ${installResult.error.message}` : "";
      throw new Error(`npm install ${spec} failed (exit ${installResult.status})${msg}`);
    }

    const requiredNativePackage = declaredNativePackageName(installDir, integration);
    const nativeBinaryPackagePrefix = integration.nativeBinaryPackagePrefix;
    if (
      requiredNativePackage &&
      nativeBinaryPackagePrefix &&
      !nativePlatformBinPath(
        installDir,
        nativeBinaryPackagePrefix,
        integration.binName
      )
    ) {
      cleanupFailedInstall(installDir);
      throw new Error(
        `Installed ${spec} did not include required native package ${requiredNativePackage}. ` +
        "npm may have omitted optional dependencies."
      );
    }

    const installedBin = installedBinPath(installDir, integration);
    if (!installedBin || !fs.existsSync(installedBin)) {
      cleanupFailedInstall(installDir);
      throw new Error(`Installed package did not produce a ${binName} bin at ${installDir}`);
    }
    if (probeVersion(installedBin) === null) {
      cleanupFailedInstall(installDir);
      throw new Error(`Smoke test failed: ${installedBin} --version did not exit 0`);
    }

    // Marker file: MUST be the last write. Cache-hit checks key off this.
    fs.writeFileSync(path.join(installDir, "version.txt"), `${target}\n`);

    const pruned = pruneSiblings(agentRoot, installDir);

    return {
      source: "installed",
      binPath: installedBin,
      version: target,
      packageName: pkg,
      cacheDir: installDir,
      prunedCount: pruned,
      displayLine: `\u2192 ${binName} (installed ${pkg}@${target} \u2192 ${displayPath(installDir)}${pruned > 0 ? `, pruned ${pruned} older version${pruned === 1 ? "" : "s"}` : ""})`
    };
  } finally {
    releaseFileLock(lockFile);
  }
}

function cleanupFailedInstall(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort: a stuck handle here means the next run will retry the
    // cleanup before reinstalling. Worst case the user gets a clearer
    // "rmSync failed" error on the next attempt.
  }
}

function findReadyCachedBin(dir: string, integration: AgentIntegration): null | string {
  const bin = installedBinPath(dir, integration);
  if (!bin || !fs.existsSync(bin)) return null;
  // version.txt is written LAST, after the smoke test passes. Missing
  // marker = partial/aborted install; do not treat as a cache hit.
  if (!fs.existsSync(path.join(dir, "version.txt"))) return null;
  return bin;
}

function findUnmarkedUsableBin(
  dir: string,
  integration: AgentIntegration
): null | string {
  if (readVersionMarker(dir) !== null) return null;
  const bin = installedBinPath(dir, integration);
  if (!bin || !fs.existsSync(bin)) return null;
  return probeVersion(bin) === null ? null : bin;
}

function findCachedVersion(
  agentRoot: string,
  version: string,
  integration: AgentIntegration
): null | { dir: string; binPath: string } {
  const canonicalDir = path.join(agentRoot, version);
  if (readVersionMarker(canonicalDir) === version) {
    const canonicalBin = findReadyCachedBin(canonicalDir, integration);
    if (canonicalBin) return { dir: canonicalDir, binPath: canonicalBin };
  }
  if (!fs.existsSync(agentRoot)) return null;
  for (const entry of fs.readdirSync(agentRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === version) continue;
    const dir = path.join(agentRoot, entry.name);
    if (readVersionMarker(dir) !== version) continue;
    const binPath = findReadyCachedBin(dir, integration);
    if (binPath) return { dir, binPath };
  }
  return null;
}

function readVersionMarker(dir: string): null | string {
  try {
    const version = fs.readFileSync(path.join(dir, "version.txt"), "utf8").trim();
    return version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

function isWindowsCacheInUseError(error: unknown): boolean {
  if (process.platform !== "win32") return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY" || code === "ENOTEMPTY";
}

function defaultNpmExecutable(): string {
  const override = process.env.COPILLM_NPM_EXECUTABLE;
  if (override && override.trim().length > 0) {
    return override;
  }
  if (process.platform === "win32") {
    // npm ships as both `npm.cmd` and `npm.ps1` on Windows. We need to know
    // up-front so `spawnSyncSafe` routes the call through cmd.exe with safe
    // quoting (CreateProcess can't exec a .cmd batch directly). Walking PATH
    // here keeps callers from having to know the difference.
    const found = findOnPath("npm");
    if (found) return found;
  }
  return "npm";
}

function binPathInPrefix(prefix: string, binName: string): null | string {
  const candidates = process.platform === "win32"
    ? [
        path.join(prefix, "node_modules", ".bin", `${binName}.cmd`),
        path.join(prefix, "node_modules", ".bin", `${binName}.exe`),
        path.join(prefix, "node_modules", ".bin", binName)
      ]
    : [path.join(prefix, "node_modules", ".bin", binName)];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function installedBinPath(
  prefix: string,
  integration: AgentIntegration
): null | string {
  if (integration.nativeBinaryPackagePrefix) {
    const nativeBin = nativePlatformBinPath(
      prefix,
      integration.nativeBinaryPackagePrefix,
      integration.binName
    );
    if (nativeBin) return nativeBin;
    if (declaredNativePackageName(prefix, integration)) return null;
  }
  return binPathInPrefix(prefix, integration.binName);
}

function nativePlatformBinPath(
  prefix: string,
  packagePrefix: string,
  binName: string
): null | string {
  const platformKey = nativePlatformKey();
  if (!platformKey) return null;
  const packageName = `${packagePrefix}-${platformKey}`;
  const packageDir = path.join(prefix, "node_modules", ...packageName.split("/"));
  const binary = path.join(
    packageDir,
    process.platform === "win32" ? `${binName}.exe` : binName
  );
  return fs.existsSync(binary) ? binary : null;
}

function declaredNativePackageName(
  prefix: string,
  integration: AgentIntegration
): null | string {
  if (!integration.nativeBinaryPackagePrefix) return null;
  const platformKey = nativePlatformKey();
  if (!platformKey) return null;
  const nativePackage = `${integration.nativeBinaryPackagePrefix}-${platformKey}`;
  const wrapperPackagePath = path.join(
    prefix,
    "node_modules",
    ...integration.npmPackage.split("/"),
    "package.json"
  );
  try {
    const wrapper = JSON.parse(fs.readFileSync(wrapperPackagePath, "utf8")) as {
      optionalDependencies?: unknown;
    };
    if (
      typeof wrapper.optionalDependencies === "object" &&
      wrapper.optionalDependencies !== null &&
      Object.hasOwn(wrapper.optionalDependencies, nativePackage)
    ) {
      return nativePackage;
    }
  } catch {
    // A missing or malformed wrapper manifest is handled by the bin checks.
  }
  return null;
}

let cachedNativePlatformKey: undefined | null | string;

function nativePlatformKey(): null | string {
  if (cachedNativePlatformKey !== undefined) return cachedNativePlatformKey;
  cachedNativePlatformKey = computeNativePlatformKey();
  return cachedNativePlatformKey;
}

function computeNativePlatformKey(): null | string {
  let architecture = process.arch;
  if (process.platform === "darwin" && architecture === "x64" && isRosetta()) {
    architecture = "arm64";
  }
  if (process.platform === "linux") {
    return `linux-${architecture}${isMusl() ? "-musl" : ""}`;
  }
  if (process.platform === "android") {
    return `linux-${architecture}-android`;
  }
  if (process.platform === "darwin" || process.platform === "win32") {
    return `${process.platform}-${architecture}`;
  }
  return null;
}

function isMusl(): boolean {
  const report = process.report?.getReport?.() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  return report !== undefined && report.header?.glibcVersionRuntime === undefined;
}

function isRosetta(): boolean {
  const result = spawnSync("sysctl", ["-n", "sysctl.proc_translated"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  return result.status === 0 && result.stdout.trim() === "1";
}

function findOnPath(name: string): null | string {
  const PATH = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase())
    : [""];
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      if (statIsFile(candidate)) return candidate;
    }
  }
  return null;
}

function statIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function probeVersion(binPath: string): null | string {
  const result = spawnSync(binPath, ["--version"], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 8_000,
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(binPath)
  });
  if (result.status !== 0) return null;
  const out = `${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`.trim();
  const m = out.match(/(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/);
  return m ? m[1] : (out.length > 0 ? out.split(/\s+/)[0] : null);
}

function npmViewLatest(npmExe: string, pkg: string): string {
  const result = spawnSyncSafe(npmExe, ["view", pkg, "version"], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000
  });
  if (result.status !== 0) {
    const err = result.stderr?.toString() ?? "(no stderr)";
    const errMsg = result.error ? `: ${result.error.message}` : "";
    throw new Error(`Failed to query latest version of ${pkg} via npm view: ${err.trim()}${errMsg}`);
  }
  const v = result.stdout?.toString().trim();
  if (!v) throw new Error(`Empty response from \`npm view ${pkg} version\``);
  return v;
}

/**
 * Spawn a child process synchronously without ever falling back to
 * `shell: true`. On Windows, npm ships as `npm.cmd` and Node refuses to
 * `CreateProcess` a batch file directly, so we route through `cmd.exe` with
 * the same quoting helpers `windowsSpawn.ts` uses for agent launches — that
 * way an argument like `1.0.0 & rm -rf /` reaches npm as a single arg
 * instead of getting parsed as a cmd.exe separator (Node DEP0190).
 */
function spawnSyncSafe(
  file: string,
  args: string[],
  options: Omit<SpawnSyncOptionsWithBufferEncoding, "shell" | "windowsVerbatimArguments">
) {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(file)) {
    return spawnSync(file, args, { ...options, shell: false });
  }
  const { command, args: cmdArgs } = buildWindowsCmdInvocation(file, args);
  return spawnSync(command, cmdArgs, {
    ...options,
    shell: false,
    windowsVerbatimArguments: true
  });
}

function pickLastCached(
  agentRoot: string,
  integration: AgentIntegration
): null | { dir: string; binPath: string; version: string } {
  if (!fs.existsSync(agentRoot)) return null;
  const cached = fs
    .readdirSync(agentRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => {
      const dir = path.join(agentRoot, e.name);
      return { dir, version: readVersionMarker(dir) };
    })
    .filter((entry): entry is { dir: string; version: string } => entry.version !== null)
    .sort((a, b) => compareVersionsDescending(a.version, b.version));
  for (const entry of cached) {
    const dir = entry.dir;
    const bin = findReadyCachedBin(dir, integration);
    if (bin) return { dir, binPath: bin, version: entry.version };
  }
  return null;
}

function compareVersionsDescending(a: string, b: string): number {
  const pa = a.split(/[.\-+]/).map((n) => parseInt(n, 10));
  const pb = b.split(/[.\-+]/).map((n) => parseInt(n, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = Number.isFinite(pa[i]) ? pa[i] : 0;
    const db = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (da !== db) return db - da;
  }
  return b.localeCompare(a);
}

function pruneSiblings(agentRoot: string, keepDir: string): number {
  let pruned = 0;
  const oneHourMs = 60 * 60 * 1000;
  const now = Date.now();
  for (const entry of fs.readdirSync(agentRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sub = path.join(agentRoot, entry.name);
    if (sub === keepDir) continue;
    const isOrphanedRepair = entry.name.includes(".repair-") && readVersionMarker(sub) === null;
    if (entry.name.startsWith(".staging-") || isOrphanedRepair) {
      try {
        const mtime = fs.statSync(sub).mtimeMs;
        if (now - mtime > oneHourMs) {
          fs.rmSync(sub, { recursive: true, force: true });
        }
      } catch {
        // best effort
      }
      continue;
    }
    // Windows does not allow deleting a running executable. Recursive
    // deletion can remove most of an active agent version before failing at
    // the locked .exe, corrupting that cache for the next launch.
    if (process.platform === "win32") continue;
    if (entry.name.startsWith(".")) continue;
    try {
      fs.rmSync(sub, { recursive: true, force: true });
      pruned += 1;
    } catch {
      // best effort
    }
  }
  return pruned;
}

async function acquireFileLock(file: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (e: unknown) {
      const code = (e as { code?: string }).code;
      if (code !== "EEXIST") throw e;
      try {
        const holder = parseInt(fs.readFileSync(file, "utf8").trim(), 10);
        if (Number.isFinite(holder) && !pidAlive(holder)) {
          fs.unlinkSync(file);
          continue;
        }
      } catch {
        // best effort
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Could not acquire lock at ${file} within ${timeoutMs}ms`);
      }
      await sleep(200);
    }
  }
}

function releaseFileLock(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // best effort
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function displayPath(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home && p.startsWith(home)) {
    return p.replace(home, "~");
  }
  return p;
}
