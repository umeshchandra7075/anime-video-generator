import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { forgotPasswordSchema } from "@/lib/validation/schemas";
import { generateOpaqueToken, hashToken } from "@/lib/auth/jwt";
import { sendPasswordResetEmail } from "@/lib/email/mailer";
import { ok, fail } from "@/lib/api/response";
import { Errors } from "@/lib/api/errors";
import { checkRateLimit } from "@/lib/auth/rateLimit";
import { clientIp } from "@/lib/auth/context";

export async function POST(req: NextRequest) {
  try {
    const ip = clientIp(req);
    const rl = await checkRateLimit({ key: `forgot:ip:${ip}`, limit: 10, windowSeconds: 3600 });
    if (!rl.allowed) throw Errors.rateLimited(rl.retryAfterSeconds);

    const body = await req.json().catch(() => null);
    const parsed = forgotPasswordSchema.safeParse(body);
    if (!parsed.success) throw Errors.validation("Invalid email.");

    const user = await db.user.findUnique({ where: { email: parsed.data.email.toLowerCase() } });

    // Always respond the same way regardless of whether the account exists.
    if (user) {
      const rawToken = generateOpaqueToken();
      await db.passwordReset.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(rawToken),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      const resetUrl = `${process.env.APP_BASE_URL}/reset-password?token=${rawToken}`;
      await sendPasswordResetEmail(user.email, resetUrl);

      const devLinkExposed =
        process.env.NODE_ENV !== "production" && process.env.DEV_EXPOSE_VERIFICATION_LINKS !== "false";
      if (devLinkExposed) {
        return ok({ message: "If that email exists, a reset link has been sent.", devResetUrl: resetUrl });
      }
    }

    return ok({ message: "If that email exists, a reset link has been sent." });
  } catch (err) {
    return fail(err);
  }
}
