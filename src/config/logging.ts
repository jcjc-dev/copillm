import pino from "pino";

export function createLogger() {
  const options: pino.LoggerOptions = {
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
        ? { target: "pino-pretty", options: { colorize: true, destination: 2 } }
        : undefined
  };

  if (process.env.COPILLM_LOG_PRETTY === "1") {
    return pino(options);
  }

  return pino(options, pino.destination(2));
}
