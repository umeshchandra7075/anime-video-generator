// SSRF-safe server-side download for URLs that come from a third-party API
// response (e.g. a video/lip-sync provider's "video_url"). Guarantees:
//  - https only (http opt-in), no credentials in the URL
//  - host must resolve ONLY to public addresses (blocks loopback, RFC1918,
//    link-local incl. cloud metadata 169.254.169.254, CGNAT, multicast, ULA,
//    IPv4-mapped/NAT64 IPv6 wrappers of the same)
//  - optional host allowlist
//  - every redirect hop is re-validated; redirects are capped
//  - provider credentials are attached ONLY when the URL's origin equals the
//    provider's own origin (never to a CDN or a redirected host)
//  - per-request timeout and hard byte cap while streaming
// Known limit: DNS is resolved once for validation and again by fetch();
// a rebinding attacker with a short TTL could in theory differ between the
// two. Mitigate further with an egress firewall or a pinned-IP undici agent.
import dns from "node:dns/promises";
import net from "node:net";

export class UnsafeUrlError extends Error {
  constructor(message: string, public readonly reason: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export interface SafeFetchOptions {
  allowedHosts?: string[]; // "cdn.vendor.com" exact or ".vendor.com" suffix; empty/undefined => any PUBLIC host
  allowHttp?: boolean;
  maxBytes?: number; // default 300 MB
  timeoutMs?: number; // default 120 s
  maxRedirects?: number; // default 3
  headers?: Record<string, string>;
  /** Credentials, attached only when the request origin === authOrigin. */
  authHeaders?: Record<string, string>;
  authOrigin?: string;
  /** Additional origins (explicit opt-in) that may receive `authHeaders`. */
  authOrigins?: string[];
  /** Skip the private-address block. For local development against a provider on localhost ONLY;
   * callers must refuse to set this in production. */
  allowPrivateNetwork?: boolean;
  fetchImpl?: typeof fetch;
  lookup?: (host: string) => Promise<Array<{ address: string; family: number }>>;
}

export interface SafeDownload {
  buffer: Buffer;
  contentType: string | null;
  finalUrl: string;
}

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : null;
}

function parseIPv6(ip: string): number[] | null {
  let addr = ip.split("%")[0] ?? ip; // strip zone id
  // embedded IPv4 tail (::ffff:1.2.3.4)
  const lastColon = addr.lastIndexOf(":");
  const tail = addr.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    addr = addr.slice(0, lastColon + 1) +
      ((v4[0]! << 8) | v4[1]!).toString(16) + ":" + ((v4[2]! << 8) | v4[3]!).toString(16);
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  const missing = 8 - head.length - rest.length;
  if ((halves.length === 1 && head.length !== 8) || missing < 0) return null;
  const groups = halves.length === 2 ? [...head, ...Array(missing).fill("0"), ...rest] : head;
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push(v >> 8, v & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

function isPrivateIPv4(b: number[]): boolean {
  const [a, c] = [b[0]!, b[1]!];
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && c >= 64 && c <= 127) ||
    (a === 169 && c === 254) ||
    (a === 172 && c >= 16 && c <= 31) ||
    (a === 192 && c === 0 && b[2] === 0) ||
    (a === 192 && c === 168) ||
    (a === 198 && (c === 18 || c === 19)) ||
    a >= 224
  );
}

/** True for any address that must never be fetched by server-side code. */
export function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    const b = parseIPv4(ip);
    return b ? isPrivateIPv4(b) : true;
  }
  if (family === 6) {
    const b = parseIPv6(ip);
    if (!b) return true;
    const allZeroPrefix = b.slice(0, 10).every((x) => x === 0);
    if (allZeroPrefix && b[10] === 0xff && b[11] === 0xff) return isPrivateIPv4(b.slice(12)); // ::ffff:a.b.c.d
    if (b.slice(0, 15).every((x) => x === 0) && (b[15] === 0 || b[15] === 1)) return true; // :: and ::1
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) {
      return isPrivateIPv4(b.slice(12)); // NAT64 64:ff9b::/96
    }
    if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7 ULA
    if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
    if (b[0] === 0xff) return true; // multicast
    return false;
  }
  return true; // not an IP => caller bug; fail closed
}

