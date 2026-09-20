import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * These tests exercise real database behavior (ownership isolation, credit
 * idempotency) and therefore need a live Postgres instance with a migrated
 * schema and a generated Prisma client - `npm run prisma:migrate` first.
 *
 * They are skipped automatically when DATABASE_URL isn't set (e.g. in this
 * sandbox, which cannot reach binaries.prisma.sh to download the Prisma
 * query engine). Run them for real with:
 *   DATABASE_URL=postgresql://... npm test
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("project ownership isolation", () => {
  let db: typeof import("@/lib/db").db;
  let userA: { id: string };
  let userB: { id: string };
  let projectA: { id: string };

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    userA = await db.user.create({
      data: { name: "A", email: `a-${Date.now()}@test.local`, passwordHash: "x", emailVerifiedAt: new Date() },
    });
    userB = await db.user.create({
      data: { name: "B", email: `b-${Date.now()}@test.local`, passwordHash: "x", emailVerifiedAt: new Date() },
    });
    projectA = await db.project.create({
      data: {
        userId: userA.id,
        title: "A's project",
        story: "a".repeat(30),
        language: "English",
        animeStyle: "Modern Anime",
        duration: "30s",
        aspectRatio: "16:9",
        voiceGender: "female",
        voiceStyle: "narrator",
      },
    });
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { userId: { in: [userA.id, userB.id] } } });
    await db.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
  });

  it("does not let user B load user A's project via getOwnedProject", async () => {
    const { getOwnedProject } = await import("@/lib/domain/projectAccess");
    await expect(getOwnedProject(projectA.id, userB.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lets user A load their own project", async () => {
    const { getOwnedProject } = await import("@/lib/domain/projectAccess");
    const project = await getOwnedProject(projectA.id, userA.id);
    expect(project.id).toBe(projectA.id);
  });
});

describe.skipIf(!hasDb)("credit reservation idempotency", () => {
  let db: typeof import("@/lib/db").db;
  let user: { id: string; credits: number };
  let project: { id: string };

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    user = await db.user.create({
      data: {
        name: "Credit Test",
        email: `credit-${Date.now()}@test.local`,
        passwordHash: "x",
        emailVerifiedAt: new Date(),
        credits: 100,
      },
    });
    project = await db.project.create({
      data: {
        userId: user.id,
        title: "Credit test project",
        story: "a".repeat(30),
        language: "English",
        animeStyle: "Modern Anime",
        duration: "1m", // costs 10 credits
        aspectRatio: "16:9",
        voiceGender: "female",
        voiceStyle: "narrator",
      },
    });
  });

  afterAll(async () => {
    await db.usageRecord.deleteMany({ where: { userId: user.id } });
    await db.project.deleteMany({ where: { userId: user.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });

  it("only charges once even when reserveCredits is called twice with the same reason", async () => {
    const { reserveCredits } = await import("@/lib/usage/creditService");
    const reason = `generate:${project.id}`;

    await reserveCredits({ userId: user.id, projectId: project.id, duration: "1m", idempotencyReason: reason });
    await reserveCredits({ userId: user.id, projectId: project.id, duration: "1m", idempotencyReason: reason });

    const updated = await db.user.findUnique({ where: { id: user.id } });
    expect(updated?.credits).toBe(90); // 100 - 10, not 100 - 20
  });
});
