import { describe, it, expect } from "vitest";
import { isPrivateAddress, assertPublicUrl, safeDownload, UnsafeUrlError } from "../../src/lib/engine/safeFetch";

const pub = async () => [{ address: "93.184.216.34", family: 4 }];

describe("isPrivateAddress", () => {
  it("blocks loopback, RFC1918, link-local (cloud metadata), CGNAT, multicast", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });
  it("allows ordinary public IPv4", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.63.255.255", "11.0.0.1"]) expect(isPrivateAddress(ip)).toBe(false);
  });
  it("handles IPv6 loopback, ULA, link-local and IPv4-mapped / NAT64 wrappers", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "64:ff9b::a00:1", "::ffff:7f00:1"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
  });
});

describe("assertPublicUrl", () => {
  it("rejects http by default, credentials, localhost, .internal, literal private IPs", async () => {
    await expect(assertPublicUrl("http://example.com/a.mp4", { lookup: pub })).rejects.toThrow(/scheme/);
    await expect(assertPublicUrl("https://user:pw@example.com/a", { lookup: pub })).rejects.toThrow(/Credentials/);
    await expect(assertPublicUrl("https://localhost/a", { lookup: pub })).rejects.toThrow(/internal/);
    await expect(assertPublicUrl("https://svc.internal/a", { lookup: pub })).rejects.toThrow(/internal/);
    await expect(assertPublicUrl("https://169.254.169.254/latest/meta-data", { lookup: pub })).rejects.toThrow(/private/);
    await expect(assertPublicUrl("https://[::1]/a", { lookup: pub })).rejects.toThrow(/private/);
  });
  it("rejects a public-looking hostname that RESOLVES to a private IP (DNS rebinding style)", async () => {
    const evil = async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }];
    await expect(assertPublicUrl("https://evil.example.com/a", { lookup: evil })).rejects.toThrow(/private/);
  });
  it("enforces the host allowlist (exact and suffix rules)", async () => {
    const o = { lookup: pub, allowedHosts: ["cdn.vendor.com", ".media.vendor.net"] };
    await assertPublicUrl("https://cdn.vendor.com/x", o);
    await assertPublicUrl("https://a.media.vendor.net/x", o);
    await expect(assertPublicUrl("https://evil.com/x", o)).rejects.toThrow(/allowlist/);
    await expect(assertPublicUrl("https://notcdn.vendor.com/x", o)).rejects.toThrow(/allowlist/);
  });
});

function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: { ...((init.headers as Record<string, string>) ?? {}) } });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("safeDownload", () => {
  it("attaches provider credentials ONLY to the provider's own origin", async () => {
    const { impl, calls } = fakeFetch(() => new Response("ok", { status: 200, headers: { "content-type": "video/mp4" } }));
    const auth = { authHeaders: { Authorization: "Bearer SECRET" }, authOrigin: "https://api.vendor.com", fetchImpl: impl, lookup: pub };
    await safeDownload("https://api.vendor.com/v1/out.mp4", auth);
    await safeDownload("https://cdn.thirdparty.com/out.mp4", auth);
    expect(calls[0]!.headers.Authorization).toBe("Bearer SECRET");
    expect(calls[1]!.headers.Authorization).toBeUndefined();
  });
  it("drops credentials when a redirect leaves the provider origin", async () => {
    const { impl, calls } = fakeFetch((url) =>
      url.startsWith("https://api.vendor.com")
        ? new Response(null, { status: 302, headers: { location: "https://files.other.com/x.mp4" } })
        : new Response("data", { status: 200 }));
    const r = await safeDownload("https://api.vendor.com/job/1/result", { authHeaders: { Authorization: "Bearer SECRET" }, authOrigin: "https://api.vendor.com", fetchImpl: impl, lookup: pub });
    expect(r.buffer.toString()).toBe("data");
    expect(calls[0]!.headers.Authorization).toBe("Bearer SECRET");
    expect(calls[1]!.headers.Authorization).toBeUndefined();
  });
  it("re-validates redirect targets: a redirect to cloud metadata is blocked", async () => {
    const { impl } = fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data/iam" } }));
    await expect(safeDownload("https://api.vendor.com/x", { fetchImpl: impl, lookup: pub })).rejects.toThrow(/private/);
  });
  it("caps redirects", async () => {
    const { impl } = fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://api.vendor.com/again" } }));
    await expect(safeDownload("https://api.vendor.com/x", { fetchImpl: impl, lookup: pub, maxRedirects: 2 })).rejects.toThrow(/redirects/);
  });
  it("enforces the byte cap both via content-length and while streaming", async () => {
    const big = fakeFetch(() => new Response("x".repeat(100), { status: 200, headers: { "content-length": "100" } }));
    await expect(safeDownload("https://a.com/x", { fetchImpl: big.impl, lookup: pub, maxBytes: 50 })).rejects.toThrow(/too large/i);
    const noLen = fakeFetch(() => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(40)); c.enqueue(new Uint8Array(40)); c.close(); } }), { status: 200 }));
    await expect(safeDownload("https://a.com/x", { fetchImpl: noLen.impl, lookup: pub, maxBytes: 50 })).rejects.toThrow(/exceeded/);
  });
  it("surfaces HTTP status on failure so retry logic can classify it", async () => {
    const { impl } = fakeFetch(() => new Response("nope", { status: 503 }));
    await expect(safeDownload("https://a.com/x", { fetchImpl: impl, lookup: pub })).rejects.toThrow(/503/);
  });
  it("times out a hung download", async () => {
    const hang = (async (_u: string, init: RequestInit) => new Promise<Response>((_, rej) => { (init.signal as AbortSignal).addEventListener("abort", () => rej(new Error("aborted"))); })) as unknown as typeof fetch;
    await expect(safeDownload("https://a.com/x", { fetchImpl: hang, lookup: pub, timeoutMs: 50 })).rejects.toThrow(/timed out/);
  });
  it("UnsafeUrlError carries a machine-readable reason", async () => {
    try { await assertPublicUrl("https://10.0.0.1/x"); } catch (e) { expect(e).toBeInstanceOf(UnsafeUrlError); expect((e as UnsafeUrlError).reason).toBe("PRIVATE_ADDRESS"); return; }
    throw new Error("should have thrown");
  });
});
