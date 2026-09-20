import { NextRequest, NextResponse } from "next/server";
import {
  rotateSession,
  cookieOptions,
  ACCESS_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
} from "@/lib/auth/session";
import { fail } from "@/lib/api/response";
import { Errors } from "@/lib/api/errors";

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = Number(process.env.AUTH_REFRESH_TOKEN_TTL_DAYS ?? "30") * 24 * 60 * 60;

export async function POST(req: NextRequest) {
  try {
    const refreshToken = req.cookies.get(REFRESH_COOKIE_NAME)?.value;
    if (!refreshToken) throw Errors.unauthorized("No active session.");

    let tokens;
    try {
      tokens = await rotateSession(refreshToken);
    } catch {
      // Reused/invalid refresh token: clear cookies and force re-login.
      const res = NextResponse.json(
        { success: false, error: { code: "UNAUTHORIZED", message: "Session expired." } },
        { status: 401 },
      );
      res.cookies.delete(ACCESS_COOKIE_NAME);
      res.cookies.delete(REFRESH_COOKIE_NAME);
      return res;
    }

    const res = NextResponse.json({ success: true, data: { message: "Session refreshed." } });
    res.cookies.set(ACCESS_COOKIE_NAME, tokens.accessToken, cookieOptions(ACCESS_TTL_SECONDS));
    res.cookies.set(REFRESH_COOKIE_NAME, tokens.refreshToken, cookieOptions(REFRESH_TTL_SECONDS));
    return res;
  } catch (err) {
    return fail(err);
  }
}
