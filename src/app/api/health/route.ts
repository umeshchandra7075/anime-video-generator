import { NextResponse } from "next/server";

/**
 * Liveness probe: answers "is the process up and able to handle a request
 * at all", deliberately without touching the database or any external
 * dependency. A load balancer/orchestrator uses this to decide whether to
 * restart the container - it should stay fast and dependency-free so a
 * struggling database doesn't get misread as "the process is dead."
 * See /api/ready for the dependency-aware readiness check.
 */
export async function GET() {
  return NextResponse.json({
    success: true,
    data: { status: "ok", uptimeSeconds: Math.round(process.uptime()) },
  });
}
