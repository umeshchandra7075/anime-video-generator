import { safeDownload, UnsafeUrlError } from "@/lib/engine/safeFetch";
import { ProviderRequestError } from "@/lib/ai/errors/provider-errors";

const list = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/**
 * Downloads a finished media file whose URL came from a provider's API response.
 *
 * Security (this URL is attacker-influenceable data, not configuration):
 *  - https only, no credentials in the URL, host must resolve to PUBLIC addresses only
 *    (blocks localhost, RFC1918, cloud metadata 169.254.169.254, ...); every redirect hop is re-checked
 *  - the provider API key is attached ONLY when the URL's origin is the provider's own API origin
 *    (or a host explicitly listed in PROVIDER_MEDIA_AUTH_HOSTS); a CDN / redirected host never receives it
 *  - optional PROVIDER_MEDIA_HOST_ALLOWLIST restricts result hosts (the API host is always allowed)
 *  - timeout and a hard size cap (PROVIDER_MEDIA_MAX_MB, default 300)
 *  - PROVIDER_MEDIA_ALLOW_PRIVATE=true skips the address check for LOCAL DEVELOPMENT only and is ignored in production
 */
export async function downloadProviderMedia(url: string, o: { provider: string; apiKey: string; baseUrl: string; what: string }): Promise<{ buffer: Buffer; contentType: string | null }> {
  const apiOrigin = new URL(o.baseUrl).origin;
  const allow = list(process.env.PROVIDER_MEDIA_HOST_ALLOWLIST);
  const extraAuth = list(process.env.PROVIDER_MEDIA_AUTH_HOSTS).map((h) => (h.includes("://") ? new URL(h).origin : `https://${h}`));
  const devPrivate = process.env.PROVIDER_MEDIA_ALLOW_PRIVATE === "true" && process.env.NODE_ENV !== "production";
  try {
    const r = await safeDownload(url, {
      allowedHosts: allow.length ? [...allow, new URL(o.baseUrl).hostname] : undefined,
      allowHttp: devPrivate,
      allowPrivateNetwork: devPrivate,
      authHeaders: { Authorization: `Bearer ${o.apiKey}` },
      authOrigin: apiOrigin,
      authOrigins: extraAuth,
      maxBytes: Number(process.env.PROVIDER_MEDIA_MAX_MB || 300) * 1024 * 1024,
      timeoutMs: Number(process.env.PROVIDER_MEDIA_TIMEOUT_MS || 120_000),
    });
    return { buffer: r.buffer, contentType: r.contentType };
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    const why = err instanceof UnsafeUrlError ? `blocked unsafe media URL (${err.reason})` : (err as Error).message;
    throw new ProviderRequestError(o.provider, `Failed to download ${o.what}: ${why}`, status);
  }
}
