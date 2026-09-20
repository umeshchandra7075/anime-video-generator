# Anime Video Generator

Turns a written story into a narrated, subtitled, anime-style video: story
analysis → character design → storyboard → animation → voice-over → music →
subtitles → final MP4 render. Generation is fully asynchronous and durable:
Browser → API → job row in the database → worker → AI providers → FFmpeg →
final MP4, with live progress over SSE (falling back to polling), retry with
backoff, cancellation, and recovery from a worker restart.

This is a real application, not a UI mockup. Nothing renders "success" that
the backend hasn't actually produced: if a provider isn't configured, the UI
shows a clear `PROVIDER_NOT_CONFIGURED` error instead of a fake result, and a
render is only marked complete after the output MP4 is independently
validated (ffprobe confirms a real video stream and positive duration).

## Local development needs nothing but Node

No Docker, no PostgreSQL, no Redis. `npm run dev` alone runs the whole stack:
- **Database**: SQLite via Prisma (`prisma/dev.db`)
- **Job queue**: the worker polls the database directly - no Redis required
- **Object storage**: a local-filesystem driver with HMAC-signed expiring
  URLs, served through `/api/files/[...path]`
- **Rate limiting**: in-process, per-instance
- **Email**: verification/reset links are returned directly in the API
  response and shown in the UI (`DEV_EXPOSE_VERIFICATION_LINKS=true`)
- **Worker**: spawned automatically as a child process by
  `src/instrumentation.ts` when the Next.js server boots

Every one of these has a production-grade opt-in alternative (PostgreSQL,
Redis-backed BullMQ, S3-compatible storage, Redis-backed rate limiting, a
real transactional email provider) - see "Production" below.

## Status

**Working today** (with `OPENAI_API_KEY` + `ELEVENLABS_API_KEY` configured):
account creation with email verification, login, full project/dashboard
flow, AI story analysis, character reference image generation, scene
storyboard + scene images, voice-over narration, subtitle generation, credit
accounting with DB-level idempotency, cancellation, retry with backoff,
worker-restart recovery, admin views.

**Animation, with or without an AI video provider plugged in**: the
*animation* stage renders real AI-generated animated clips (character/
camera/environment motion, not just zoom-and-pan over a still image) when
`VIDEO_PROVIDER` is configured - see `src/lib/ai/providers/video/
ai-video-provider.ts`. With `VIDEO_PROVIDER` unset, or if a configured AI
provider fails, animation instead falls back to a local FFmpeg Ken-Burns
(zoom/pan) clip built from the scene's still image, so generation still
completes end-to-end with zero external video API required - see
`ENABLE_FFMPEG_VIDEO_FALLBACK` in `.env.example` and
`src/lib/pipeline/videoStage.ts`. Every clip, from either path, is
independently validated with ffprobe before it's trusted.

**Music/SFX still requires a provider you plug in**: the *music* stage
(`MUSIC_PROVIDER`) is unset by default; generation falls back to a local
procedural audio generator (`ENABLE_LOCAL_AUDIO_FALLBACK`) rather than
failing, same idea as the video fallback above.

**Voice, timing, lip-sync data and mixing are now audio-first** - see
"Animation & audio engine" below. Every dialogue line gets its own
synthesis in its own speaker's persistent voice, real durations are
measured, and one master timeline per scene drives everything.

**What actually moves a mouth in the final video** depends on your inputs:
layered character rigs (composited from the viseme timeline), or a
video-to-video lip-sync provider for single-speaker scenes. With neither,
the viseme timeline is still generated but *no mouth animation is applied to
the video* and the job says so ("Lip-sync provider is not configured; ...").
Unlike video/music, there is deliberately no FFmpeg imitation of this.

## Architecture

```
Browser (SSE, polling fallback)
        │
        ▼
Next.js API routes ──────► GenerationJob row (SQLite/Postgres)
        │                          ▲  ▲
        ▼                          │  │ heartbeat / claim / cancel-flag
Job queue adapter (notify)         │  │
        │                          │  │
        ▼                          │  │
Generation worker (separate process, polls the DB) ──┘
        │
        ▼
AI providers (text/image/TTS/video/music, behind interfaces)
        │
        ▼
Object storage (local filesystem in dev, S3-compatible in prod)
        │
        ▼
FFmpeg composite → validated MP4 → VideoAsset row
```

