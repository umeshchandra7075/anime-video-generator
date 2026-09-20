import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { verifyEmailSchema } from "@/lib/validation/schemas";
import { hashToken } from "@/lib/auth/jwt";
import { ok, fail } from "@/lib/api/response";
import { Errors } from "@/lib/api/errors";
import { logger } from "@/lib/logger";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const parsed = verifyEmailSchema.safeParse(body);
    if (!parsed.success) throw Errors.validation("Invalid or missing token.");

    const tokenHash = hashToken(parsed.data.token);
    const record = await db.emailVerification.findUnique({ where: { tokenHash } });

    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw Errors.validation("This verification link is invalid or has expired.");
    }

    await db.$transaction([
      db.emailVerification.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      db.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } }),
    ]);

    logger.info({ userId: record.userId }, "email_verified");

    return ok({ message: "Email verified. You can now log in." });
  } catch (err) {
    return fail(err);
  }
}
