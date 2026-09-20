import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { resetPasswordSchema } from "@/lib/validation/schemas";
import { hashToken } from "@/lib/auth/jwt";
import { hashPassword } from "@/lib/auth/password";
import { ok, fail } from "@/lib/api/response";
import { Errors } from "@/lib/api/errors";
import { logger } from "@/lib/logger";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const parsed = resetPasswordSchema.safeParse(body);
    if (!parsed.success) {
      throw Errors.validation(parsed.error.errors[0]?.message ?? "Invalid input.");
    }

    const tokenHash = hashToken(parsed.data.token);
    const record = await db.passwordReset.findUnique({ where: { tokenHash } });

    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw Errors.validation("This reset link is invalid or has expired.");
    }

    const passwordHash = await hashPassword(parsed.data.password);

    await db.$transaction([
      db.passwordReset.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      db.user.update({
        where: { id: record.userId },
        data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
      }),
      // Revoke all existing sessions on password change.
      db.session.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    logger.info({ userId: record.userId }, "password_reset_completed");

    return ok({ message: "Password updated. Please log in again." });
  } catch (err) {
    return fail(err);
  }
}