- **Frontend + API**: Next.js 14 App Router, TypeScript, Tailwind.
- **Database**: SQLite by default via Prisma (`prisma/schema.prisma`); swap
  the datasource to `postgresql` for production. Every "enum" field is a
  plain `String` column (SQLite has no native enum type) validated against
  `src/lib/domain/enums.ts`, the single source of truth used by both backend
  and frontend. JSON-shaped fields are stored as JSON-encoded strings (see
  `src/lib/domain/json.ts`) for the same reason.
- **Durable jobs**: `GenerationJob` is the single source of truth for
  progress, not an in-memory or Redis-only state. `leaseOwner`/
  `heartbeatAt`/`leaseExpiresAt` let a stale job (worker crashed/killed) be
  detected and requeued; `activeKey` has a UNIQUE constraint enforcing "one
  active job per project" at the database layer, closing the double-click/
  double-tab/retry race that a plain check-then-act can't. Claiming a job is
  a single atomic conditional `UPDATE`, race-safe on SQLite and Postgres
  alike without needing row locks (see `src/lib/pipeline/jobTracking.ts`).
- **Job queue**: the worker polls the database on an interval by default
  (`JOB_QUEUE_DRIVER=db-polling`, zero dependencies). `JOB_QUEUE_DRIVER=redis`
  swaps in an optional BullMQ-backed adapter purely as a lower-latency
  dispatch hint for scaling across multiple worker processes in production -
  correctness never depends on it; the database state machine always does.
- **Worker**: `src/workers/generation-worker.ts`, run as its own process
  (`npm run worker:generation`) or spawned automatically for local dev by
  `src/instrumentation.ts`. Every pipeline stage is resumable: a retry after
  a partial failure reuses whatever was already generated (characters,
  scenes, per-scene images/clips/voice, music, subtitles) instead of
  duplicating it or re-billing provider calls.
- **AI providers**: abstracted behind interfaces in `src/lib/ai/interfaces`,
  selected by `src/lib/ai/factory/provider-factory.ts`. Routes and the
  worker only ever import the factory, never a vendor SDK directly.
- **Object storage**: `src/lib/storage/` - a local-filesystem driver by
  default (HMAC-signed expiring URLs via `/api/files/[...path]`, with
  path-traversal guards), or an S3-compatible driver for production
  (`STORAGE_DRIVER=s3`). All generated media lives here, never assumed to
  persist on the app server's own filesystem in production.
- **Rate limiting**: `src/lib/rateLimiter/` - in-process by default
  (correct for a single instance), Redis-backed for multi-instance
  production (`RATE_LIMIT_DRIVER=redis`).

## Local development

Prerequisites: Node 20+. That's it.

```bash
npm install
cp .env.example .env
# generate two secrets and paste them into .env:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# (run twice, once for AUTH_ACCESS_TOKEN_SECRET, once for AUTH_REFRESH_TOKEN_SECRET)

npx prisma generate
npx prisma migrate dev --name init
npm run dev
```

That's the whole thing - `npm run dev` starts the Next.js server *and* spawns
the generation worker as a child process automatically. Set
`EMBEDDED_WORKER=false` and run `npm run worker:generation` yourself in a
second terminal if you'd rather see its logs separately.

Register an account: since no email provider is configured, the
verification link is returned directly in the API response and shown on the
"check your email" screen (`DEV_EXPOSE_VERIFICATION_LINKS=true` by default
outside production) - click it, then log in.

## Testing

```bash
npm test              # unit tests (no DB needed) + DB-backed integration
                       # tests, which auto-skip without DATABASE_URL
npm run typecheck
npm run lint
```

The integration suite (`tests/integration/`) covers cross-user project
isolation and idempotent credit reservation end to end against a real
database. The unit suite covers credit pricing, duration mapping, password
strength, the pluggable video/music providers correctly refusing to fabricate
output, JSON encode/decode round-tripping, job-status classification, and
the local storage driver's signed-URL logic (including rejecting a tampered
signature, a signature reused for the wrong key, an expired link, and path
traversal attempts).

## Video generation: FFmpeg fallback vs. a real AI video provider

`ProviderFactory.getVideoProvider()` (`src/lib/ai/factory/provider-factory.ts`)
returns `FfmpegVideoProvider` (Ken-Burns zoom/pan over the scene's still
image) whenever `VIDEO_PROVIDER` is unset, and `HttpVideoProvider`
(`src/lib/ai/providers/video/ai-video-provider.ts`) whenever it's set.
`HttpVideoProvider` is a generic, configurable async image-to-video REST
adapter (submit → poll → download), since there's no single universal
video-generation API - point it at whichever vendor you use (Runway, Kling,
Pika, Luma, etc.) via `VIDEO_PROVIDER_BASE_URL`/`VIDEO_PROVIDER_API_KEY`, and
adjust the request/response field mapping inside that file if your vendor's
JSON shape differs from the documented default.

