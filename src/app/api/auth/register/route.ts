import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { registerSchema } from "@/lib/validation/schemas";
import { hashPassword } from "@/lib/auth/password";
import { generateOpaqueToken, hashToken } from "@/lib/auth/jwt";
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

    logger.info({ userId: user.id }, "user_registered");
    return ok(
      {
        message: "Account created successfully. You can now log in.",
        // Only ever present outside production - lets local dev work
        // without a real mailbox. See DEV_EXPOSE_VERIFICATION_LINKS in .env.example.
      },
      201,
    );
  } catch (err) {
    return fail(err);
  }
}

