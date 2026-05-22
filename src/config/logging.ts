import pino from "pino";

export function createLogger() {
  return pino({
    level: process.env.COPILLM_LOG_LEVEL ?? "info",
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
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined
  });
}