`src/lib/pipeline/videoStage.ts` always tries the configured provider first,
independently validates whatever it returns with ffprobe
(`src/lib/pipeline/ffprobe.ts`), and - unless `ENABLE_FFMPEG_VIDEO_FALLBACK=false`
- automatically retries with `FfmpegVideoProvider` if the AI provider fails
or its output doesn't validate, so a real API outage or misconfiguration
degrades to a still-decent video instead of failing the whole job.

To add a different/second AI video vendor as its own named adapter instead
of using the generic `HttpVideoProvider`: implement
`src/lib/ai/interfaces/video-provider.ts` (`submit()`, `getStatus()`,
optional `cancel()`) in a new file under `src/lib/ai/providers/video/`, and
branch on `VIDEO_PROVIDER` inside `getVideoProvider()` to select it. Nothing
else needs to change - `videoStage.ts`'s polling/validation/fallback logic
works with any `VideoProvider` implementation.

## Adding a music provider

`MUSIC_PROVIDER` is intentionally unset by default - see
`src/lib/ai/providers/music/unconfigured-music-provider.ts`. To wire in a
real one:

1. Implement `src/lib/ai/interfaces/music-provider.ts` in a new file under
   `src/lib/ai/providers/music/` - `submit()` and `getStatus()`.
2. Register it in `src/lib/ai/factory/provider-factory.ts`'s
   `getMusicProvider()` under a new `MUSIC_PROVIDER` value.
3. Set `MUSIC_PROVIDER=<your-value>`, `MUSIC_PROVIDER_API_KEY`, and
   `MUSIC_PROVIDER_BASE_URL` in `.env`.

Nothing else in the app needs to change - the worker, credit system, and UI
already handle the async submit/poll/result lifecycle, retries, and
cancellation.

## Adding a lip-sync provider

`LIPSYNC_PROVIDER` is intentionally unset by default - see
`src/lib/ai/providers/lipsync/unconfigured-lipsync-provider.ts`. Without it,
generation still completes end to end: each scene keeps its plain animation
clip from the video stage (real AI clip or FFmpeg Ken-Burns) without
mouth animation, and the job records that the provider is not configured. Unlike the video/music
stages, there's no local, dependency-free fallback here - real audio-driven
lip sync needs a trained model, not something FFmpeg alone can credibly fake
- so this stage is a pure enhancement: configured and working, or skipped
entirely, never a degraded imitation.

To wire in a real one (sync.so, D-ID, HeyGen, a hosted Wav2Lip/SadTalker
instance, etc.):

1. If your vendor speaks the generic submit/poll/download shape already
   implemented in `src/lib/ai/providers/lipsync/http-lipsync-provider.ts`
   (`HttpLipSyncProvider`), just point it at them - adjust `buildSubmitBody`/
   `parseStatusResponse` in that file if their JSON field names differ from
   the documented default.
2. Otherwise implement `src/lib/ai/interfaces/lipsync-provider.ts` yourself
   in a new file under `src/lib/ai/providers/lipsync/`, and branch on
   `LIPSYNC_PROVIDER` inside `ProviderFactory.getLipSyncProvider()`
   (`src/lib/ai/factory/provider-factory.ts`) to select it.
3. Set `LIPSYNC_PROVIDER`, `LIPSYNC_PROVIDER_API_KEY`, and
   `LIPSYNC_PROVIDER_BASE_URL` in `.env`.

Nothing else needs to change - `src/lib/pipeline/lipSyncStage.ts` sends the
provider the **animated scene clip** (video-to-video) plus **only the
speaking character's own dialogue** placed on the scene timeline - never a
reference-image portrait, and never narration - and only for scenes with a
single speaker (a generic single-face provider cannot tell whose mouth to
drive in a two-person scene, so those are skipped with the reason recorded).
It retries transient errors, polls with a timeout (cancelling the provider job
on timeout), validates the returned file, stores it as a `LIP_SYNC_CLIP`, and
keeps the plain animated clip if anything fails - a provider outage never fails
the render, and the failure is recorded in `Scene.componentIssues`. The
composite stage prefers `LIP_SYNC_CLIP` as the scene's video source and always
uses the master mix for audio. Set `ENABLE_LIPSYNC=false` to turn the stage off.

