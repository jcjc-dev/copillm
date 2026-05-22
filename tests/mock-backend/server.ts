import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  FIXTURE_COPILOT_BEARER,
  FIXTURE_GITHUB_TOKEN,
  FIXTURE_MODELS,
  fixtureBearerExpiresAt,
  fixtureUserPayload
} from "./fixtures.js";

export interface MockBackendOptions {
  port?: number;
  acceptAnyGithubToken?: boolean;
  acceptAnyBearer?: boolean;
}

export interface MockBackend {
  port: number;
  baseUrl: string;
  tokenExchangeUrl: string;
  githubUserUrl: string;
  close: () => Promise<void>;
}

const REPLY_TEXT = "ok-from-mock";

export async function startMockBackend(options: MockBackendOptions = {}): Promise<MockBackend> {
  const acceptAnyGithubToken = options.acceptAnyGithubToken ?? true;
  const acceptAnyBearer = options.acceptAnyBearer ?? true;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    try {
      if (req.method === "GET" && url.pathname === "/copilot_internal/v2/token") {
        return handleTokenExchange(req, res, acceptAnyGithubToken);
      }
      if (req.method === "GET" && url.pathname === "/user") {
        return handleGithubUser(req, res, acceptAnyGithubToken);
      }
      if (req.method === "GET" && url.pathname === "/models") {
        return handleModels(req, res, acceptAnyBearer);
      }
      if (req.method === "POST" && url.pathname === "/chat/completions") {
        return await handleChatCompletions(req, res, acceptAnyBearer);
      }
      if (req.method === "POST" && url.pathname === "/responses") {
        return await handleResponses(req, res, acceptAnyBearer);
      }
      sendJson(res, 404, { error: "not_found", path: url.pathname, method: req.method });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown";
      sendJson(res, 500, { error: "mock_internal_error", detail });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock backend failed to bind");
  }
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    port,
    baseUrl,
    tokenExchangeUrl: `${baseUrl}/copilot_internal/v2/token`,
    githubUserUrl: `${baseUrl}/user`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}

function handleTokenExchange(req: IncomingMessage, res: ServerResponse, acceptAny: boolean): void {
  const authHeader = req.headers["authorization"] ?? "";
  if (!acceptAny && authHeader !== `token ${FIXTURE_GITHUB_TOKEN}`) {
    sendJson(res, 401, { error: "invalid_github_token" });
    return;
  }
  if (typeof authHeader !== "string" || !authHeader.toLowerCase().startsWith("token ")) {
    sendJson(res, 401, { error: "missing_github_token" });
    return;
  }
  sendJson(res, 200, {
    token: FIXTURE_COPILOT_BEARER,
    expires_at: fixtureBearerExpiresAt(),
    refresh_in: 1500
  });
}

function handleGithubUser(req: IncomingMessage, res: ServerResponse, acceptAny: boolean): void {
  const authHeader = req.headers["authorization"] ?? "";
  if (!acceptAny && authHeader !== `token ${FIXTURE_GITHUB_TOKEN}`) {
    sendJson(res, 401, { error: "invalid_github_token" });
    return;
  }
  if (typeof authHeader !== "string" || !authHeader.toLowerCase().startsWith("token ")) {
    sendJson(res, 401, { error: "missing_github_token" });
    return;
  }
  sendJson(res, 200, fixtureUserPayload());
}

function handleModels(req: IncomingMessage, res: ServerResponse, acceptAny: boolean): void {
  if (!checkBearer(req, acceptAny)) {
    sendJson(res, 401, { error: "invalid_bearer" });
    return;
  }
  sendJson(res, 200, { data: FIXTURE_MODELS });
}

