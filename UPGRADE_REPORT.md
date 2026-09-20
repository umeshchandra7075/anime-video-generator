# Upgrade report - audio-first animation & audio engine

Scope note: this environment had **no network and no npm** (`npm install` is blocked), so `next build`, `eslint`,
`prisma generate/migrate` and the project's own `vitest` could NOT be run. Verification used Node 22 + the TypeScript
compiler + FFmpeg 6.1 directly (see "How things were verified"). Please run `npm run typecheck`, `npm run lint`,
`npm run build` and `npm test` yourself; nothing below claims those passed.

## SECURITY - action required
The uploaded ZIP contained a `.env` with values shaped like real credentials (Gemini, Hugging Face, Pollinations,
ElevenLabs). It has been removed from this package. **Treat those keys as exposed and rotate them.**
Also fixed: provider result URLs were downloaded from any host with the provider API key attached (credential leak +
SSRF); see `src/lib/ai/providers/mediaDownload.ts`. Existing tests asserted the leaking behaviour and were changed.

## Defects found in the original and fixed (each reproduced or shown by a test)
1. One MP3 per scene in the FIRST speaker's voice -> per-segment synthesis in each speaker's own voice.
2. Animation ran before voice, durations were estimates -> voice first, durations measured, one master timeline.
3. `-c copy` concat of clips with different resolution/fps corrupted output (reproduced: wrong geometry, non-monotonic DTS,
   ~27% frames lost) -> every scene normalised to identical stream parameters.
4. Lip-sync replaced the scene with a portrait talking head (single speaker) -> video-to-video on the animated clip,
   single-speaker scenes only, speaker's audio only; otherwise honest "not applied".
5. Music at a flat 18%, no ducking, no loudness normalisation -> sidechain ducking (music AND SFX), two-pass loudness.
6. `VideoAsset.resolution` was a label ("1920x1080") not the real output -> real validated geometry.
7. SSRF / API-key leak on provider result URLs; no fetch timeouts -> guarded downloader, timeouts.
8. FFmpeg provider job map grew forever (memory leak) -> TTL + size bound.
9. Subtitles spread evenly over ESTIMATED durations -> exact measured windows.
Bugs I introduced and caught while building (kept as regression tests): silent-e rule deleting the vowel of "the";
greedy pause-snapping choosing the wrong pause; loudnorm-before-adelay losing delay/padding on FFmpeg 6.1; loudness
measured on a different signal than it was applied to; near-silence amplified by 54 dB; SFX louder than speech and
stacked on line onsets; crossfade that would have desynchronised audio (renamed `dip`).

## Test results
Runnable here: **263 passed, 0 failed** (202 new engine/stage tests in `tests/engine`, 61 existing unit tests that load here).
Full end-to-end (`tests/engine/e2e.test.ts`): 13/13 at 720p and at 1080p (1920x1080, H.264 High, yuv420p, 24 fps, AAC 48k).
Not runnable here (same 6 files failed before any change; environment only): `creditAndValidation` (bcryptjs), `ffprobe`
(ffmpeg-static), `providerFactory` (@google/genai), `musicStageFallback` / `videoStage` (vi.mock), `dbBackedRules`
(describe.skipIf). `tests/unit/videoStage.test.ts` gained one test that I could not execute.
Removed: `tests/unit/voiceStage.test.ts`, `tests/unit/lipSyncStage.test.ts`, `tests/integration/compositeFinalVideo.realRender.test.ts`
(they asserted removed behaviour - first-speaker voice, portrait submission - and the old composite signature; replaced by
`tests/engine/{voiceStage,lipSyncStage,compositeStage}.test.ts`). Critical mutation checks were run (see below).

## Verified vs not verified
Verified by execution (real FFmpeg / real code): dialogue placement (+/-16 ms in the final MP4), per-speaker pitch in the
final audio, mouth pixels per rendered frame vs the viseme timeline (through camera motion), A/V sync (<=80 ms), listener
expressions and blinks, camera vs reference model, ducking depth/recovery, loudness (~-16 LUFS, no clipping), SFX
placement, final MP4 validation (incl. negative cases), cache hits/misses, retry/timeout/failure isolation, SSRF blocks.
Verified only against mocks: OpenAI TTS, ElevenLabs (existing + new tests), HTTP video/lip-sync providers.
NOT verified: any live provider call; voice naturalness (tests use SYNTHETIC pitch-distinct buzz, not speech); viseme
accuracy on real speech (measured only on synthetic audio with known word windows); the Prisma migration; the worker
(`generation-worker.ts`) and the non-injected default dependency paths of the stages (stages were executed with in-memory
fakes for db/storage/providers); ESLint; `next build`. The test video uses SYNTHETIC flat-colour rig art: it proves the
compositor, not anime visuals.

## Not implemented (from the brief)
UI: Dashboard/Voice Studio/Lip-Sync Editor/Scene Editor/Timeline/Render Queue pages. Per-component regenerate endpoints/buttons
(re-running a stage reuses cached assets, so partial regeneration works at the stage level, but there is no API/UI).
Body animation states beyond IDLE/TALKING/LISTENING/REACTION with subtle head/breathing motion (no walking, pointing,
attacks, ...). Interpolated expression transitions (sprite swaps). Background parallax / weather layers. Overlapping speech.
Google/Azure TTS. Automatic rig creation from flat AI images. Rate limiting beyond the existing auth/chat routes.
Object-storage streaming for provider transfers (still base64 in memory between provider and stage). `SFXProvider` /
`MusicProvider` interfaces beyond the existing ones (SFX are procedural). The lip-sync adapter keeps the existing
`submit/getStatus/cancel` interface rather than the renamed `createJob/...` list in the brief.
`ELEVENLABS_USE_TIMESTAMPS` (word-accurate alignment) is implemented but untested against the live API.

## Migration / run
1. `npx prisma generate && npx prisma migrate deploy` (adds `Scene.timeline`, `Scene.componentIssues`; both schema files updated).
2. Set `ELEVENLABS_API_KEY` (or `TTS_PROVIDER=openai` + `OPENAI_API_KEY`) and, for distinct voices, `VOICE_POOL_JSON`. See `.env.example`.
3. `npm run test:engine` - `npm run test:video` (writes `./test-output/anime-test-video.mp4`, `timelines.json`, `render-report.json`).
