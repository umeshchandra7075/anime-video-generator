import pino from "pino";

// Fields that must never be written to logs, even accidentally.
const REDACT_PATHS = [
  "password",
  "passwordHash",
  "token",
  "accessToken",
  "refreshToken",
  "authorization",
  "*.apiKey",
  "*.password",
  "*.token",
  "*.refreshToken",
  "*.accessToken",
  "signedUrl",
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  formatters: {
    level(label) {
      return { level: label };
    },
  },
});
