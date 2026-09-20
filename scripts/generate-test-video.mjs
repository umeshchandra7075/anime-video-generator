// Generates a real multi-scene test video through the whole engine and keeps the artifacts.
//   npm run test:video            -> ./test-output/anime-test-video.mp4 (+ timelines.json, render-report.json, subtitles.srt, stems/)
// Uses SYNTHETIC pitch-distinct test voices and synthetic layered test art (no API keys, no network).
// It exercises: per-segment voices, measured durations, master timeline, viseme lip-sync, listener reactions, blinks,
// contextual camera, procedural SFX, ducked music, two-pass loudness, FFmpeg composition and full validation.
import { spawnSync } from "node:child_process";
import path from "node:path";
const out = path.resolve(process.argv[2] ?? "test-output");
const r = spawnSync(process.execPath, [path.resolve("node_modules/vitest/vitest.mjs"), "run", "tests/engine/e2e.test.ts"], { stdio: "inherit", env: { ...process.env, E2E_OUT: out } });
if (r.status === 0) console.log(`\nDone. Open ${path.join(out, "anime-test-video.mp4")}`);
process.exit(r.status ?? 1);
