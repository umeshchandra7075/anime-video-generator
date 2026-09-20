// import { db } from "@/lib/db";
// import {
//   hashToken,
//   signAccessToken,
//   signRefreshToken,
//   verifyRefreshToken,
// } from "@/lib/auth/jwt";
// import { nanoid } from "nanoid";

// const REFRESH_TTL_DAYS = Number(process.env.AUTH_REFRESH_TOKEN_TTL_DAYS ?? "30");

// export interface IssuedTokens {
//   accessToken: string;
//   refreshToken: string;
// }

// export async function createSession(params: {
//   userId: string;
//   role: "USER" | "ADMIN";
//   userAgent?: string | null;
//   ipAddress?: string | null;
// }): Promise<IssuedTokens> {
//   const sessionId = nanoid();
//   const refreshToken = signRefreshToken({ sub: params.userId, sid: sessionId });
//   const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);

//   await db.session.create({
//     data: {
//       id: sessionId,
//       userId: params.userId,
//       refreshTokenHash: hashToken(refreshToken),
//       userAgent: params.userAgent ?? undefined,
//       ipAddress: params.ipAddress ?? undefined,
//       expiresAt,
//     },
//   });

//   // const accessToken = signAccessToken({ sub: params.userId, role: params.role });
//   const accessToken = signAccessToken({
//   sub: user.id,
//   role: user.role as "USER" | "ADMIN",
// });
//   return { accessToken, refreshToken };
// }

// /**
//  * Rotates a refresh token: the old session is revoked and a brand new one is
//  * issued. If a revoked/expired/unknown refresh token is presented, this is
//  * treated as a possible token-theft signal and the whole chain is rejected.
//  */
// export async function rotateSession(rawRefreshToken: string): Promise<IssuedTokens> {
//   const payload = verifyRefreshToken(rawRefreshToken); // throws if invalid/expired
//   const tokenHash = hashToken(rawRefreshToken);

//   const existing = await db.session.findUnique({ where: { refreshTokenHash: tokenHash } });
//   if (!existing || existing.id !== payload.sid || existing.userId !== payload.sub) {
//     throw new Error("INVALID_SESSION");
//   }
//   if (existing.revokedAt || existing.expiresAt < new Date()) {
//     throw new Error("SESSION_EXPIRED_OR_REVOKED");
//   }

//   const user = await db.user.findUnique({ where: { id: existing.userId } });
//   if (!user) throw new Error("USER_NOT_FOUND");

//   const newSessionId = nanoid();
//   const newRefreshToken = signRefreshToken({ sub: user.id, sid: newSessionId });
//   const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);

//   await db.$transaction([
//     db.session.update({
//       where: { id: existing.id },
//       data: { revokedAt: new Date(), replacedBySessionId: newSessionId },
//     }),
//     db.session.create({
//       data: {
//         id: newSessionId,
//         userId: user.id,
//         refreshTokenHash: hashToken(newRefreshToken),
//         userAgent: existing.userAgent,
//         ipAddress: existing.ipAddress,
//         expiresAt,
//       },
//     }),
//   ]);

//   const accessToken = signAccessToken({ sub: user.id, role: user.role });
//   return { accessToken, refreshToken: newRefreshToken };
// }

// export async function revokeSession(rawRefreshToken: string): Promise<void> {
//   const tokenHash = hashToken(rawRefreshToken);
//   await db.session.updateMany({
//     where: { refreshTokenHash: tokenHash, revokedAt: null },
//     data: { revokedAt: new Date() },
//   });
// }

// export const ACCESS_COOKIE_NAME = "avg_access_token";
// export const REFRESH_COOKIE_NAME = "avg_refresh_token";

// export function cookieOptions(maxAgeSeconds: number) {
//   return {
//     httpOnly: true,
//     secure: process.env.NODE_ENV === "production",
//     sameSite: "lax" as const,
//     path: "/",
//     maxAge: maxAgeSeconds,
//   };
// }


import { db } from "@/lib/db";
import {
  hashToken,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "@/lib/auth/jwt";
import { nanoid } from "nanoid";

const REFRESH_TTL_DAYS = Number(
  process.env.AUTH_REFRESH_TOKEN_TTL_DAYS ?? "30"
);

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

export async function createSession(params: {
  userId: string;
  role: "USER" | "ADMIN";
  userAgent?: string | null;
  ipAddress?: string | null;
}): Promise<IssuedTokens> {
  const sessionId = nanoid();

  const refreshToken = signRefreshToken({
    sub: params.userId,
    sid: sessionId,
  });

  const expiresAt = new Date(
    Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000
  );

  await db.session.create({
    data: {
      id: sessionId,
      userId: params.userId,
      refreshTokenHash: hashToken(refreshToken),
      userAgent: params.userAgent ?? undefined,
      ipAddress: params.ipAddress ?? undefined,
      expiresAt,
    },
  });

  const accessToken = signAccessToken({
    sub: params.userId,
    role: params.role,
  });

  return {
    accessToken,
    refreshToken,
  };
}

/**
 * Rotates a refresh token: the old session is revoked and a brand new one is
 * issued. If a revoked/expired/unknown refresh token is presented, this is
 * treated as a possible token-theft signal and the whole chain is rejected.
 */
export async function rotateSession(
  rawRefreshToken: string
): Promise<IssuedTokens> {
  const payload = verifyRefreshToken(rawRefreshToken);
  const tokenHash = hashToken(rawRefreshToken);

  const existing = await db.session.findUnique({
    where: {
      refreshTokenHash: tokenHash,
    },
  });

  if (
    !existing ||
    existing.id !== payload.sid ||
    existing.userId !== payload.sub
  ) {
    throw new Error("INVALID_SESSION");
  }

  if (existing.revokedAt || existing.expiresAt < new Date()) {
    throw new Error("SESSION_EXPIRED_OR_REVOKED");
  }

  const user = await db.user.findUnique({
    where: {
      id: existing.userId,
    },
  });

  if (!user) {
    throw new Error("USER_NOT_FOUND");
  }

  const newSessionId = nanoid();

  const newRefreshToken = signRefreshToken({
    sub: user.id,
    sid: newSessionId,
  });

  const expiresAt = new Date(
    Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000
  );

  await db.$transaction([
    db.session.update({
      where: {
        id: existing.id,
      },
      data: {
        revokedAt: new Date(),
        replacedBySessionId: newSessionId,
      },
    }),

    db.session.create({
      data: {
        id: newSessionId,
        userId: user.id,
        refreshTokenHash: hashToken(newRefreshToken),
        userAgent: existing.userAgent,
        ipAddress: existing.ipAddress,
        expiresAt,
      },
    }),
  ]);

  const accessToken = signAccessToken({
    sub: user.id,
    role: user.role as "USER" | "ADMIN",
  });

  return {
    accessToken,
    refreshToken: newRefreshToken,
  };
}

export async function revokeSession(
  rawRefreshToken: string
): Promise<void> {
  const tokenHash = hashToken(rawRefreshToken);

  await db.session.updateMany({
    where: {
      refreshTokenHash: tokenHash,
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  });
}

export const ACCESS_COOKIE_NAME = "avg_access_token";
export const REFRESH_COOKIE_NAME = "avg_refresh_token";

export function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}