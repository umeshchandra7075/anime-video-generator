-- AlterTable: add per-character ElevenLabs voice override, JSON-encoded
-- (voiceId, modelId, stability, similarityBoost, style, speed). NULL means
-- "use the ELEVENLABS_DEFAULT_VOICE_ID / ELEVENLABS_MODEL_ID fallback".
ALTER TABLE "Character" ADD COLUMN "voiceConfig" TEXT;
