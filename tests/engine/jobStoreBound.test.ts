import { describe, it, expect } from "vitest";
// The FFmpeg fallback provider's job store must stay bounded (regression: it grew forever, holding every clip as base64).
import fs from "node:fs";
describe("ffmpeg-video-provider job store", () => {
  it("is bounded by age and entry count (source-level guard against re-introducing the unbounded Map)", () => {
    const src = fs.readFileSync("src/lib/ai/providers/video/ffmpeg-video-provider.ts", "utf8");
    expect(src).toMatch(/JOB_MAX_ENTRIES\s*=\s*\d+/);
    expect(src).toMatch(/JOB_TTL_MS\s*=/);
    expect(src).not.toMatch(/const jobs = new Map<string, VideoJobResult>\(\)/);
  });
});
