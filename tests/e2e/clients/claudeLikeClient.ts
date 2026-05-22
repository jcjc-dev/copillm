export interface ClaudeLikeChatResult {
  fullText: string;
  modelInResponse: null | string;
  eventCount: number;
  stopReason: null | string;
}

export async function discoverClaudeModels(copillmBaseUrl: string): Promise<Array<{ id: string; display_name: string }>> {
  const response = await fetch(`${copillmBaseUrl}/anthropic/v1/models`, {
    headers: {
      "x-api-key": "copillm-local-test",
      "anthropic-version": "2023-06-01"
    }
  });
  if (!response.ok) {
    throw new Error(`Claude /models discovery failed: ${response.status}`);
  }
  const payload = (await response.json()) as { data?: Array<{ id?: string; display_name?: string }> };
  return (payload.data ?? [])
    .filter((m): m is { id: string; display_name: string } => typeof m.id === "string" && typeof m.display_name === "string");
}

export async function claudeLikeChat(input: {
  copillmBaseUrl: string;
  model: string;
  prompt: string;
}): Promise<ClaudeLikeChatResult> {
  const response = await fetch(`${input.copillmBaseUrl}/anthropic/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer copillm-local-test",
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
    throw new Error(`Claude chat failed: ${response.status}`);
  }
  let fullText = "";
  let modelInResponse: null | string = null;
  let stopReason: null | string = null;
  let eventCount = 0;
  for await (const event of parseSseStream(response.body)) {
    eventCount += 1;
    const data = safeParseJson(event.data);
    if (!data || typeof data !== "object") continue;
    const obj = data as Record<string, unknown>;
    const type = typeof obj.type === "string" ? obj.type : event.event;
    if (type === "message_start") {
      const message = obj.message as { model?: string } | undefined;
      if (typeof message?.model === "string") {
        modelInResponse = message.model;
      }
    } else if (type === "content_block_delta") {
      const delta = obj.delta as { type?: string; text?: string } | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        fullText += delta.text;
      }
    } else if (type === "message_delta") {
      const delta = obj.delta as { stop_reason?: string } | undefined;
      if (typeof delta?.stop_reason === "string") {
        stopReason = delta.stop_reason;
      }
    }
  }
  return { fullText, modelInResponse, eventCount, stopReason };
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
