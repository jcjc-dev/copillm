import pino from "pino";
import fs from "node:fs";
import path from "node:path";
import { applyModeIfSupported } from "./fsSecurity.js";

export function createLogger(input?: { level?: string; destinationPath?: string }) {
  const destinationPath = input?.destinationPath ?? process.env.COPILLM_LOG_FILE;
  const options: pino.LoggerOptions = {
    level: input?.level ?? process.env.COPILLM_LOG_LEVEL ?? "info",
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "headers.cookie",
        "headers.authorization",
        "*.headers.authorization",
        "*.headers.cookie",
        "authorization",
        "access_token",
        "refresh_token",
        "bearer",
        "token",
        "githubToken",
        "github_token",
        "responseBodySnippet",
        "body",
        "req.body",
        "response.body",
        "body.messages",
        "body.input"
      ],
      remove: true
    },
    transport:
      process.env.COPILLM_LOG_PRETTY === "1"
        ? { target: "pino-pretty", options: { colorize: destinationPath ? false : true, destination: destinationPath ?? 2 } }
        : undefined
  };

  if (process.env.COPILLM_LOG_PRETTY === "1") {
    if (destinationPath) {
      prepareLogFile(destinationPath);
    }
    return pino(options);
  }

  if (destinationPath) {
    prepareLogFile(destinationPath);
    return pino(options, pino.destination(destinationPath));
  }

  return pino(options, pino.destination(2));
}

function prepareLogFile(filePath: string): void {
  const resolvedPath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(resolvedPath, "a", 0o600);
  fs.closeSync(fd);
  applyModeIfSupported(resolvedPath, 0o600);
}
