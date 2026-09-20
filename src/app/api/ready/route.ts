import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * Readiness probe: answers "can this instance actually serve real traffic
 * right now" by confirming the database is reachable. An orchestrator uses
 * this to decide whether to route traffic to this instance (distinct from
 * /api/health, which only confirms the process itself is alive) - e.g.
 * during a rolling deploy, before the schema migration has finished, or if
 * the database connection pool is exhausted.
 */
export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return NextResponse.json({ success: true, data: { status: "ready", database: "ok" } });
  } catch (err) {
    logger.error({ err }, "readiness_check_failed");
    return NextResponse.json(
      { success: false, error: { code: "NOT_READY", message: "Database is not reachable." } },
      { status: 503 },
    );
  }
}
