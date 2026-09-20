export class AppError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const Errors = {
  validation: (message: string) => new AppError("VALIDATION_ERROR", message, 422),
  unauthorized: (message = "Authentication required.") =>
    new AppError("UNAUTHORIZED", message, 401),
  forbidden: (message = "You do not have access to this resource.") =>
    new AppError("FORBIDDEN", message, 403),
  notFound: (message = "Resource not found.") => new AppError("NOT_FOUND", message, 404),
  conflict: (message: string) => new AppError("CONFLICT", message, 409),
  rateLimited: (retryAfterSeconds: number) =>
    new AppError("RATE_LIMITED", `Too many requests. Try again in ${retryAfterSeconds}s.`, 429),
  emailNotVerified: () =>
    new AppError("EMAIL_NOT_VERIFIED", "Please verify your email before continuing.", 403),
  insufficientCredits: () =>
    new AppError("INSUFFICIENT_CREDITS", "You do not have enough credits for this action.", 402),
  providerNotConfigured: (provider: string) =>
    new AppError(
      "PROVIDER_NOT_CONFIGURED",
      `The ${provider} provider is not configured. Set the required environment variables to enable it.`,
      503,
    ),
  providerError: (message = "The AI provider returned an error.") =>
    new AppError("GENERATION_PROVIDER_ERROR", message, 502),
  internal: (message = "Something went wrong.") => new AppError("INTERNAL_ERROR", message, 500),
};
