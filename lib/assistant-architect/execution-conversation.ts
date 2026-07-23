import { createConversation } from "@/lib/db/drizzle/nexus-conversations";
import { createMessageWithStats } from "@/lib/db/drizzle/nexus-messages";
import { sanitizeForLogging, type createLogger } from "@/lib/logger";
import {
  bindNexusRequestAttachmentReferences,
  rollbackNewNexusAttachmentConversation,
} from "@/lib/nexus/request-attachment-binding";
import type { TemporaryAttachmentReference } from "@/lib/repositories/temporary-attachment-contract";

type ExecutionConversationLogger = Pick<
  ReturnType<typeof createLogger>,
  "error" | "info"
>;

export interface CreateAssistantExecutionConversationInput {
  assistantId: number;
  assistantName: string;
  executionId: number;
  inputs: Record<string, unknown>;
  log: ExecutionConversationLogger;
  ownerId: number;
  references: TemporaryAttachmentReference[];
  runtimeRepositoryIds: number[];
}

function formatExecutionInputs(inputs: Record<string, unknown>): string {
  if (Object.keys(inputs).length === 0) {
    return "(Assistant executed with default inputs)";
  }

  return Object.entries(inputs)
    .map(([key, value]) => {
      const safeKey = String(key).substring(0, 100);
      const safeValue =
        typeof value === "string"
          ? value.substring(0, 5000)
          : String(sanitizeForLogging(value)).substring(0, 5000);
      return `${safeKey}: ${safeValue}`;
    })
    .join("\n")
    .substring(0, 10000);
}

/**
 * Persist the conversation shell for an interactive Assistant Architect run.
 *
 * Temporary repository references must be bound before the first message is
 * written so a returned conversation can always resolve the same attachment
 * repositories when it is resumed in Nexus. Conversation tracking remains
 * non-fatal for the execution itself; a failed first message after a successful
 * bind is compensated by unbinding and removing the empty conversation.
 */
export async function createAssistantExecutionConversation(
  input: CreateAssistantExecutionConversationInput
): Promise<string | undefined> {
  let conversationId: string | undefined;
  let referencesBound = false;

  try {
    const conversation = await createConversation({
      userId: input.ownerId,
      title: `${input.assistantName} — ${new Date().toLocaleDateString()}`,
      provider: "assistant-architect",
      metadata: {
        source: "app",
        assistantId: input.assistantId,
        assistantName: input.assistantName,
        executionId: input.executionId,
        executionStatus: "running",
        runtimeRepositoryIds: input.runtimeRepositoryIds,
      },
    });
    conversationId = conversation.id;

    await bindNexusRequestAttachmentReferences({
      ownerId: input.ownerId,
      conversationId,
      references: input.references,
      conversationCreated: true,
    });
    referencesBound = input.references.length > 0;

    const userContent = formatExecutionInputs(input.inputs);
    await createMessageWithStats({
      conversationId,
      role: "user",
      content: userContent,
      parts: [{ type: "text", text: userContent }],
      metadata: { inputs: input.inputs, source: "app" },
    });

    input.log.info("Nexus conversation created for execution", {
      conversationId,
      executionId: input.executionId,
      toolId: input.assistantId,
    });
    return conversationId;
  } catch (conversationError) {
    if (conversationId && referencesBound) {
      try {
        await rollbackNewNexusAttachmentConversation({
          ownerId: input.ownerId,
          conversationId,
        });
      } catch (cleanupError) {
        input.log.error(
          "Failed to compensate an empty assistant execution conversation",
          {
            conversationId,
            executionId: input.executionId,
            error:
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError),
          }
        );
      }
    }

    input.log.error("Failed to create nexus conversation for execution", {
      error:
        conversationError instanceof Error
          ? conversationError.message
          : String(conversationError),
      executionId: input.executionId,
      toolId: input.assistantId,
    });
    return undefined;
  }
}
