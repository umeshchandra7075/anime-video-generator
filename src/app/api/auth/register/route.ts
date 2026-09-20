import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { registerSchema } from "@/lib/validation/schemas";
import { hashPassword } from "@/lib/auth/password";
import { generateOpaqueToken, hashToken } from "@/lib/auth/jwt";
import { sendVerificationEmail } from "@/lib/email/mailer";
import { ok, fail } from "@/lib/api/response";
import { Errors } from "@/lib/api/errors";
import { checkRateLimit } from "@/lib/auth/rateLimit";
import { clientIp } from "@/lib/auth/context";
import { logger } from "@/lib/logger";

export async function POST(req: NextRequest) {
  try {
    const ip = clientIp(req);
    const rl = await checkRateLimit({ key: `register:ip:${ip}`, limit: 10, windowSeconds: 3600 });
    if (!rl.allowed) throw Errors.rateLimited(rl.retryAfterSeconds);

    const body = await req.json().catch(() => null);
    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) {
      throw Errors.validation(parsed.error.errors[0]?.message ?? "Invalid input.");
    }
    const { name, email, password } = parsed.data;

    const existing = await db.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) {
      throw Errors.conflict("An account with this email already exists.");
    }

    const passwordHash = await hashPassword(password);

    const user = await db.user.create({
      data: { name, email: email.toLowerCase(), passwordHash },
    });

    const rawToken = generateOpaqueToken();
    await db.emailVerification.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    const verifyUrl = `${process.env.APP_BASE_URL}/verify-email?token=${rawToken}`;
    await sendVerificationEmail(user.email, verifyUrl);

    logger.info({ userId: user.id }, "user_registered");

    // Do NOT auto-login: account has restricted access until verified.
    const devLinkExposed =
      process.env.NODE_ENV !== "production" && process.env.DEV_EXPOSE_VERIFICATION_LINKS !== "false";

    return ok(
      {
        message: "Account created. Please check your email to verify your account.",
        // Only ever present outside production - lets local dev work
        // without a real mailbox. See DEV_EXPOSE_VERIFICATION_LINKS in .env.example.
        ...(devLinkExposed ? { devVerificationUrl: verifyUrl } : {}),
      },
      201,
    );
  } catch (err) {
    return fail(err);
  }
}
