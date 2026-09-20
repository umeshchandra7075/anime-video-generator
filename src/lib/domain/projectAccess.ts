import { db } from "@/lib/db";
import { Errors } from "@/lib/api/errors";

/**
 * Loads a project and enforces that it belongs to the requesting user.
 * Returns NOT_FOUND (never FORBIDDEN) when the project belongs to someone
 * else, so ownership can't be probed by ID enumeration.
 */
export async function getOwnedProject(projectId: string, userId: string) {
  const project = await db.project.findFirst({
    where: { id: projectId, userId, deletedAt: null },
  });
  if (!project) throw Errors.notFound("Project not found.");
  return project;
}