## Animation & audio engine (audio-first)

Code: `src/lib/engine/*` (dependency-free, unit-tested with real FFmpeg).
Pipeline order is now **story -> characters -> storyboard -> voice -> animation
-> lip-sync -> music -> subtitles -> render**: voices come first so every
duration is a measurement, not an estimate.

- **Dialogue** (`dialogue.ts`, `voicePipeline.ts`): one TTS call per line, bound to that
  speaker's persistent voice (`Character.voiceConfig`, cast once from
  `VOICE_POOL_JSON` / OpenAI's named voices and never re-cast). Unknown speakers get the default voice and
  a recorded issue - never another character's voice. Deterministic cache
  (`characterId, provider, model, voice, text, emotion, speed, pitch, ...`), retry/backoff/timeout, a failed
  line is skipped and recorded, a missing key fails the job with "ElevenLabs API key is not configured."
- **Emotion** (`emotion.ts`): 16 emotions -> rate/pitch/pauses/expression/gesture profile. Only parameters a
  provider *declares* are sent (ElevenLabs: speed, stability, style; OpenAI: speed + instructions); the rest are
  reported as ignored. Pitch is not controllable on either provider.
- **Master timeline** (`timeline.ts`, `Scene.timeline`): dialogue windows from measured audio, scene length snapped to
  whole frames (no A/V drift), viseme tracks, per-character actor tracks (talking / listening / reacting / idle, blinks,
  gaze, nods, gestures, expression changes), contextual camera plan, SFX, music cue. `validateTimeline` enforces invariants.
- **Visemes** (`visemes.ts`, `g2p.ts`): 16 mouth shapes from text rules aligned to the **measured audio** (speech regions,
  pauses snap word boundaries; provider character timestamps are used when returned; amplitude-driven fallback for
  languages without rules). Mouth = REST wherever the audio is silent.
- **Camera** (`camera.ts`): deterministic shot/move selection from scene context, rendered as smooth `zoompan`.
- **Audio** (`mixer.ts`, `sfx.ts`): dialogue chain (HPF, gentle compression, EQ, two-pass loudness), procedural SFX placed in
  dialogue gaps, level-calibrated, music and SFX sidechain-ducked by dialogue, two-pass master loudness.
- **Render** (`render.ts`, `projectRender.ts`): every scene is normalised to identical stream parameters before the final
  stream-copy assembly (mixed AI/fallback clips are safe). `validate.ts` checks codec, geometry, fps, planned length,
  audio/video agreement and a full decode; a failing file fails the job.
- **Layered rigs** (`puppet.ts`): characters that have a rig in `Character.providerMetadata.rig` get mouths, blinks,
  expressions and subtle head motion composited from the timeline.

**Limitations - read these.** The image/video providers return *flat* pictures, so nothing here can segment them
into a rig: without rigs or a lip-sync provider there is no mouth animation in the video. Body animation beyond
subtle head/breathing motion (walking, pointing, attacks, ...) is **not implemented**; expression changes are sprite
swaps, not interpolated. Background parallax/weather layers are not implemented (only camera motion). Overlapping
speech (interruptions) is not supported - lines are sequential. Google/Azure TTS are declared but not implemented.
SFX are procedural (functional, not cinematic). The Voice Studio / Lip-Sync Editor / timeline UI is not built.
`ELEVENLABS_USE_TIMESTAMPS` has not been exercised against the live API.

Tests: `npm run test:engine` (unit + real-FFmpeg tests), `npm run test:video` (renders a full multi-scene test video
with synthetic voices/art to `./test-output/` and inspects the resulting MP4).

## Production

Run as separate services:

| Service | What it does | Notes |
|---|---|---|
| `next start` (or a Next.js host) | Frontend + API routes | Stateless, horizontally scalable. Set `EMBEDDED_WORKER=false`. |
| `npm run worker:generation` | Generation pipeline + FFmpeg | Needs CPU for FFmpeg; scale by `GENERATION_WORKER_CONCURRENCY` and running more replicas |
| PostgreSQL | Primary datastore | Change `provider = "postgresql"` in `prisma/schema.prisma`, run `prisma migrate deploy` on release |
| Redis (optional) | Faster job dispatch + shared rate limiting across instances | `JOB_QUEUE_DRIVER=redis`, `RATE_LIMIT_DRIVER=redis` |
| S3-compatible bucket | Generated media | `STORAGE_DRIVER=s3`; keep the bucket private, the app only ever issues signed URLs |

