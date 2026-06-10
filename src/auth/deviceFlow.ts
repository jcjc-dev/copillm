import { setTimeout as defaultSleep } from "node:timers/promises";

import { isRetryableStatus, isRetryableTransportError, retryDelayMs } from "../server/upstream/retryPolicy.js";

const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

/**
 * Per-attempt timeout for the init POST + each poll POST. GitHub's device-
 * flow endpoints typically respond in <500ms; 10s leaves room for slow
 * networks without freezing the login flow for a full minute on a network
 * black-hole. Previously the fetches had no timeout at all.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_INIT_MAX_ATTEMPTS = 3;

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

interface AccessTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

/**
 * Optional dependency-injection seam for tests. Production callers pass
 * nothing and we use the global `fetch` + `node:timers/promises` sleep.
 */
export interface DeviceFlowDeps {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Stream to write the "Open URL and enter code" prompt. Defaults to stdout. */
  stdout?: { write: (chunk: string) => void };
  /** Per-attempt timeout for both the init POST and each poll POST. */
  fetchTimeoutMs?: number;
  /** Init POST retry budget. The poll uses the device-flow `deadline` as its budget. */
  initMaxAttempts?: number;
}

export async function loginViaDeviceFlow(deps?: DeviceFlowDeps): Promise<string> {
  const fetchImpl = deps?.fetchImpl ?? ((input, init) => fetch(input, init));
  const sleepImpl = deps?.sleepImpl ?? ((ms) => defaultSleep(ms));
  const stdout = deps?.stdout ?? process.stdout;
  const fetchTimeoutMs = deps?.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const initMaxAttempts = deps?.initMaxAttempts ?? DEFAULT_INIT_MAX_ATTEMPTS;

  // Phase 1: init POST. Retried up to `initMaxAttempts` on transient HTTP
  // statuses + transport errors. A single 502 used to abort the whole
  // device-flow login — the user would have to start over from a new code.
  const payload = await initDeviceFlow({ fetchImpl, sleepImpl, fetchTimeoutMs, initMaxAttempts });

  const verificationUrl = payload.verification_uri_complete ?? payload.verification_uri;
  stdout.write(`Open ${verificationUrl} and enter code ${payload.user_code}\n`);

  // Phase 2: poll loop. The device-flow `expires_in` is the natural deadline.
  // Inside the loop, transient HTTP / transport failures `continue` instead
  // of throwing — the loop's own `await sleep(intervalMs)` IS the backoff,
  // and the `deadline` IS the budget. Previously, a single 503 from
  // `github.com/login/oauth/access_token` aborted the whole login.
  const deadline = Date.now() + payload.expires_in * 1000;
  let intervalMs = Math.max(1, payload.interval) * 1000;

  while (Date.now() < deadline) {
    await sleepImpl(intervalMs);
    let poll: Response;
    try {
      poll = await fetchImpl(ACCESS_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          client_id: GITHUB_CLIENT_ID,
          device_code: payload.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code"
        }),
        signal: AbortSignal.timeout(fetchTimeoutMs)
      });
    } catch (error) {
      if (isRetryableTransportError(error)) {
        // Transient — the next loop iteration will retry naturally. Don't
        // abort the user's login over an ECONNRESET / DNS soft-fail.
        continue;
      }
      throw error;
    }
    if (!poll.ok) {
      // Transient HTTP errors (5xx, 429) keep polling — same justification
      // as transport errors. Permanent errors (4xx other than 429) abort,
      // because the device code itself is bad and no amount of polling
      // will fix it.
      if (isRetryableStatus(poll.status)) {
        await discardResponseBody(poll);
        continue;
      }
      throw new Error(`Access token poll failed (${poll.status}).`);
    }
    const tokenPayload = parseAccessTokenResponse((await poll.json()) as unknown);
    if (tokenPayload.access_token) {
      return tokenPayload.access_token;
    }
    if (tokenPayload.error === "authorization_pending") {
      continue;
    }
    if (tokenPayload.error === "slow_down") {
      intervalMs += 1000;
      continue;
    }
    if (tokenPayload.error === "expired_token") {
      throw new Error("Device code expired before authorization completed.");
    }
    if (tokenPayload.error === "access_denied") {
      throw new Error("Authorization was denied.");
    }
    const description = tokenPayload.error_description ? ` (${tokenPayload.error_description})` : "";
    throw new Error(`Unexpected OAuth polling error: ${tokenPayload.error ?? "unknown"}${description}`);
  }
  throw new Error("Device authorization timed out.");
}

