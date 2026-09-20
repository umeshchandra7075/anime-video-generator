import { describe, it, expect, beforeAll } from "vitest";
import { buildSignedPath, verifySignedRequest } from "@/lib/storage/localFsSigning";
import { assertSafeStorageKey } from "@/lib/storage/types";

beforeAll(() => {
  process.env.STORAGE_LOCAL_SIGNING_SECRET = "test-signing-secret-not-for-production";
});

describe("local storage signed URLs", () => {
  it("accepts a freshly signed, unexpired request", () => {
    const path = buildSignedPath("projects/abc/final-videos/output.mp4", 60);
    const url = new URL(path, "http://localhost");
    const ok = verifySignedRequest(
      "projects/abc/final-videos/output.mp4",
      url.searchParams.get("exp"),
      url.searchParams.get("sig"),
    );
    expect(ok).toBe(true);
  });

  it("rejects a request with a tampered signature", () => {
    const path = buildSignedPath("projects/abc/final-videos/output.mp4", 60);
    const url = new URL(path, "http://localhost");
    const ok = verifySignedRequest(
      "projects/abc/final-videos/output.mp4",
      url.searchParams.get("exp"),
      "0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(ok).toBe(false);
  });

  it("rejects a request for a different key than it was signed for", () => {
    const path = buildSignedPath("projects/abc/final-videos/output.mp4", 60);
    const url = new URL(path, "http://localhost");
    const ok = verifySignedRequest(
      "projects/other-project/final-videos/output.mp4",
      url.searchParams.get("exp"),
      url.searchParams.get("sig"),
    );
    expect(ok).toBe(false);
  });

  it("rejects an expired signature", () => {
    const path = buildSignedPath("projects/abc/final-videos/output.mp4", -10); // already expired
    const url = new URL(path, "http://localhost");
    const ok = verifySignedRequest(
      "projects/abc/final-videos/output.mp4",
      url.searchParams.get("exp"),
      url.searchParams.get("sig"),
    );
    expect(ok).toBe(false);
  });

  it("rejects a request missing the signature or expiry params", () => {
    expect(verifySignedRequest("projects/abc/output.mp4", null, "somesig")).toBe(false);
    expect(verifySignedRequest("projects/abc/output.mp4", "9999999999999", null)).toBe(false);
  });
});

describe("assertSafeStorageKey (path traversal protection)", () => {
  it("accepts well-formed keys", () => {
    expect(() => assertSafeStorageKey("projects/abc-123/scenes/1/image.png")).not.toThrow();
  });

  it("rejects path traversal attempts", () => {
    expect(() => assertSafeStorageKey("../../etc/passwd")).toThrow();
    expect(() => assertSafeStorageKey("projects/../../secrets")).toThrow();
  });

  it("rejects absolute paths", () => {
    expect(() => assertSafeStorageKey("/etc/passwd")).toThrow();
  });

  it("rejects backslashes and unsupported characters", () => {
    expect(() => assertSafeStorageKey("projects\\abc\\file.png")).toThrow();
    expect(() => assertSafeStorageKey("projects/abc/<script>.png")).toThrow();
  });
});
