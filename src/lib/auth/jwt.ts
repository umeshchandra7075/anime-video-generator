import jwt from "jsonwebtoken";
import crypto from "crypto";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

export interface AccessTokenPayload {
  sub: string; // userId
  role: "USER" | "ADMIN";
}

export interface RefreshTokenPayload {
  sub: string; // userId
  sid: string; // sessionId
}

export function signAccessToken(payload: AccessTokenPayload): string {
  const secret = requireEnv("AUTH_ACCESS_TOKEN_SECRET");
  const ttl = process.env.AUTH_ACCESS_TOKEN_TTL ?? "15m";
  return jwt.sign(payload, secret, { expiresIn: ttl });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const secret = requireEnv("AUTH_ACCESS_TOKEN_SECRET");
  return jwt.verify(token, secret) as AccessTokenPayload;
}

export function signRefreshToken(payload: RefreshTokenPayload): string {
  const secret = requireEnv("AUTH_REFRESH_TOKEN_SECRET");
  const days = Number(process.env.AUTH_REFRESH_TOKEN_TTL_DAYS ?? "30");
  return jwt.sign(payload, secret, { expiresIn: `${days}d` });
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const secret = requireEnv("AUTH_REFRESH_TOKEN_SECRET");
  return jwt.verify(token, secret) as RefreshTokenPayload;
}

// We never store raw tokens in the database - only a one-way hash, so a DB
// leak alone cannot be used to mint sessions.
export function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

export function generateOpaqueToken(): string {
  return crypto.randomBytes(32).toString("hex");
}