/**
 * Init POST with bounded retries. Retries on retryable HTTP statuses (5xx,
 * 429, 408, 409, 425) and on transient transport errors (ECONNRESET, DNS
 * soft-fails, undici timeouts). Fast-fails on 4xx-other so a misconfigured
 * client_id or missing scope shows up immediately instead of after three
 * pointless retries.
 *
 * Throws the last error if the budget is exhausted. The wrapping
 * `loginViaDeviceFlow` does not retry the init separately — this is the
 * only init retry layer.
 */
async function initDeviceFlow(opts: {
  fetchImpl: typeof fetch;
  sleepImpl: (ms: number) => Promise<void>;
  fetchTimeoutMs: number;
  initMaxAttempts: number;
}): Promise<DeviceCodeResponse> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= opts.initMaxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await opts.fetchImpl(DEVICE_CODE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ client_id: GITHUB_CLIENT_ID, scope: "read:user" }),
        signal: AbortSignal.timeout(opts.fetchTimeoutMs)
      });
    } catch (error) {
      lastError = error;
      if (isRetryableTransportError(error) && attempt < opts.initMaxAttempts) {
        await opts.sleepImpl(retryDelayMs(attempt));
        continue;
      }
      throw error;
    }

    if (response.ok) {
      return parseDeviceCodeResponse((await response.json()) as unknown);
    }

    lastError = new Error(`Device flow init failed (${response.status}).`);

    if (isRetryableStatus(response.status) && attempt < opts.initMaxAttempts) {
      await discardResponseBody(response);
      await opts.sleepImpl(retryDelayMs(attempt));
      continue;
    }

    throw lastError;
  }
  // Unreachable: every iteration either returns, throws, or continues
  // (with continue gated on `attempt < initMaxAttempts`). Defend anyway.
  throw lastError ?? new Error("Device flow init exhausted retries without error context.");
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // Best-effort body drain; ignore failures so we don't surface a
    // response-cleanup error in place of the real one we already captured.
  }
}

function parseDeviceCodeResponse(value: unknown): DeviceCodeResponse {
  if (!value || typeof value !== "object") {
    throw new Error("Device flow init returned an invalid payload.");
  }
  const payload = value as Partial<DeviceCodeResponse>;
  if (
    typeof payload.device_code !== "string" ||
    typeof payload.user_code !== "string" ||
    typeof payload.verification_uri !== "string" ||
    typeof payload.expires_in !== "number" ||
    typeof payload.interval !== "number"
  ) {
    throw new Error("Device flow init response is missing required fields.");
  }
  if (payload.verification_uri_complete !== undefined && typeof payload.verification_uri_complete !== "string") {
    throw new Error("Device flow init response contains an invalid verification_uri_complete field.");
  }
  return payload as DeviceCodeResponse;
}

function parseAccessTokenResponse(value: unknown): AccessTokenResponse {
  if (!value || typeof value !== "object") {
    throw new Error("Device flow poll returned an invalid payload.");
  }
  const payload = value as Partial<AccessTokenResponse>;
  if (payload.access_token !== undefined && typeof payload.access_token !== "string") {
    throw new Error("Device flow poll response contains an invalid access_token field.");
  }
  if (payload.error !== undefined && typeof payload.error !== "string") {
    throw new Error("Device flow poll response contains an invalid error field.");
  }
  if (payload.error_description !== undefined && typeof payload.error_description !== "string") {
    throw new Error("Device flow poll response contains an invalid error_description field.");
  }
  return payload as AccessTokenResponse;
}
