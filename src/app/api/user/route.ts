import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/context";
import { verifyPassword } from "@/lib/auth/password";
import { ok, fail } from "@/lib/api/response";
import { Errors } from "@/lib/api/errors";
import { logger } from "@/lib/logger";

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireAuth(req);
    const user = await db.user.findUnique({
      where: { id: ctx.userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        credits: true,
        emailVerifiedAt: true,
        createdAt: true,
      },
    });
    if (!user) throw Errors.notFound("User not found.");
    return ok(user);
  } catch (err) {
    return fail(err);
  }
}

const updateProfileSchema = z.object({
  name: z.string().trim().min(2).max(100),
});

export async function PATCH(req: NextRequest) {
  try {
    const ctx = await requireAuth(req);
    const body = await req.json().catch(() => null);
    const parsed = updateProfileSchema.safeParse(body);
    if (!parsed.success) throw Errors.validation("Please enter a valid name.");

    const user = await db.user.update({
      where: { id: ctx.userId },
      data: { name: parsed.data.name },
      select: { id: true, name: true, email: true, role: true, credits: true, emailVerifiedAt: true },
    });

    return ok(user);
  } catch (err) {
    return fail(err);
  }
}

const deleteAccountSchema = z.object({
  password: z.string().min(1),
});

/**
 * Real, permanent deletion (not a soft-delete flag) - the user's projects,
 * sessions, and related rows cascade via the `onDelete: Cascade` relations
 * in prisma/schema.prisma. Requires re-entering the current password so a
 * hijacked but still-logged-in session can't be used to destroy the
 * account outright.
 */
export async function DELETE(req: NextRequest) {
  try {
    const ctx = await requireAuth(req);
    const body = await req.json().catch(() => null);
    const parsed = deleteAccountSchema.safeParse(body);
    if (!parsed.success) throw Errors.validation("Please enter your password to confirm.");

    const user = await db.user.findUnique({ where: { id: ctx.userId } });
    if (!user) throw Errors.notFound("User not found.");

    const validPassword = await verifyPassword(parsed.data.password, user.passwordHash);
    if (!validPassword) throw Errors.unauthorized("Incorrect password.");

    await db.user.delete({ where: { id: user.id } });
    logger.info({ userId: user.id }, "account_deleted");

    return ok({ message: "Account deleted." });
  } catch (err) {
    return fail(err);
  }
}
