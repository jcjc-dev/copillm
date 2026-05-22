const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

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

export async function loginViaDeviceFlow(): Promise<string> {
  const start = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: GITHUB_CLIENT_ID, scope: "read:user" })
  });
  if (!start.ok) {
    throw new Error(`Device flow init failed (${start.status}).`);
  }
  const payload = parseDeviceCodeResponse((await start.json()) as unknown);
  const verificationUrl = payload.verification_uri_complete ?? payload.verification_uri;
  process.stdout.write(`Open ${verificationUrl} and enter code ${payload.user_code}\n`);

  const deadline = Date.now() + payload.expires_in * 1000;
  let intervalMs = Math.max(1, payload.interval) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const poll = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: GITHUB_CLIENT_ID,
        device_code: payload.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code"
      })
    });
    if (!poll.ok) {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
