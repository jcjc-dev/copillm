import fs from "node:fs";

/**
 * Pi-flavored client. copillm owns pi's config dir via the `PI_CODING_AGENT_DIR`
 * override, so at launch pi reads `<PI_CODING_AGENT_DIR>/models.json` (under
 * COPILLM_HOME) and uses the `baseUrl` + `apiKey` from the first matching
 * provider. We mirror that path exactly here so the e2e test exercises the same
 * wiring a real pi launch would.
 */

export interface PiProviderConfig {
  baseUrl: string;
  api: "anthropic-messages" | "openai-completions" | "openai-responses";
  apiKey: string;
  models: Array<{ id: string; contextWindow?: number; maxTokens?: number }>;
}

export interface PiModelsConfig {
  providers: Record<string, PiProviderConfig>;
}

export interface PiLikeChatResult {
  fullText: string;
  modelInResponse: null | string;
  eventCount: number;
  stopReason: null | string;
  inputTokens: null | number;
  outputTokens: null | number;
}

export function readPiModelsConfig(configPath: string): PiModelsConfig {
  const raw = fs.readFileSync(configPath, "utf8");
  return JSON.parse(raw) as PiModelsConfig;
}

export function pickPiProvider(
  cfg: PiModelsConfig,
  providerId: string,
  expectedApi: PiProviderConfig["api"] = "anthropic-messages"
): PiProviderConfig {
  const provider = cfg.providers[providerId];
  if (!provider) {
    throw new Error(`pi models.json missing provider '${providerId}'; got: ${Object.keys(cfg.providers).join(", ") || "<none>"}`);
  }
  if (provider.api !== expectedApi) {
    throw new Error(`pi provider '${providerId}' has unexpected api '${provider.api}', expected '${expectedApi}'`);
  }
  return provider;
}

export async function piLikeChat(input: {
  provider: PiProviderConfig;
  model: string;
  prompt: string;
}): Promise<PiLikeChatResult> {
  const response = await fetch(`${input.provider.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.provider.apiKey}`,
      "x-api-key": input.provider.apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: input.model,
      max_tokens: 256,
      stream: true,
      messages: [{ role: "user", content: input.prompt }]
    })
  });
  if (!response.ok || !response.body) {
    throw new Error(`pi chat failed: ${response.status}`);
  }
  let fullText = "";
  let modelInResponse: null | string = null;
  let stopReason: null | string = null;
  let inputTokens: null | number = null;
  let outputTokens: null | number = null;
  let eventCount = 0;
  for await (const event of parseSseStream(response.body)) {
    eventCount += 1;
    const data = safeParseJson(event.data);
    if (!data || typeof data !== "object") continue;
    const obj = data as Record<string, unknown>;
    const type = typeof obj.type === "string" ? obj.type : event.event;
    if (type === "message_start") {
      const message = obj.message as { model?: string; usage?: { input_tokens?: number } } | undefined;
      if (typeof message?.model === "string") modelInResponse = message.model;
      if (typeof message?.usage?.input_tokens === "number") inputTokens = message.usage.input_tokens;
    } else if (type === "content_block_delta") {
      const delta = obj.delta as { type?: string; text?: string } | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        fullText += delta.text;
      }
    } else if (type === "message_delta") {
      const delta = obj.delta as { stop_reason?: string } | undefined;
      const usage = obj.usage as { output_tokens?: number } | undefined;
      if (typeof delta?.stop_reason === "string") stopReason = delta.stop_reason;
      if (typeof usage?.output_tokens === "number") outputTokens = usage.output_tokens;
    }
  }
  return { fullText, modelInResponse, eventCount, stopReason, inputTokens, outputTokens };
}

interface SseEvent {
  event: string;
  data: string;
}

async function* parseSseStream(body: unknown): AsyncGenerator<SseEvent> {
  let buffer = "";
  let event = "";
  let dataLines: string[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const rawLine = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (rawLine.length === 0) {
        if (dataLines.length > 0) {
          yield { event, data: dataLines.join("\n") };
          event = "";
          dataLines = [];
        }
        continue;
      }
      if (rawLine.startsWith("event:")) {
        event = rawLine.slice(6).trim();
      } else if (rawLine.startsWith("data:")) {
        dataLines.push(rawLine.slice(5).trim());
      }
    }
  }
  if (dataLines.length > 0) {
    yield { event, data: dataLines.join("\n") };
  }
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