function hostAllowed(host: string, allowed?: string[]): boolean {
  if (!allowed || allowed.length === 0) return true;
  const h = host.toLowerCase();
  return allowed.some((a) => {
    const rule = a.toLowerCase();
    return rule.startsWith(".") ? h === rule.slice(1) || h.endsWith(rule) : h === rule;
  });
}

let lookupOverride: SafeFetchOptions["lookup"] | null = null;
/** Test hook: lets unit tests use non-resolvable hostnames. Never used in production code paths. */
export function __setLookupForTests(fn: SafeFetchOptions["lookup"] | null) { lookupOverride = fn; }

async function defaultLookup(host: string) {
  if (lookupOverride) return lookupOverride(host);
  return dns.lookup(host, { all: true, verbatim: true });
}

export async function assertPublicUrl(rawUrl: string, opts: SafeFetchOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError("Invalid URL.", "INVALID_URL");
  }
  if (url.protocol !== "https:" && !(opts.allowHttp && url.protocol === "http:")) {
    throw new UnsafeUrlError(`Blocked URL scheme "${url.protocol}".`, "BAD_SCHEME");
  }
  if (url.username || url.password) throw new UnsafeUrlError("Credentials in URL are not allowed.", "URL_CREDENTIALS");

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostAllowed(host, opts.allowedHosts)) throw new UnsafeUrlError(`Host "${host}" is not on the allowlist.`, "HOST_NOT_ALLOWED");
  if (opts.allowPrivateNetwork) return url; // dev-only escape hatch (see option docs)
  if (/^localhost$/i.test(host) || /\.(local|internal|localdomain|home\.arpa)$/i.test(host)) {
    throw new UnsafeUrlError("Blocked internal hostname.", "INTERNAL_HOST");
  }

  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new UnsafeUrlError("Blocked private/loopback address.", "PRIVATE_ADDRESS");
    return url;
  }
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await (opts.lookup ?? defaultLookup)(host);
  } catch {
    throw new UnsafeUrlError(`Could not resolve host "${host}".`, "DNS_FAILURE");
  }
  if (addrs.length === 0) throw new UnsafeUrlError(`Host "${host}" did not resolve.`, "DNS_FAILURE");
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) throw new UnsafeUrlError("Host resolves to a private/loopback address.", "PRIVATE_ADDRESS");
  }
  return url;
}

async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new UnsafeUrlError(`Response too large (${declared} bytes > ${maxBytes}).`, "TOO_LARGE");
  }
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new UnsafeUrlError(`Response exceeded ${maxBytes} bytes.`, "TOO_LARGE");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export async function safeDownload(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeDownload> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? 300 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 3;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
  try {
    let current = rawUrl;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const url = await assertPublicUrl(current, opts);
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      if (opts.authHeaders && (url.origin === opts.authOrigin || (opts.authOrigins ?? []).includes(url.origin))) Object.assign(headers, opts.authHeaders);

      let res: Response;
      try {
        res = await fetchImpl(url.toString(), { method: "GET", headers, redirect: "manual", signal: controller.signal });
      } catch (err) {
        if (controller.signal.aborted) throw new Error("Download timed out.");
        throw new Error(`Network error while downloading media: ${(err as Error).message}`);
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        await res.body?.cancel().catch(() => undefined);
        if (!loc) throw new UnsafeUrlError("Redirect without Location header.", "BAD_REDIRECT");
        current = new URL(loc, url).toString(); // re-validated at top of the loop
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        const e = new Error(`Media download failed with status ${res.status}.`) as Error & { statusCode: number };
        e.statusCode = res.status;
        throw e;
      }
      const buffer = await readCapped(res, maxBytes);
      return { buffer, contentType: res.headers.get("content-type"), finalUrl: url.toString() };
    }
    throw new UnsafeUrlError(`Too many redirects (> ${maxRedirects}).`, "TOO_MANY_REDIRECTS");
  } finally {
    clearTimeout(timer);
  }
}
