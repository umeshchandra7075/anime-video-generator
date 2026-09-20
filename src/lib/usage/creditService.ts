import { db } from "@/lib/db";
import { Errors } from "@/lib/api/errors";
import type { Prisma } from "@prisma/client";
import { creditCostForDuration } from "@/lib/usage/creditPricing";

export { CREDIT_COSTS, creditCostForDuration } from "@/lib/usage/creditPricing";

/**
 * Atomically checks and deducts credits up front ("reserve"), inside a
 * transaction, so concurrent requests (e.g. a user double-clicking Generate,
 * or a retried request) cannot double-charge or overdraw the balance.
 * Idempotency is enforced by the caller passing a stable usageReason tied to
 * the project - see /api/projects/[id]/generate.
 */
export async function reserveCredits(params: {
  userId: string;
  projectId: string;
  duration: string;
  idempotencyReason: string;
}): Promise<number> {
  const cost = creditCostForDuration(params.duration);

  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    const existingRecord = await tx.usageRecord.findFirst({
      where: { projectId: params.projectId, reason: params.idempotencyReason },
    });
    if (existingRecord) {
      // Already reserved for this project/action - do not charge again.
      return cost;
    }

    const user = await tx.user.findUnique({ where: { id: params.userId } });
    if (!user) throw Errors.notFound("User not found.");
    if (user.credits < cost) throw Errors.insufficientCredits();

    await tx.user.update({ where: { id: user.id }, data: { credits: { decrement: cost } } });
    await tx.usageRecord.create({
      data: {
        userId: params.userId,
        projectId: params.projectId,
        creditsUsed: cost,
        reason: params.idempotencyReason,
      },
    });

    return cost;
  });
}

/** Refunds a reservation, e.g. when generation fails before any real cost was incurred. */
export async function refundCredits(params: { userId: string; amount: number; reason: string }) {
  if (params.amount <= 0) return;
  await db.$transaction([
    db.user.update({ where: { id: params.userId }, data: { credits: { increment: params.amount } } }),
    db.usageRecord.create({
      data: { userId: params.userId, creditsUsed: -params.amount, reason: params.reason },
    }),
  ]);
}
