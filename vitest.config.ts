import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The engine tests render real audio/video with FFmpeg (the end-to-end test builds a full multi-scene MP4 in beforeAll).
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
