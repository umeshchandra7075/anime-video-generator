import crypto from "crypto";

function getSigningSecret(): string {
  // Falls back to the access-token secret so local dev needs one less env
  // var, but a dedicated secret is recommended once this touches production.
  const secret = process.env.STORAGE_LOCAL_SIGNING_SECRET || process.env.AUTH_ACCESS_TOKEN_SECRET;
  if (!secret) {
    throw new Error("Missing STORAGE_LOCAL_SIGNING_SECRET or AUTH_ACCESS_TOKEN_SECRET for local storage signing.");
  }
  return secret;
}

function sign(key: string, expiresAt: number): string {
  return crypto.createHmac("sha256", getSigningSecret()).update(`${key}:${expiresAt}`).digest("hex");
}

export function buildSignedPath(key: string, expiresInSeconds: number): string {
  const expiresAt = Date.now() + expiresInSeconds * 1000;
  const signature = sign(key, expiresAt);
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `/api/files/${encodedKey}?exp=${expiresAt}&sig=${signature}`;
}

export function verifySignedRequest(key: string, expiresAtParam: string | null, sigParam: string | null): boolean {
  if (!expiresAtParam || !sigParam) return false;
  const expiresAt = Number(expiresAtParam);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;

  const expected = sign(key, expiresAt);
  const a = Buffer.from(expected);
  const b = Buffer.from(sigParam);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
