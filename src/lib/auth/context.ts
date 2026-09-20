import { NextRequest } from "next/server";
import { verifyAccessToken } from "@/lib/auth/jwt";
import { ACCESS_COOKIE_NAME } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { Errors } from "@/lib/api/errors";

export interface AuthContext {
  userId: string;
  role: "USER" | "ADMIN";
  emailVerified: boolean;
}

function extractAccessToken(req: NextRequest): string | null {
  const cookieToken = req.cookies.get(ACCESS_COOKIE_NAME)?.value;
  if (cookieToken) return cookieToken;

  const header = req.headers.get("authorization");
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);

  return null;
}

/** Throws Errors.unauthorized() if the request is not authenticated. */
export async function requireAuth(req: NextRequest): Promise<AuthContext> {
  const token = extractAccessToken(req);
  if (!token) throw Errors.unauthorized();

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    throw Errors.unauthorized("Invalid or expired session.");
  }

  const user = await db.user.findUnique({ where: { id: payload.sub } });
  if (!user) throw Errors.unauthorized();

  return {
  userId: user.id,
  role: user.role as "USER" | "ADMIN",
  emailVerified: !!user.emailVerifiedAt,
};

  // return { userId: user.id, role: user.role, emailVerified: !!user.emailVerifiedAt };
}

/** Like requireAuth, but also requires a verified email (needed for generation). */
export async function requireVerifiedAuth(req: NextRequest): Promise<AuthContext> {
  const ctx = await requireAuth(req);
  if (!ctx.emailVerified) throw Errors.emailNotVerified();
  return ctx;
}

export async function requireAdmin(req: NextRequest): Promise<AuthContext> {
  const ctx = await requireAuth(req);
  if (ctx.role !== "ADMIN") throw Errors.forbidden("Admin access required.");
  return ctx;
}

export function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}
