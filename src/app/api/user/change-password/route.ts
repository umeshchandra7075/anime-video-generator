import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/context";
import { verifyPassword, hashPassword } from "@/lib/auth/password";
import { ok, fail } from "@/lib/api/response";
import { Errors } from "@/lib/api/errors";
import { logger } from "@/lib/logger";

const schema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z
      .string()
      .min(10)
      .max(128)
      .regex(/[a-z]/, "Password must include a lowercase letter.")
      .regex(/[A-Z]/, "Password must include an uppercase letter.")
      .regex(/[0-9]/, "Password must include a number."),
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireAuth(req);
    const body = await req.json().catch(() => null);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw Errors.validation(parsed.error.errors[0]?.message ?? "Invalid input.");
    }

    const user = await db.user.findUnique({ where: { id: ctx.userId } });
    if (!user) throw Errors.notFound("User not found.");

    const validCurrent = await verifyPassword(parsed.data.currentPassword, user.passwordHash);
    if (!validCurrent) throw Errors.unauthorized("Current password is incorrect.");

    const passwordHash = await hashPassword(parsed.data.newPassword);

    await db.$transaction([
      db.user.update({ where: { id: user.id }, data: { passwordHash } }),
      // Revoke all other sessions on password change, same as a forgot-password reset.
      db.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);

    logger.info({ userId: user.id }, "password_changed");
    return ok({ message: "Password updated. Please log in again." });
  } catch (err) {
    return fail(err);
  }
}
