export interface CodexLikeChatResult {
  fullText: string;
  modelInResponse: null | string;
  eventCount: number;
}

export async function discoverCodexModels(copillmBaseUrl: string, clientVersion = "0.130.0"): Promise<string[]> {
  const url = `${copillmBaseUrl}/codex/v1/models?client_version=${encodeURIComponent(clientVersion)}`;
  const response = await fetch(url, {
    headers: { Authorization: "Bearer copillm-local-test" }
  });
  if (!response.ok) {
    throw new Error(`Codex /models discovery failed: ${response.status}`);
  }
  const payload = (await response.json()) as { models?: Array<{ slug?: string }> };
  return (payload.models ?? []).map((m) => m.slug ?? "").filter((s): s is string => s.length > 0);
}

export async function codexLikeChat(input: {
  copillmBaseUrl: string;
  model: string;
  prompt: string;
}): Promise<CodexLikeChatResult> {
  const response = await fetch(`${input.copillmBaseUrl}/codex/v1/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer copillm-local-test"
    },
    body: JSON.stringify({
      model: input.model,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: input.prompt }]
        }
      ],
      stream: true
    })
  });
  if (!response.ok || !response.body) {
    throw new Error(`Codex chat failed: ${response.status}`);
  }

  let fullText = "";
  let modelInResponse: null | string = null;
  let eventCount = 0;
  for await (const event of parseSseStream(response.body)) {
    eventCount += 1;
    const data = safeParseJson(event.data);
    if (!data || typeof data !== "object") continue;
    const obj = data as Record<string, unknown>;
    const type = typeof obj.type === "string" ? obj.type : event.event;
    if (type === "response.created") {
      const response = obj.response as { model?: string } | undefined;
      if (typeof response?.model === "string") {
        modelInResponse = response.model;
      }
    } else if (type === "response.output_text.delta") {
      const delta = obj.delta;
      if (typeof delta === "string") fullText += delta;
    } else if (type === "response.output_text.done") {
      const text = obj.text;
      if (typeof text === "string" && fullText.length === 0) {
        fullText = text;
      }
    } else if (type === "response.completed") {
      const response = obj.response as { model?: string } | undefined;
      if (typeof response?.model === "string") {
        modelInResponse = modelInResponse ?? response.model;
      }
    }
  }
  return { fullText, modelInResponse, eventCount };
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
