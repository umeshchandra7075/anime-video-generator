/**
 * Errors thrown by AI provider adapters. These are provider/HTTP-agnostic -
 * API routes and workers translate them into the application's structured
 * error responses (see src/lib/api/errors.ts) rather than leaking provider
 * internals (stack traces, raw response bodies, credentials) to the client.
 */

export class ProviderNotConfiguredError extends Error {
  provider: string;
  constructor(provider: string) {
    super(`Provider "${provider}" is not configured.`);
    this.name = "ProviderNotConfiguredError";
    this.provider = provider;
  }
}

export class ProviderAuthError extends Error {
  provider: string;
  constructor(provider: string) {
    super(`Authentication with provider "${provider}" failed.`);
    this.name = "ProviderAuthError";
    this.provider = provider;
  }
}

export class ProviderRequestError extends Error {
  provider: string;
  statusCode?: number;
  constructor(provider: string, message: string, statusCode?: number) {
    super(message);
    this.name = "ProviderRequestError";
    this.provider = provider;
    this.statusCode = statusCode;
  }
}

export class ProviderTimeoutError extends Error {
  provider: string;
  constructor(provider: string) {
    super(`Provider "${provider}" timed out.`);
    this.name = "ProviderTimeoutError";
    this.provider = provider;
  }
}
