import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { getCopillmHome } from "../config/home.js";

export type AgentName = "codex" | "claude" | "pi";
export type ResolveSource = "path" | "cache" | "installed";

const NPM_PACKAGES: Record<AgentName, string> = {
  codex: "@openai/codex",
  claude: "@anthropic-ai/claude-code",
  pi: "@earendil-works/pi-coding-agent"
};

const BIN_NAMES: Record<AgentName, string> = {
  codex: "codex",
  claude: "claude",
  pi: "pi"
};

export interface ResolveOptions {
  pinnedSpec?: string;
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
  return NPM_PACKAGES[agent];
}

export function binNameFor(agent: AgentName): string {
  return BIN_NAMES[agent];
}

interface ParsedPin {
  packageName: string;
  version: null | string;
}

export function parsePinSpec(agent: AgentName, raw: string): ParsedPin {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { packageName: NPM_PACKAGES[agent], version: null };
  }
  // Bare version like "1.4.7" or "^1.0.0"
  if (/^[\d^~><=*]/.test(trimmed)) {
    return { packageName: NPM_PACKAGES[agent], version: trimmed };
  }
  // <pkg>@<version>; tolerate scoped pkgs starting with @
  const isScoped = trimmed.startsWith("@");
  const lastAt = trimmed.lastIndexOf("@");
  if (lastAt > 0 && (!isScoped || lastAt > 0)) {
    const pkg = trimmed.slice(0, lastAt);
    const ver = trimmed.slice(lastAt + 1);
    if (pkg && ver) {
      return { packageName: pkg, version: ver };
    }
  }
  return { packageName: trimmed, version: null };
}

export async function resolveAgent(agent: AgentName, opts: ResolveOptions = {}): Promise<ResolveResult> {
  const cacheRoot = opts.cacheRoot ?? path.join(getCopillmHome(), "bin");
  const npmExe = opts.npmExecutable ?? defaultNpmExecutable();
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  const pin = opts.pinnedSpec ? parsePinSpec(agent, opts.pinnedSpec) : { packageName: NPM_PACKAGES[agent], version: null };
  const pkg = pin.packageName;
  const binName = BIN_NAMES[agent];
  const agentRoot = path.join(cacheRoot, agent);

  // 1. PATH lookup (skipped when user pinned a specific version)
  if (!pin.version && opts.preferPath !== false) {
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

  // 2. Determine target version
  let target = pin.version;
  if (!target && !opts.offline) {
    target = npmViewLatest(npmExe, pkg);
  }

  // 3. Cache lookup
  if (target) {
    const cachedDir = path.join(agentRoot, target);
    const cachedBin = binPathInPrefix(cachedDir, binName);
    if (cachedBin && fs.existsSync(cachedBin)) {
      return {
        source: "cache",
        binPath: cachedBin,
        version: target,
        packageName: pkg,
        cacheDir: cachedDir,
        prunedCount: 0,
        displayLine: `\u2192 ${binName} (cached, ${displayPath(cachedDir)}, v${target})`
      };
    }
  } else {
    const last = pickLastCached(agentRoot, binName);
    if (last) {
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
    throw new Error(`${binName} not installed and no cache available (offline).`);
  }

  if (opts.offline) {
    throw new Error(`${binName}@${target} not in cache and --offline is set.`);
  }

  // 4. Install
  log(`\u2192 ${binName} (installing ${pkg}@${target} into ${displayPath(agentRoot)} \u2026)`);
  fs.mkdirSync(agentRoot, { recursive: true });

  const lockFile = path.join(agentRoot, ".lock");
  await acquireFileLock(lockFile, 5 * 60 * 1000);
  try {
    // Re-check after acquiring lock — another invocation may have just installed it.
    const finalDir = path.join(agentRoot, target);
    const recheckBin = binPathInPrefix(finalDir, binName);
    if (recheckBin && fs.existsSync(recheckBin)) {
      return {
        source: "cache",
        binPath: recheckBin,
        version: target,
        packageName: pkg,
        cacheDir: finalDir,
        prunedCount: 0,
        displayLine: `\u2192 ${binName} (cached, ${displayPath(finalDir)}, v${target})`
      };
    }

    const stagingDir = path.join(agentRoot, `.staging-${sanitize(target)}-${process.pid}`);
    if (fs.existsSync(stagingDir)) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
    fs.mkdirSync(stagingDir, { recursive: true });

    const spec = `${pkg}@${target}`;
    const installResult = spawnSync(
      npmExe,
      ["install", "--prefix", stagingDir, "--no-audit", "--no-fund", "--omit=dev", spec],
      {
        stdio: ["ignore", "inherit", "inherit"],
        shell: process.platform === "win32"
      }
    );
    if (installResult.status !== 0) {
      const msg = installResult.error ? `: ${installResult.error.message}` : "";
      throw new Error(`npm install ${spec} failed (exit ${installResult.status})${msg}`);
    }

    const stagedBin = binPathInPrefix(stagingDir, binName);
    if (!stagedBin || !fs.existsSync(stagedBin)) {
      throw new Error(`Installed package did not produce a ${binName} bin at ${stagingDir}`);
    }
    if (probeVersion(stagedBin) === null) {
      throw new Error(`Smoke test failed: ${stagedBin} --version did not exit 0`);
    }

    if (fs.existsSync(finalDir)) {
      fs.rmSync(finalDir, { recursive: true, force: true });
    }
    fs.renameSync(stagingDir, finalDir);
    fs.writeFileSync(path.join(finalDir, "version.txt"), `${target}\n`);

    const pruned = pruneSiblings(agentRoot, target);

    const finalBin = binPathInPrefix(finalDir, binName);
    if (!finalBin) {
      throw new Error(`Final install missing bin at ${finalDir}`);
    }
    return {
      source: "installed",
      binPath: finalBin,
      version: target,
      packageName: pkg,
      cacheDir: finalDir,
      prunedCount: pruned,
      displayLine: `\u2192 ${binName} (installed ${pkg}@${target} \u2192 ${displayPath(finalDir)}${pruned > 0 ? `, pruned ${pruned} older version${pruned === 1 ? "" : "s"}` : ""})`
    };
  } finally {
    releaseFileLock(lockFile);
  }
}

function defaultNpmExecutable(): string {
  return process.env.COPILLM_NPM_EXECUTABLE && process.env.COPILLM_NPM_EXECUTABLE.trim().length > 0
    ? process.env.COPILLM_NPM_EXECUTABLE
    : "npm";
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
  const result = spawnSync(npmExe, ["view", pkg, "version"], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
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

function pickLastCached(agentRoot: string, binName: string): null | { dir: string; binPath: string; version: string } {
  if (!fs.existsSync(agentRoot)) return null;
  const versions = fs
    .readdirSync(agentRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort((a, b) => compareVersionsDescending(a, b));
  for (const v of versions) {
    const dir = path.join(agentRoot, v);
    const bin = binPathInPrefix(dir, binName);
    if (bin) return { dir, binPath: bin, version: v };
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

function pruneSiblings(agentRoot: string, keepVersion: string): number {
  let pruned = 0;
  const oneHourMs = 60 * 60 * 1000;
  const now = Date.now();
  for (const entry of fs.readdirSync(agentRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === keepVersion) continue;
    const sub = path.join(agentRoot, entry.name);
    if (entry.name.startsWith(".staging-")) {
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

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}
