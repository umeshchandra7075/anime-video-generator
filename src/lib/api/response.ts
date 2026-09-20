import { NextResponse } from "next/server";
import { AppError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";

export function ok<T>(data: T, status = 200) {
  return NextResponse.json({ success: true, data }, { status });
}

/**
 * Converts any thrown error into a safe, structured API response.
 * AppError instances surface their code/message/status as designed.
 * Anything else is logged server-side (never with stack traces returned to
 * the client) and reported generically.
 */
export function fail(error: unknown) {
  if (error instanceof AppError) {
    return NextResponse.json(
      { success: false, error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }

  logger.error({ err: error }, "Unhandled API error");
  return NextResponse.json(
    {
      success: false,
      error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." },
    },
    { status: 500 },
  );
}
