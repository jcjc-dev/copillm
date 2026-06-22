import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { PackageInfo } from "../../config/packageInfo.js";
import { fetchLatestNpmVersion, isNewerVersion } from "../updateNotifier.js";
import { buildWindowsCmdInvocation } from "../windowsSpawn.js";

/**
 * Self-update support for `copillm restart`. Restart respawns the daemon from
 * the CLI's own entry path, and `npm install -g` overwrites the files at that
 * path in place — so if we update the global package *before* respawning, the
 * fresh daemon runs the new code automatically.
 *
 * This is strictly best-effort: it never throws and never blocks a restart. It
 * no-ops when copillm isn't running from a global npm install (dev/dist runs),
 * when the registry can't be reached, when already up to date, or when the
 * `npm install` itself fails (e.g. a global prefix that needs elevated perms).
 */
export type SelfUpdateResult =
  | { status: "updated"; from: string; to: string }
  | { status: "up-to-date"; version: string }
  | { status: "skipped"; reason: "not-global" | "no-latest" }
  | { status: "failed"; from: string; to: string; detail: string };

export interface SelfUpdateDeps {
  /** Resolve the latest published version, or null when unreachable. */
  fetchLatest?: (packageName: string) => Promise<string | null>;
  /** Run the global install; returns ok + a short detail on failure. */
  runInstall?: (packageName: string, version: string) => { ok: boolean; detail: string };
  /** Module URL used to detect a global npm runtime (test seam). */
  moduleUrl?: string;
  env?: NodeJS.ProcessEnv;
}

export async function selfUpdateToLatest(
  packageInfo: PackageInfo,
  deps: SelfUpdateDeps = {}
): Promise<SelfUpdateResult> {
  const env = deps.env ?? process.env;
  const moduleUrl = deps.moduleUrl ?? import.meta.url;

  if (!isGlobalNpmRuntime(moduleUrl, packageInfo.name)) {
    return { status: "skipped", reason: "not-global" };
  }

  const fetchLatest =
    deps.fetchLatest ??
    ((name: string) => fetchLatestNpmVersion(name, { registryUrl: env.COPILLM_UPDATE_REGISTRY_URL }));

  let latest: string | null = null;
  try {
    latest = await fetchLatest(packageInfo.name);
  } catch {
    latest = null;
  }
  if (!latest) {
    return { status: "skipped", reason: "no-latest" };
  }
  if (!isNewerVersion(latest, packageInfo.version)) {
    return { status: "up-to-date", version: packageInfo.version };
  }

  const runInstall = deps.runInstall ?? defaultRunInstall;
  let outcome: { ok: boolean; detail: string };
  try {
    outcome = runInstall(packageInfo.name, latest);
  } catch (error) {
    outcome = { ok: false, detail: error instanceof Error ? error.message : "npm install failed" };
  }
  if (!outcome.ok) {
    return { status: "failed", from: packageInfo.version, to: latest, detail: outcome.detail };
  }
  return { status: "updated", from: packageInfo.version, to: latest };
}

/** One-line human summary, or null when there's nothing worth printing. */
export function describeSelfUpdate(result: SelfUpdateResult, packageName: string): string | null {
  switch (result.status) {
    case "updated":
      return `Updated ${packageName} ${result.from} -> ${result.to}.`;
    case "up-to-date":
      return `${packageName} is already up to date (${result.version}).`;
    case "failed":
      return `Self-update to ${result.to} failed; continuing on ${result.from}. (${result.detail})`;
    case "skipped":
      // `no-latest` means the registry was unreachable — worth a quiet note;
      // `not-global` (dev/dist runs) stays silent.
      return result.reason === "no-latest"
        ? "Could not check for updates; continuing on the installed version."
        : null;
  }
}

function defaultRunInstall(packageName: string, version: string): { ok: boolean; detail: string } {
  // Drop `shell: true` (Node DEP0190): on Windows we route `npm.cmd` through
  // cmd.exe with `windowsVerbatimArguments` so the version string can never
  // be reinterpreted as shell metacharacters. `--ignore-scripts` blocks
  // preinstall/install/postinstall scripts so a hypothetical compromised npm
  // mirror can't run code on the user before the smoke test catches an
  // unusable package.
  const args = ["install", "-g", "--ignore-scripts", `${packageName}@${version}`];
  const baseOpts = {
    encoding: "utf8" as const,
    timeout: 120_000,
    stdio: ["ignore", "ignore", "pipe"] as ["ignore", "ignore", "pipe"]
  };
  const result =
    process.platform === "win32"
      ? (() => {
          const { command, args: cmdArgs } = buildWindowsCmdInvocation("npm.cmd", args);
          return spawnSync(command, cmdArgs, { ...baseOpts, shell: false, windowsVerbatimArguments: true });
        })()
      : spawnSync("npm", args, { ...baseOpts, shell: false });
  if (result.error) {
    return { ok: false, detail: result.error.message };
  }
  if (result.status === 0) {
    return { ok: true, detail: "" };
  }
  const stderr = (result.stderr ?? "").trim();
  const tail = stderr ? stderr.split("\n").slice(-2).join(" ") : `npm exited with code ${result.status ?? "null"}`;
  return { ok: false, detail: tail };
}

function isGlobalNpmRuntime(moduleUrl: string, packageName: string): boolean {
  // Prefer a real filesystem path, but fall back to the raw URL when
  // `fileURLToPath` can't convert it (e.g. a non-Windows-style `file://` URL on
  // Windows). We only need to scan for the `node_modules/<pkg>` marker, and the
  // regex handles both `\` and `/` separators so the check is platform-agnostic.
  let candidate: string;
  try {
    candidate = fileURLToPath(moduleUrl);
  } catch {
    candidate = moduleUrl;
  }
  const normalized = candidate.replace(/\\/g, "/").toLowerCase();
  return normalized.includes(`/node_modules/${packageName.toLowerCase()}/`);
}