Set `NODE_ENV=production` and `MOCK_AI=false`; `DEV_EXPOSE_VERIFICATION_LINKS`
is automatically ignored in production regardless of its value - a real
`EMAIL_API_KEY` is required or users never receive verification/reset
emails (a warning is logged, but nothing is silently faked).

## API overview

All responses are `{ success: true, data }` or
`{ success: false, error: { code, message } }` - including on an unexpected
server error (e.g. a misconfigured database): every route's Prisma client
access is lazily initialized (`src/lib/db.ts`) specifically so a connection
failure surfaces inside that route's own try/catch instead of crashing
Next's module loader and leaking a raw stack trace. Every protected route
performs its own authorization check server-side (`src/lib/auth/context.ts`)
- nothing relies on the frontend to hide access.

```
POST   /api/auth/register
POST   /api/auth/verify-email
POST   /api/auth/login
POST   /api/auth/logout
POST   /api/auth/refresh
POST   /api/auth/forgot-password
POST   /api/auth/reset-password
GET    /api/user

GET    /api/dashboard

GET    /api/projects
POST   /api/projects
GET    /api/projects/:id
PATCH  /api/projects/:id
DELETE /api/projects/:id            (soft delete)
POST   /api/projects/:id/duplicate
POST   /api/projects/:id/generate   (idempotent - DB-unique-constraint-safe against races)
POST   /api/projects/:id/cancel     (race-safe against a worker claiming the job concurrently)
GET    /api/projects/:id/status     (polling fallback)
GET    /api/projects/:id/status/stream  (SSE - preferred; client reconnects with backoff)
GET    /api/projects/:id/scenes
GET    /api/projects/:id/video      (signed playback URL)
GET    /api/projects/:id/download   (signed download URLs)

PATCH  /api/scenes/:id
DELETE /api/scenes/:id
POST   /api/scenes/:id/retry
POST   /api/scenes/:id/regenerate

GET    /api/admin/users             (admin only)
GET    /api/admin/jobs              (admin only)

GET    /api/files/[...path]         (serves local-storage-driver files via signed URL only)
```

## Docker / deployment

Local development doesn't need Docker (see above), but a `docker-compose.yml`
is provided for production-parity testing against real Postgres/Redis/MinIO,
and `deploy/Dockerfile.web` / `deploy/Dockerfile.worker` for actual
deployment:

```bash
cp .env.example .env   # fill in AUTH_ACCESS_TOKEN_SECRET / AUTH_REFRESH_TOKEN_SECRET at minimum
docker compose up --build
docker compose exec web npx prisma db push --schema=prisma/schema.production.prisma
```

Two Prisma schema files exist because the `provider` field can't be
environment-driven - only the connection URL can: `prisma/schema.prisma`
(SQLite, the local-dev default) and `prisma/schema.production.prisma`
(Postgres, used by the Dockerfiles and this compose file). They're kept in
sync manually; only the `datasource` block differs. `db push` is used
instead of `migrate deploy` for the Postgres path specifically because
Prisma's migration history directory (`prisma/migrations`) is shared by
folder location regardless of which schema generates it, and SQLite/Postgres
migration SQL isn't interchangeable - so the two schemas can't safely share
one migration history. A real production deployment wanting full Postgres
migration history should maintain a fully separate Prisma directory instead.

`/api/health` is a liveness probe (process is up, no dependencies checked).
`/api/ready` is a readiness probe (confirms the database is actually
reachable) - point your orchestrator's readiness check at that one, not
`/health`, or you'll route traffic to an instance that can't serve it.

## Additional pages

- `/history` - past generation jobs across all projects, with status and error detail
- `/assets` - a media library of finished videos and character reference images across projects (signed URLs, same as the project video player)
- `/profile` - view/update your name, see account info
- `/settings` - change password (revokes other sessions, matching a forgot-password reset), permanently delete account (cascades via Prisma relations, requires re-entering your password)
- `/ai-chat` - a real conversational story-brainstorming assistant, calling `TextProvider.chat()` (OpenAI); rate-limited per user (20 messages/hour) since each call costs real provider spend

## Known environment caveat from this build session

`prisma generate` requires downloading a query-engine binary from
`binaries.prisma.sh`. If your environment blocks that host, generation (and
therefore any database access) will fail with `@prisma/client did not
initialize yet`; this is unrelated to this codebase and won't occur on a
normal machine or CI runner with regular internet access.

