import type { PackageInfo } from "../../config/packageInfo.js";
import { fetchLatestNpmVersion, isNewerVersion, parseBooleanOverride } from "../updateNotifier.js";

const DEFAULT_REGISTRY_TIMEOUT_MS = 1_500;

export interface VersionStatusFields {
  daemon_version: string | null;
  cli_version: string;
  latest_version: string | null;
  update_available: boolean;
  /**
   * Short, human-readable hint shown alongside the version line in
   * `copillm status` text mode. `null` when everything is in sync OR when
   * the daemon isn't running (status will surface a different message in
   * that case).
   *
   * Examples:
   *   - "restart to apply cli v0.4.3"
   *   - "newer version available: v0.4.4 (npm install -g copillm)"
   *   - "newer version available: v0.4.4; restart to apply cli v0.4.3"
   *   - "restart to start reporting version" (old daemon that predates this field)
   */
  hint: string | null;
}

export interface ComputeVersionStatusOptions {
  cliPackageInfo: PackageInfo;
  /** What the running daemon reports via `/healthz`. `null` when the daemon
   *  isn't running, or when an older daemon doesn't include the field. */
  daemonVersion: string | null;
  /** Whether the daemon process itself is currently running. Drives whether
   *  the "restart to apply" hint applies — a stopped daemon doesn't have
   *  state to apply. */
  daemonRunning: boolean;
  /** Inject `process.env` shape for tests; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Set true to bypass the npm registry lookup. */
  noRegistryCheck?: boolean;
  /** Test injection for the network fetch. */
  fetchImpl?: typeof fetch;
  /** Overrides the npm registry URL; respects `COPILLM_UPDATE_REGISTRY_URL` env when unset. */
  registryUrl?: string;
  /** Per-request timeout for the registry lookup. */
  timeoutMs?: number;
}

/**
 * Resolve the three version data points (daemon, cli, latest-on-npm) and
 * compute the `copillm status` actionable hint from them. Pulled out of the
 * status command so it stays unit-testable end-to-end without spinning up a
 * real proxy.
 *
 * Opt-out precedence (any of these skips the npm lookup):
 *   - `noRegistryCheck` argument (driven by the `--no-registry-check` flag)
 *   - `NO_UPDATE_NOTIFIER` env (matches the update-notifier convention)
 *   - `COPILLM_UPDATE_CHECK=0|false|no|off`
 *
 * The registry lookup itself is best-effort: timeouts / network errors
 * silently yield `latest_version: null`. We do *not* surface a "registry
 * unreachable" message in status — that would be more noise than signal for
 * a daemon-status command.
 */
export async function computeVersionStatus(options: ComputeVersionStatusOptions): Promise<VersionStatusFields> {
  const env = options.env ?? process.env;
  const cliVersion = options.cliPackageInfo.version;
  const daemonVersion = options.daemonVersion;

  const registryCheckDisabled =
    options.noRegistryCheck === true ||
    "NO_UPDATE_NOTIFIER" in env ||
    parseBooleanOverride(env.COPILLM_UPDATE_CHECK) === false;

  let latestVersion: string | null = null;
  if (!registryCheckDisabled) {
    latestVersion = await fetchLatestNpmVersion(options.cliPackageInfo.name, {
      fetchImpl: options.fetchImpl,
      registryUrl: options.registryUrl ?? env.COPILLM_UPDATE_REGISTRY_URL,
      timeoutMs: options.timeoutMs ?? DEFAULT_REGISTRY_TIMEOUT_MS
    });
  }

  const daemonStale = options.daemonRunning && daemonVersion !== null && isNewerVersion(cliVersion, daemonVersion);
  const cliStale = latestVersion !== null && isNewerVersion(latestVersion, cliVersion);
  const daemonReportsNoVersion = options.daemonRunning && daemonVersion === null;

  return {
    daemon_version: daemonVersion,
    cli_version: cliVersion,
    latest_version: latestVersion,
    update_available: daemonStale || cliStale,
    hint: buildVersionHint({ daemonStale, cliStale, daemonReportsNoVersion, cliVersion, latestVersion })
  };
}

interface BuildHintInput {
  daemonStale: boolean;
  cliStale: boolean;
  daemonReportsNoVersion: boolean;
  cliVersion: string;
  latestVersion: string | null;
}

/**
 * Pure helper. Public for direct unit testing of the messaging matrix.
 */
export function buildVersionHint(input: BuildHintInput): string | null {
  const parts: string[] = [];
  if (input.cliStale && input.latestVersion !== null) {
    parts.push(`newer version available: v${input.latestVersion} (npm install -g copillm)`);
  }
  if (input.daemonStale) {
    parts.push(`restart to apply cli v${input.cliVersion}`);
  }
  if (parts.length === 0 && input.daemonReportsNoVersion) {
    return "restart to start reporting version";
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join("; ");
}
