import "server-only";

import { getServerSession } from "@/lib/auth/server-session";
import { assertNotSystemManagedRepository } from "@/lib/repositories/repository-access-guard";
import {
  canModifyRepository,
  getUserIdFromSession,
} from "@/actions/repositories/repository-permissions";
import { checkUserRole } from "@/lib/db/drizzle";
import { hasCapabilityAccess } from "@/utils/roles";

export interface RepositoryConnectorManager {
  userId: number;
  cognitoSub: string;
}

export async function requireRepositoryConnectorManager(
  repositoryId: number,
): Promise<RepositoryConnectorManager> {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new Error("Repository not found");
  }
  const session = await getServerSession();
  if (!session) throw new Error("Unauthorized");
  if (!(await hasCapabilityAccess("knowledge-repositories"))) {
    throw new Error("Forbidden");
  }
  await assertNotSystemManagedRepository(repositoryId);
  const userId = await getUserIdFromSession(session.sub);
  if (!(await canModifyRepository(repositoryId, userId))) {
    throw new Error("Forbidden");
  }
  return { userId, cognitoSub: session.sub };
}

/**
 * The shared WIF service account can read every Drive explicitly granted to
 * that common identity. Restrict choosing a Shared Drive id to application
 * administrators so repository ownership cannot be used as a confused-deputy
 * bridge into another team's Drive.
 */
export async function requireSharedDriveConnectorAdministrator(
  manager: RepositoryConnectorManager,
): Promise<void> {
  if (!(await checkUserRole(manager.userId, "administrator"))) {
    throw new Error("Forbidden");
  }
}

export function repositoryConnectorErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : "Request failed";
  if (message === "Unauthorized") {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (
    message === "Forbidden" ||
    message === "Repository not found" ||
    message === "Connector not found"
  ) {
    // Preserve the existing repository non-disclosure boundary.
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (message.includes("not enabled") || message.includes("not configured")) {
    return Response.json({ error: message }, { status: 503 });
  }
  return Response.json({ error: message }, { status: 400 });
}
