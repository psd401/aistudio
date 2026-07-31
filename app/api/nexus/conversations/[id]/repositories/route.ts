import { z } from "zod";
import { getServerSession } from "@/lib/auth/server-session";
import { resolveUserId } from "@/lib/auth/resolve-user";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";
import {
  ConversationRepositoryBindingError,
  getConversationRepositoryBindings,
  replaceConversationRepositoryBindings,
  repositoryBindingErrorResponse,
} from "@/lib/nexus/conversation-repository-service";
import { RepositoryReadinessError } from "@/lib/repositories/readiness-service";

const updateSchema = z.object({
  repositoryIds: z.array(z.number().int().positive()).max(20),
});

async function authenticate(requestId: string): Promise<number | Response> {
  const session = await getServerSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  return resolveUserId(session, requestId);
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer("nexus.conversation.repositories.get");
  const { id: conversationId } = await params;
  const log = createLogger({
    requestId,
    route: "nexus.conversation.repositories.get",
    conversationId,
  });
  try {
    const userId = await authenticate(requestId);
    if (userId instanceof Response) return userId;
    const bindings = await getConversationRepositoryBindings({
      conversationId,
      userId,
    });
    timer({ status: "success", bindingCount: bindings.length });
    return Response.json({
      bindings,
      directRepositoryIds: bindings
        .filter((binding) => binding.source === "direct")
        .map((binding) => binding.repositoryId),
    });
  } catch (error) {
    timer({ status: "error" });
    if (
      error instanceof ConversationRepositoryBindingError ||
      error instanceof RepositoryReadinessError
    ) {
      return repositoryBindingErrorResponse(error, requestId);
    }
    log.error("Failed to load Nexus repository bindings", {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { error: "Failed to load repository bindings", requestId },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer("nexus.conversation.repositories.update");
  const { id: conversationId } = await params;
  const log = createLogger({
    requestId,
    route: "nexus.conversation.repositories.update",
    conversationId,
  });
  try {
    const userId = await authenticate(requestId);
    if (userId instanceof Response) return userId;
    const parsed = updateSchema.safeParse(await request.json());
    if (!parsed.success) {
      timer({ status: "error", reason: "invalid_request" });
      return Response.json(
        {
          error: "repositoryIds must contain at most 20 positive integers",
          code: "INVALID_REPOSITORY_BINDINGS",
          requestId,
        },
        { status: 400 }
      );
    }
    const bindings = await replaceConversationRepositoryBindings({
      conversationId,
      userId,
      repositoryIds: parsed.data.repositoryIds,
      source: "direct",
    });
    timer({ status: "success", bindingCount: bindings.length });
    log.info("Updated direct Nexus repository bindings", {
      userId,
      bindingCount: bindings.length,
    });
    return Response.json({
      bindings,
      directRepositoryIds: bindings.map((binding) => binding.repositoryId),
    });
  } catch (error) {
    timer({ status: "error" });
    if (
      error instanceof ConversationRepositoryBindingError ||
      error instanceof RepositoryReadinessError
    ) {
      return repositoryBindingErrorResponse(error, requestId);
    }
    log.error("Failed to update Nexus repository bindings", {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { error: "Failed to update repository bindings", requestId },
      { status: 500 }
    );
  }
}
