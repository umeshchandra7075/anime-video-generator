import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { loginSchema } from "@/lib/validation/schemas";
import { verifyPassword } from "@/lib/auth/password";
import { createSession, cookieOptions, ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME } from "@/lib/auth/session";
import { checkLoginRateLimit } from "@/lib/auth/rateLimit";
import { fail } from "@/lib/api/response";
import { Errors } from "@/lib/api/errors";
import { clientIp } from "@/lib/auth/context";
import { logger } from "@/lib/logger";

const MAX_FAILED_ATTEMPTS = 6;
const LOCKOUT_MINUTES = 15;
const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = Number(process.env.AUTH_REFRESH_TOKEN_TTL_DAYS ?? "30") * 24 * 60 * 60;

export async function POST(req: NextRequest) {
  try {
    const ip = clientIp(req);
    const body = await req.json().catch(() => null);
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) throw Errors.validation("Invalid email or password.");
    const { email, password } = parsed.data;

    const rl = await checkLoginRateLimit(email, ip);
    if (!rl.allowed) throw Errors.rateLimited(rl.retryAfterSeconds);

    const user = await db.user.findUnique({ where: { email: email.toLowerCase() } });

    // Constant-shape response whether or not the user exists, to avoid
    // leaking account existence via timing/response differences where possible.
    const genericFail = () => Errors.unauthorized("Invalid email or password.");

    if (!user) throw genericFail();

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw Errors.unauthorized(
        `Account temporarily locked due to failed attempts. Try again after ${user.lockedUntil.toISOString()}.`,
      );
    }

    const validPassword = await verifyPassword(password, user.passwordHash);
    if (!validPassword) {
      const failedCount = user.failedLoginCount + 1;
      await db.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: failedCount,
          lockedUntil:
            failedCount >= MAX_FAILED_ATTEMPTS
              ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000)
              : null,
        },
      });
      throw genericFail();
    }

    if (!user.emailVerifiedAt) {
      throw Errors.emailNotVerified();
    }

    await db.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null },
    });

    const { accessToken, refreshToken } = await createSession({
      userId: user.id,
      // role: user.role,
      role: user.role as "USER" | "ADMIN",
      userAgent: req.headers.get("user-agent"),
      ipAddress: ip,
    });

    logger.info({ userId: user.id }, "user_logged_in");

    const res = NextResponse.json({
      success: true,
      data: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
    res.cookies.set(ACCESS_COOKIE_NAME, accessToken, cookieOptions(ACCESS_TTL_SECONDS));
    res.cookies.set(REFRESH_COOKIE_NAME, refreshToken, cookieOptions(REFRESH_TTL_SECONDS));
    return res;
  } catch (err) {
    return fail(err);
  }
}