async function handleChatCompletions(req: IncomingMessage, res: ServerResponse, acceptAny: boolean): Promise<void> {
  if (!checkBearer(req, acceptAny)) {
    sendJson(res, 401, { error: "invalid_bearer" });
    return;
  }
  const body = await readJson(req);
  const model = typeof body?.model === "string" ? body.model : "gpt-test";
  const stream = body?.stream === true;
  const reply = `${REPLY_TEXT}:${model}`;
  if (!stream) {
    sendJson(res, 200, buildOpenAINonStreamResponse(model, reply));
    return;
  }
  await streamOpenAIChunks(res, model, reply);
}

async function handleResponses(req: IncomingMessage, res: ServerResponse, acceptAny: boolean): Promise<void> {
  if (!checkBearer(req, acceptAny)) {
    sendJson(res, 401, { error: "invalid_bearer" });
    return;
  }
  const body = await readJson(req);
  const model = typeof body?.model === "string" ? body.model : "gpt-test-codex";
  const reply = `${REPLY_TEXT}:${model}`;
  await streamCodexResponse(res, model, reply);
}

function checkBearer(req: IncomingMessage, acceptAny: boolean): boolean {
  const auth = req.headers["authorization"] ?? "";
  if (typeof auth !== "string") return false;
  if (!auth.toLowerCase().startsWith("bearer ")) return false;
  if (acceptAny) return true;
  return auth.slice(7).trim() === FIXTURE_COPILOT_BEARER;
}

function buildOpenAINonStreamResponse(model: string, content: string): Record<string, unknown> {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop"
      }
    ],
    usage: { prompt_tokens: 4, completion_tokens: content.length, total_tokens: 4 + content.length }
  };
}

async function streamOpenAIChunks(res: ServerResponse, model: string, content: string): Promise<void> {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const writeChunk = (delta: Record<string, unknown>, finish: null | string = null): void => {
    const payload = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }]
    };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  writeChunk({ role: "assistant", content: "" });
  for (const piece of chunkText(content)) {
    writeChunk({ content: piece });
    await sleep(2);
  }
  writeChunk({}, "stop");
  res.write(`data: [DONE]\n\n`);
  res.end();
}

async function streamCodexResponse(res: ServerResponse, model: string, content: string): Promise<void> {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const responseId = `resp_${randomUUID()}`;
  const itemId = `msg_${randomUUID()}`;
  const writeEvent = (eventName: string, data: Record<string, unknown>): void => {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  writeEvent("response.created", {
    type: "response.created",
    response: { id: responseId, object: "response", model, status: "in_progress" }
  });
  writeEvent("response.output_item.added", {
    type: "response.output_item.added",
    item: { id: itemId, type: "message", role: "assistant", status: "in_progress" }
  });
  writeEvent("response.content_part.added", {
    type: "response.content_part.added",
    item_id: itemId,
    output_index: 0,
    part: { type: "output_text", text: "" }
  });
  for (const piece of chunkText(content)) {
    writeEvent("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: itemId,
      output_index: 0,
      delta: piece
    });
    await sleep(2);
  }
  writeEvent("response.output_text.done", {
    type: "response.output_text.done",
    item_id: itemId,
    output_index: 0,
    text: content
  });
  writeEvent("response.content_part.done", {
    type: "response.content_part.done",
    item_id: itemId,
    output_index: 0,
    part: { type: "output_text", text: content }
  });
  writeEvent("response.output_item.done", {
    type: "response.output_item.done",
    item: {
      id: itemId,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: content }]
    }
  });
  writeEvent("response.completed", {
    type: "response.completed",
    response: {
      id: responseId,
      object: "response",
      model,
      status: "completed",
      usage: { input_tokens: 4, output_tokens: content.length, total_tokens: 4 + content.length },
      output: [
        {
          id: itemId,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: content }]
        }
      ]
    }
  });
  res.end();
}

function chunkText(text: string): string[] {
  if (text.length === 0) return [];
  const out: string[] = [];
  let i = 0;
  const size = Math.max(1, Math.floor(text.length / 6));
  while (i < text.length) {
    out.push(text.slice(i, i + size));
    i += size;
  }
  return out;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}
