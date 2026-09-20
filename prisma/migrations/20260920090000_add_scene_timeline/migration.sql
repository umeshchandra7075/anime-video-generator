-- AlterTable: authoritative per-scene master timeline (JSON) and per-component
-- issues (JSON) - see src/lib/engine/types.ts and src/lib/pipeline/timelineStage.ts.
ALTER TABLE "Scene" ADD COLUMN "timeline" TEXT;
ALTER TABLE "Scene" ADD COLUMN "componentIssues" TEXT;
