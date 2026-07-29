"use server";

import { z } from "zod";
import { getServerSession } from "@/lib/auth/server-session";
import { getUserIdByCognitoSubAsNumber } from "@/lib/db/drizzle";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";
import {
  createSuccess,
  ErrorFactories,
  handleError,
} from "@/lib/error-utils";
import type { ActionState } from "@/types";
import {
  addNexusProjectMember,
  connectNexusProjectRepository,
  createNexusProject,
  createNexusProjectConversation,
  disconnectNexusProjectRepository,
  getNexusProject,
  listNexusProjects,
  removeNexusProjectMember,
  updateNexusProject,
} from "@/lib/nexus/projects/project-service";

const projectIdSchema = z.string().uuid();
const projectInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  instructions: z.string().trim().max(20_000).optional(),
});

async function authenticatedUserId() {
  const session = await getServerSession();
  if (!session) throw ErrorFactories.authNoSession();
  const userId = await getUserIdByCognitoSubAsNumber(session.sub);
  if (!userId) throw ErrorFactories.authNoSession();
  return userId;
}

async function runProjectAction<T>(
  operation: string,
  callback: (userId: number) => Promise<T>
): Promise<ActionState<T>> {
  const requestId = generateRequestId();
  const timer = startTimer(operation);
  const log = createLogger({ requestId, action: operation });
  try {
    const userId = await authenticatedUserId();
    const result = await callback(userId);
    timer({ status: "success" });
    log.info("Nexus project action completed", { userId });
    return createSuccess(result, "Success");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Nexus project request failed", {
      context: operation,
      requestId,
      operation,
    });
  }
}

export async function createNexusProjectAction(
  input: z.input<typeof projectInputSchema>
) {
  return runProjectAction("createNexusProjectAction", async (ownerId) => {
    const parsed = projectInputSchema.parse(input);
    return createNexusProject({ ownerId, ...parsed });
  });
}

export async function listNexusProjectsAction() {
  return runProjectAction("listNexusProjectsAction", listNexusProjects);
}

export async function getNexusProjectAction(projectId: string) {
  return runProjectAction("getNexusProjectAction", async (userId) =>
    getNexusProject(projectIdSchema.parse(projectId), userId)
  );
}

export async function updateNexusProjectAction(input: {
  projectId: string;
  name: string;
  instructions: string;
}) {
  return runProjectAction("updateNexusProjectAction", async (userId) => {
    const projectId = projectIdSchema.parse(input.projectId);
    const project = projectInputSchema.parse(input);
    return updateNexusProject({
      projectId,
      userId,
      name: project.name,
      instructions: project.instructions ?? "",
    });
  });
}

export async function addNexusProjectMemberAction(input: {
  projectId: string;
  email: string;
  role: "editor" | "viewer";
}) {
  return runProjectAction("addNexusProjectMemberAction", async (actorUserId) =>
    addNexusProjectMember({
      actorUserId,
      projectId: projectIdSchema.parse(input.projectId),
      email: z.string().email().max(255).parse(input.email),
      role: z.enum(["editor", "viewer"]).parse(input.role),
    })
  );
}

export async function removeNexusProjectMemberAction(input: {
  projectId: string;
  memberUserId: number;
}) {
  return runProjectAction(
    "removeNexusProjectMemberAction",
    async (actorUserId) =>
      removeNexusProjectMember({
        actorUserId,
        projectId: projectIdSchema.parse(input.projectId),
        memberUserId: z.number().int().positive().parse(input.memberUserId),
      })
  );
}

export async function connectNexusProjectRepositoryAction(input: {
  projectId: string;
  repositoryId: number;
}) {
  return runProjectAction(
    "connectNexusProjectRepositoryAction",
    async (userId) =>
      connectNexusProjectRepository({
        userId,
        projectId: projectIdSchema.parse(input.projectId),
        repositoryId: z.number().int().positive().parse(input.repositoryId),
      })
  );
}

export async function disconnectNexusProjectRepositoryAction(input: {
  projectId: string;
  repositoryId: number;
}) {
  return runProjectAction(
    "disconnectNexusProjectRepositoryAction",
    async (userId) =>
      disconnectNexusProjectRepository({
        userId,
        projectId: projectIdSchema.parse(input.projectId),
        repositoryId: z.number().int().positive().parse(input.repositoryId),
      })
  );
}

export async function createNexusProjectConversationAction(input: {
  projectId: string;
  title?: string;
}) {
  return runProjectAction(
    "createNexusProjectConversationAction",
    async (userId) =>
      createNexusProjectConversation({
        userId,
        projectId: projectIdSchema.parse(input.projectId),
        title: z.string().trim().max(500).optional().parse(input.title),
      })
  );
}
