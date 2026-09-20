import { NextRequest, NextResponse } from "next/server";
import { revokeSession, ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME } from "@/lib/auth/session";
import { fail } from "@/lib/api/response";

export async function POST(req: NextRequest) {
  try {
    const refreshToken = req.cookies.get(REFRESH_COOKIE_NAME)?.value;
    if (refreshToken) {
      await revokeSession(refreshToken).catch(() => {
        // Token already invalid/expired - logout should still succeed.
      });
    }

    const res = NextResponse.json({ success: true, data: { message: "Logged out." } });
    res.cookies.delete(ACCESS_COOKIE_NAME);
    res.cookies.delete(REFRESH_COOKIE_NAME);
    return res;
  } catch (err) {
    return fail(err);
  }
}
