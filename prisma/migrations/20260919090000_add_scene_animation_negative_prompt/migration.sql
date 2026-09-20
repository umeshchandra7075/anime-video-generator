-- AlterTable: what the AI video provider should avoid generating for a
-- scene (identity drift, extra limbs, jump cuts, etc.) - see
-- src/lib/pipeline/videoStage.ts and the improved Gemini prompt in
-- gemini-text-provider.ts.
ALTER TABLE "Scene" ADD COLUMN "animationNegativePrompt" TEXT;
