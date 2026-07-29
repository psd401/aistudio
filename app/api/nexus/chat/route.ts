import { UIMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import { getServerSession } from '@/lib/auth/server-session';
import { getCurrentUserAction } from '@/actions/db/get-current-user-action';
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from '@/lib/logger';
import { hasCapability } from '@/lib/ai/capability-utils';
import { processMessagesWithAttachments } from '@/lib/services/attachment-storage-service';
import { unifiedStreamingService } from '@/lib/streaming/unified-streaming-service';
import type { StreamRequest } from '@/lib/streaming/types';
import { ContentSafetyBlockedError } from '@/lib/streaming/types';
import { getContentSafetyService } from '@/lib/safety';
import type { TokenMapping } from '@/lib/safety/types';
import {
  createTokenMappingSink,
  type TokenMappingSink,
} from '@/lib/safety/token-mapping-sink';
import { getModelConfig } from '@/lib/ai/model-config';
import { modelSupportsFunctionCalling } from '@/lib/ai/model-router/core';
import type {
  ImageGenerationResult,
  ReferenceImage,
} from '@/lib/ai/image-generation-service';
import { userCanAccessResource } from '@/lib/db/drizzle/resource-access';
import { getConnectorTools } from '@/lib/mcp/connector-service';
import type { McpConnectorToolsResult } from '@/lib/mcp/connector-types';
import { createUniversalTools } from '@/lib/tools/provider-native-tools';
import {
  createNexusAttachmentTools,
  createNexusRepositorySearchTools,
} from '@/lib/nexus/attachment-repository-tool';
import { prepareRepositoryAttachmentMessages } from '@/lib/nexus/repository-attachment-messages';
import {
  resolveNexusAttachmentImageSources,
  resolveNexusConversationRepositoryIds,
  type NexusAttachmentReference,
} from '@/lib/nexus/ephemeral-repository-service';
import {
  bindNexusRequestAttachmentReferences,
  NexusAttachmentBindingCleanupError,
  NexusAttachmentBindingRejectedError,
  rollbackNewNexusAttachmentConversation,
} from '@/lib/nexus/request-attachment-binding';
import {
  NexusAttachmentTurnLimitError,
  preflightNexusAttachmentReferences,
  type NexusAttachmentRequestPreflight,
} from '@/lib/nexus/request-attachment-preflight';
import {
  applyProcessedInlineAttachmentValues,
  canonicalizeInlineAttachmentMessages,
  NexusInlineAttachmentValidationError,
  scanCanonicalInlineAttachments,
} from '@/lib/nexus/inline-attachment-security';

import {
  extractImagePrompt,
  validateImagePrompt,
  getOrCreateImageConversation,
  extractReferenceImages,
  extractCanonicalRepositoryImages,
  getPreviousGeneratedImages,
  getImageRoutingContext,
  persistImageExchange,
  deleteUnpersistedGeneratedImage,
  createImageStreamResponse,
  handleImageGenerationError,
} from './image-generation-handler';

import {
  generateConversationTitle,
  createConversation,
  extractUserContent,
  saveUserMessage,
  convertMessagesToPartsFormat,
  saveAssistantMessage,
  saveConversationSteps,
  type StepData,
} from './chat-helpers';

import { eq, and } from 'drizzle-orm';
import { executeQuery } from '@/lib/db/drizzle-client';
import { nexusConversations } from '@/lib/db/schema';
import { getScopesForRoles } from '@/lib/api-keys/scopes';
import { toolCatalogInstance } from '@/lib/tools/catalog/catalog';
import {
  intersectSkillAllowedTools,
  getApprovedSkillSession,
  filterConnectorToolsByPin,
  type ApprovedSkillSession,
} from '@/lib/skills/skill-tool-enforcement';
import { readSkillMarkdown } from '@/lib/skills/skill-publish-pipeline';
import { buildWorkspaceChatTools } from '@/lib/nexus/workspace-chat-tools';
import { resolveNexusMemoryContext } from '@/lib/nexus/memory/memory-context';
import { scheduleNexusMemoryAutoExtraction } from '@/lib/nexus/memory/auto-extraction';
import { buildNexusSystemPrompt } from '@/lib/nexus/system-prompt';
import { mergeRoutedToolNames, routeNexusRequest } from '@/lib/nexus/model-router/router';
import { NexusSpecialistUnavailableError } from '@/lib/nexus/model-router/errors';
import {
  nexusExperienceModeSchema,
  nexusModelFamilySchema,
  type NexusRoutingMetadata,
} from '@/lib/nexus/model-router/types';
import {
  NexusProjectAccessError,
  resolveNexusProjectChatContext,
} from '@/lib/nexus/projects/project-service';

// Allow streaming responses up to 30 minutes. Deep Research runs take 5–25
// minutes; standard chat and image-gen finish well within this window.
// Platforms that enforce maxDuration (e.g. Vercel) will terminate the request
// if it exceeds this value, so it must cover the worst-case Deep Research run.
export const maxDuration = 1800;

/**
 * Build the onFinish callback for streaming
 */
/**
 * Close all MCP connector clients, ignoring errors.
 * Called after streaming completes (onFinish) or on error to release connections.
 */
async function closeMcpClients(
  connectorToolResults: McpConnectorToolsResult[],
  log: ReturnType<typeof createLogger>,
  context: string
) {
  if (connectorToolResults.length === 0) return;
  log.debug('Closing MCP clients', { context, clientCount: connectorToolResults.length });
  await Promise.allSettled(connectorToolResults.map(r => r.close()));
}

function createOnFinishCallback(params: {
  conversationId: string;
  userId: number;
  cognitoSub: string;
  requestId: string;
  latestUserText: string;
  dbModelId: number;
  connectorToolResults: McpConnectorToolsResult[];
  log: ReturnType<typeof createLogger>;
  timer: (data: Record<string, unknown>) => void;
  routingMetadata: NexusRoutingMetadata;
}) {
  const {
    conversationId,
    userId,
    cognitoSub,
    requestId,
    latestUserText,
    dbModelId,
    connectorToolResults,
    log,
    timer,
    routingMetadata,
  } = params;

  return async ({
    text,
    usage,
    finishReason,
    toolCalls,
    steps,
  }: {
    text: string;
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
    finishReason?: string;
    toolCalls?: Array<{
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      result?: unknown;
    }>;
    steps?: StepData[];
  }) => {
    log.info('Stream finished, saving assistant message', {
      conversationId,
      hasText: !!text,
      textLength: text?.length || 0,
      toolCallCount: toolCalls?.length || 0,
      stepCount: steps?.length ?? 0,
    });

    let assistantMessagePersisted = false;
    try {
      if (steps && steps.length > 1) {
        // Multi-step agentic loop (MCP connectors): save each step as a separate
        // assistant message to preserve the correct turn structure for replay.
        // Consolidating into one message breaks convertToModelMessages — it cannot
        // reconstruct multi-turn tool_use/tool_result pairs. (Issue #977)
        await saveConversationSteps({
          conversationId, steps, dbModelId, usage, finishReason,
          metadata: { routing: routingMetadata },
        });
      } else {
        await saveAssistantMessage({
          conversationId, text, usage, finishReason, toolCalls, dbModelId,
          metadata: { routing: routingMetadata },
        });
      }
      assistantMessagePersisted = true;
    } catch (saveError) {
      log.error('Failed to save assistant message', { error: saveError, conversationId });
    }

    if (assistantMessagePersisted) {
      // Deliberately fire-and-forget after persistence. Automatic memory must
      // never delay MCP cleanup, request timing, or the completed chat turn.
      scheduleNexusMemoryAutoExtraction({
        userId,
        cognitoSub,
        conversationId,
        requestId,
        userMessage: latestUserText,
        assistantMessage: text,
      });
    }

    // Close MCP clients AFTER all tool executions and message saving complete.
    // Previously in a try/finally that ran immediately after Response creation,
    // which closed clients before the stream's multi-step tool calls could execute.
    await closeMcpClients(connectorToolResults, log, 'onFinish');

    timer({ status: 'success', conversationId, tokensUsed: usage?.totalTokens });
  };
}

/**
 * Pre-merge the adapter (universal) tools with per-user MCP connector tools and
 * the server-built workspace, attachment, and memory tools. Returns undefined
 * when no pre-merged tool source is active (the streaming service then builds
 * adapter tools itself from `enabledTools`). Server-built tools take precedence
 * over adapter tools on a name collision.
 */
async function buildMergedChatTools(params: {
  enabledTools: string[];
  connectorToolResults: McpConnectorToolsResult[];
  workspaceTools?: ToolSet;
  attachmentTools?: ToolSet;
  memoryTools?: ToolSet;
}): Promise<ToolSet | undefined> {
  const {
    enabledTools,
    connectorToolResults,
    workspaceTools,
    attachmentTools,
    memoryTools,
  } = params;
  const hasWorkspaceTools = !!workspaceTools && Object.keys(workspaceTools).length > 0;
  const hasAttachmentTools =
    !!attachmentTools && Object.keys(attachmentTools).length > 0;
  const hasMemoryTools = !!memoryTools && Object.keys(memoryTools).length > 0;
  if (
    connectorToolResults.length === 0 &&
    !hasWorkspaceTools &&
    !hasAttachmentTools &&
    !hasMemoryTools
  ) {
    return undefined;
  }
  const merged: ToolSet = { ...(await createUniversalTools(enabledTools)) };
  for (const result of connectorToolResults) {
    Object.assign(merged, result.tools);
  }
  if (hasWorkspaceTools) {
    Object.assign(merged, workspaceTools);
  }
  if (hasAttachmentTools) {
    // This server-built tool is scoped to owner-validated conversation
    // bindings. It is core input handling (like image input), not a client
    // selectable capability, so a skill pin cannot remove or widen it.
    Object.assign(merged, attachmentTools);
  }
  if (hasMemoryTools) {
    // Memory tools are server-built from the authenticated owner and current
    // conversation. Like attachment tools, they are core chat behavior rather
    // than client-selected skill tools, so a skill allowed-tools pin cannot
    // silently disable or widen them.
    Object.assign(merged, memoryTools);
  }
  return merged;
}

function addConnectorToolHeader(
  headers: Record<string, string>,
  connectorToolResults: McpConnectorToolsResult[],
  log: ReturnType<typeof createLogger>,
): void {
  if (connectorToolResults.length === 0) return;
  const toolMapping: Record<string, { serverId: string; serverName: string }> =
    {};
  for (const result of connectorToolResults) {
    for (const toolName of Object.keys(result.tools)) {
      toolMapping[toolName] = {
        serverId: result.serverId,
        serverName: result.serverName,
      };
    }
  }
  const encoded = encodeURIComponent(JSON.stringify(toolMapping));
  if (encoded.length <= 8192) {
    headers["X-Connector-Tools"] = encoded;
    return;
  }
  log.warn(
    "X-Connector-Tools header too large, omitting — branded tool UI will use generic fallback",
    {
      sizeBytes: encoded.length,
      toolCount: Object.keys(toolMapping).length,
    },
  );
}

function buildStreamingResponseHeaders(params: {
  requestId: string;
  supportsReasoning: boolean;
  routingMetadata: NexusRoutingMetadata;
  conversationId?: string;
  conversationIdValue?: string;
  conversationTitle: string;
  failedConnectorIds: string[];
  connectorToolResults: McpConnectorToolsResult[];
  log: ReturnType<typeof createLogger>;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Request-Id": params.requestId,
    "X-Unified-Streaming": "true",
    "X-Supports-Reasoning": params.supportsReasoning.toString(),
  };
  const encodedRouting = encodeURIComponent(
    JSON.stringify(params.routingMetadata),
  );
  if (encodedRouting.length <= 4096) {
    headers["X-Nexus-Routing"] = encodedRouting;
  }
  if (!params.conversationIdValue && params.conversationId) {
    headers["X-Conversation-Id"] = params.conversationId;
    headers["X-Conversation-Title"] = encodeURIComponent(
      params.conversationTitle || "New Conversation",
    );
  }
  const safeIds = params.failedConnectorIds.filter((id) =>
    /^[\da-f-]{36}$/i.test(id),
  );
  if (safeIds.length > 0) {
    headers["X-Connector-Reconnect"] = safeIds.join(",");
  }
  addConnectorToolHeader(headers, params.connectorToolResults, params.log);
  return headers;
}

/**
 * Execute streaming and return response
 */

async function executeStreaming(params: {
  messages: UIMessage[];
  modelConfig: { provider: string; model_id: string };
  userId: number;
  sessionId: string;
  conversationId: string;
  conversationIdValue?: string;
  conversationTitle: string;
  enabledTools: string[];
  enabledConnectors: string[];
  connectorToolResults: McpConnectorToolsResult[];
  failedConnectorIds: string[];
  /** Bound skill's SKILL.md content, injected into the system prompt (#925). */
  skillInstructions?: string;
  /** Bound skill's name (labels the injected instruction block). */
  skillName?: string;
  /** Server-built AI SDK tools for the open workspace object (Atrium §1087). */
  workspaceTools?: ToolSet;
  /** System-prompt line describing the open workspace object + how to edit it. */
  workspacePromptFragment?: string;
  /** Owner-validated search over repositories attached to this conversation. */
  attachmentTools?: ToolSet;
  /** Server-derived project and skill repository instructions. */
  repositoryPromptFragment?: string;
  /** Owner-scoped save/forget tools, present only when all memory gates pass. */
  memoryTools?: ToolSet;
  /** Sanitized, owner-scoped memory context for this turn. */
  userMemoryFragment?: string;
  /** Guardrail-processed latest user text used for post-turn extraction. */
  latestUserText: string;
  reasoningEffort: "minimal" | "low" | "medium" | "high";
  responseMode: "standard" | "flex" | "priority";
  requestId: string;
  dbModelId: number;
  log: ReturnType<typeof createLogger>;
  timer: (data: Record<string, unknown>) => void;
  precomputedInputTokenMappings?: TokenMapping[];
  inputTokenMappingSink?: TokenMappingSink;
  routingMetadata: NexusRoutingMetadata;
}): Promise<Response> {
  const {
    messages,
    modelConfig,
    userId,
    sessionId,
    conversationId,
    conversationIdValue,
    conversationTitle,
    enabledTools,
    enabledConnectors,
    connectorToolResults,
    failedConnectorIds,
    skillInstructions,
    skillName,
    workspaceTools,
    workspacePromptFragment,
    attachmentTools,
    repositoryPromptFragment,
    memoryTools,
    userMemoryFragment,
    latestUserText,
    reasoningEffort,
    responseMode,
    requestId,
    dbModelId,
    log,
    timer,
    precomputedInputTokenMappings,
    inputTokenMappingSink,
    routingMetadata,
  } = params;

  const hasRepositoryTools =
    !!attachmentTools && Object.keys(attachmentTools).length > 0;
  const hasAttachmentTools =
    !!attachmentTools &&
    Object.hasOwn(attachmentTools, "searchNexusAttachments");
  const systemPrompt = buildNexusSystemPrompt({
    skillInstructions,
    skillName,
    workspacePromptFragment,
    hasAttachmentTools,
    repositoryPromptFragment,
    userMemoryFragment,
  });

  const hasWorkspaceTools =
    !!workspaceTools && Object.keys(workspaceTools).length > 0;
  const multiStepToolsActive =
    connectorToolResults.length > 0 ||
    hasWorkspaceTools ||
    hasRepositoryTools ||
    (!!memoryTools && Object.keys(memoryTools).length > 0);

  // Pre-merge adapter + connector + workspace tools (undefined when none active).
  const mergedTools = await buildMergedChatTools({
    enabledTools,
    connectorToolResults,
    workspaceTools: hasWorkspaceTools ? workspaceTools : undefined,
    attachmentTools: hasRepositoryTools ? attachmentTools : undefined,
    memoryTools,
  });

  const streamRequest: StreamRequest = {
    messages,
    modelId: modelConfig.model_id,
    provider: modelConfig.provider,
    userId: userId.toString(),
    sessionId,
    conversationId,
    source: "nexus",
    systemPrompt,
    // Always pass the scoped enabledTools: when `tools` is also set (connector /
    // workspace merge), the streaming service now merges the model's
    // provider-native tools UNDER the pre-merged set so web search / code
    // interpreter aren't dropped just because a connector or workspace is active
    // (PR #1136 review). Without `tools`, this is the sole tool source as before.
    enabledTools,
    enabledConnectors,
    tools: mergedTools,
    // maxSteps enables multi-step tool use (agent loop). Needed when MCP,
    // workspace, repository, or memory tools are active. Ten is the hard bound
    // for a save/forget/read→edit→confirm chain.
    maxSteps: multiStepToolsActive ? 10 : undefined,
    options: { reasoningEffort, responseMode },
    precomputedInputTokenMappings,
    inputTokenMappingSink,
    callbacks: {
      onFinish: createOnFinishCallback({
        conversationId,
        userId,
        cognitoSub: sessionId,
        requestId,
        latestUserText,
        dbModelId,
        connectorToolResults,
        log,
        timer,
        routingMetadata,
      }),
      onError: async (error: Error) => {
        log.warn("Stream error — closing MCP clients", {
          conversationId,
          error: error.message,
        });
        await closeMcpClients(connectorToolResults, log, "onError");
      },
    },
  };

  log.info("Starting unified streaming service", {
    provider: modelConfig.provider,
    model: modelConfig.model_id,
    conversationId,
  });

  // MCP client cleanup is handled in onFinish (after all tool executions complete)
  // and in the catch block below (for pre-stream errors).
  // Do NOT use try/finally here — the finally block runs immediately after the
  // Response is created, before the streaming body is consumed, which closes
  // MCP clients while tool calls are still in-flight.
  const streamResponse = await unifiedStreamingService.stream(streamRequest);

  const responseHeaders = buildStreamingResponseHeaders({
    requestId,
    supportsReasoning: streamResponse.capabilities.supportsReasoning,
    routingMetadata,
    conversationId,
    conversationIdValue,
    conversationTitle,
    failedConnectorIds,
    connectorToolResults,
    log,
  });

  return streamResponse.result.toUIMessageStreamResponse({
    headers: responseHeaders,
  });
}

// Flexible message validation that accepts various formats from the UI
const ChatRequestSchema = z.object({
  messages: z.array(z.object({
    id: z.string(),
    role: z.enum(['system', 'user', 'assistant']),
    parts: z.array(z.any()).optional(),
    content: z.any().optional(),
    metadata: z.any().optional(),
  })),
  modelId: z.string(),
  provider: z.string().optional(),
  conversationId: z.string().nullable().optional(),
  enabledTools: z.array(z.string()).optional(),
  enabledConnectors: z.array(z.string().uuid()).max(10).optional(),
  // When the session is bound to a published skill ("use in chat"), the skill's
  // `allowed-tools` pin is enforced server-side over the client tool list (#925 AC#6).
  skillId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  // When a workspace document/artifact is open beside the chat (`?workspace=<id|slug>`),
  // the server binds read/edit tools for THAT object (Atrium §1087). Loose validation
  // only — the tool builder canView/canEdit-gates server-side; cap length like other params.
  workspaceId: z.string().min(1).max(200).optional(),
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
  responseMode: z.enum(['standard', 'priority', 'flex']).optional(),
  nexusMode: nexusExperienceModeSchema.default('standard'),
  modelFamily: nexusModelFamilySchema.default('auto'),
}).refine(
  value => value.nexusMode === 'standard' || value.modelFamily !== 'auto',
  { path: ['modelFamily'], message: 'Advanced mode requires ChatGPT, Claude, or Gemini' }
);

async function resolveImageReferences(params: {
  messages: z.infer<typeof ChatRequestSchema>["messages"];
  attachmentReferences: NexusAttachmentReference[];
  conversationId: string;
  existingConversationId?: string;
  userId: number;
}): Promise<ReferenceImage[]> {
  let referenceImages: ReferenceImage[];
  if (params.attachmentReferences.length > 0) {
    const sources = await resolveNexusAttachmentImageSources({
      ownerId: params.userId,
      conversationId: params.conversationId,
      references: params.attachmentReferences,
    });
    if (!sources) {
      throw Object.assign(
        new Error("Canonical image attachment is unavailable"),
        { type: "INVALID_ATTACHMENT" },
      );
    }
    referenceImages = await extractCanonicalRepositoryImages(sources);
  } else {
    referenceImages = await extractReferenceImages(
      params.messages[params.messages.length - 1],
      params.conversationId,
    );
  }
  if (
    params.attachmentReferences.length === 0 &&
    params.existingConversationId &&
    referenceImages.length === 0
  ) {
    return getPreviousGeneratedImages(
      params.existingConversationId,
      params.userId,
    );
  }
  return referenceImages;
}

async function persistGeneratedImage(params: {
  conversationId: string;
  imagePrompt: string;
  persistenceMessages: z.infer<typeof ChatRequestSchema>["messages"];
  imageResult: ImageGenerationResult;
  dbModelId: number;
  routingMetadata: NexusRoutingMetadata;
  log: ReturnType<typeof createLogger>;
}): Promise<void> {
  const lastMessage =
    params.persistenceMessages[params.persistenceMessages.length - 1];
  const persistedUser =
    lastMessage?.role === "user"
      ? extractUserContent(lastMessage as UIMessage)
      : {
          content: params.imagePrompt,
          parts: [{ type: "text", text: params.imagePrompt }],
        };
  try {
    await persistImageExchange({
      conversationId: params.conversationId,
      imagePrompt: params.imagePrompt,
      userContent: persistedUser.content,
      userParts: persistedUser.parts,
      imageResult: params.imageResult,
      dbModelId: params.dbModelId,
      routingMetadata: { ...params.routingMetadata },
    });
  } catch (error) {
    try {
      await deleteUnpersistedGeneratedImage({
        conversationId: params.conversationId,
        s3Key: params.imageResult.s3Key,
      });
    } catch (cleanupError) {
      params.log.error("Failed to remove an unpersisted generated image", {
        conversationId: params.conversationId,
        error:
          cleanupError instanceof Error
            ? cleanupError.message
            : "Unknown cleanup error",
      });
    }
    throw error;
  }
}

async function rollbackFailedImageConversation(params: {
  attachmentReferences: NexusAttachmentReference[];
  conversationId: string;
  existingConversationId?: string;
  userId: number;
  requestId: string;
  log: ReturnType<typeof createLogger>;
  timer: (data: Record<string, unknown>) => void;
}): Promise<Response | null> {
  if (
    params.existingConversationId ||
    params.attachmentReferences.length === 0
  ) {
    return null;
  }
  try {
    await rollbackNewNexusAttachmentConversation({
      ownerId: params.userId,
      conversationId: params.conversationId,
    });
    return null;
  } catch (error) {
    params.log.error("Failed to compensate a failed image attachment turn", {
      conversationId: params.conversationId,
      error: error instanceof Error ? error.message : "Unknown cleanup error",
    });
    params.timer({
      status: "error",
      reason: "attachment_binding_cleanup_failed",
    });
    return new Response(
      JSON.stringify({
        error: "Unable to attach repository content",
        requestId: params.requestId,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}

/**
 * Handle image generation models
 */

async function handleImageGeneration(params: {
  messages: z.infer<typeof ChatRequestSchema>["messages"];
  persistenceMessages: z.infer<typeof ChatRequestSchema>["messages"];
  attachmentReferences: NexusAttachmentReference[];
  modelConfig: { provider: string; model_id: string };
  modelId: string;
  dbModelId: number;
  userId: number;
  existingConversationId?: string;
  requestId: string;
  timer: (data: Record<string, unknown>) => void;
  log: ReturnType<typeof createLogger>;
  routingMetadata: NexusRoutingMetadata;
}): Promise<Response> {
  const {
    messages,
    persistenceMessages,
    attachmentReferences,
    modelConfig,
    modelId,
    dbModelId,
    userId,
    existingConversationId,
    requestId,
    timer,
    log,
    routingMetadata,
  } = params;

  log.info("Image generation model detected - using direct API call");

  // Extract and validate prompt
  const imagePrompt = extractImagePrompt(messages);
  const validation = validateImagePrompt(imagePrompt);
  if (!validation.valid && validation.error) {
    return validation.error;
  }

  // Determine provider and create/get conversation
  const imageProvider = modelConfig.provider === "google" ? "google" : "openai";
  const convResult = await getOrCreateImageConversation({
    existingConversationId,
    imagePrompt,
    imageProvider,
    modelId,
    userId,
    requestId,
  });

  if ("error" in convResult) {
    return convResult.error;
  }

  const { conversationId, title: conversationTitle } = convResult;

  try {
    const bindingError = await bindAttachmentReferencesOrError({
      ownerId: userId,
      conversationId,
      references: attachmentReferences,
      conversationCreated: !existingConversationId,
      requestId,
      timer,
      log,
    });
    if (bindingError) return bindingError;

    const referenceImages = await resolveImageReferences({
      messages,
      attachmentReferences,
      conversationId,
      existingConversationId,
      userId,
    });

    log.info("Image generation - extracted reference images", {
      referenceImageCount: referenceImages.length,
    });

    // Generate the image
    const { generateImageForNexus } =
      await import("@/lib/ai/image-generation-service");

    log.info("Starting image generation", {
      provider: imageProvider,
      modelId: modelConfig.model_id,
      promptLength: imagePrompt.length,
      referenceImageCount: referenceImages.length,
    });

    const imageResult = await generateImageForNexus({
      prompt: imagePrompt,
      modelId: modelConfig.model_id,
      provider: imageProvider as "openai" | "google",
      conversationId,
      userId: userId.toString(),
      size: "1024x1024",
      quality: "standard",
      referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
    });

    await persistGeneratedImage({
      conversationId,
      imagePrompt,
      persistenceMessages,
      imageResult,
      dbModelId,
      routingMetadata,
      log,
    });

    timer({ status: "success", conversationId });

    return createImageStreamResponse({
      imageResult,
      conversationId,
      conversationTitle,
      isNewConversation: !existingConversationId,
      requestId,
      routingMetadata: { ...routingMetadata },
    });
  } catch (imageError) {
    const rollbackError = await rollbackFailedImageConversation({
      attachmentReferences,
      conversationId,
      existingConversationId,
      userId,
      requestId,
      log,
      timer,
    });
    if (rollbackError) return rollbackError;
    return handleImageGenerationError(imageError, conversationId, requestId);
  }
}

/**
 * Format the Deep Research report body with optional citations.
 * Used for both the streamed message and the persisted DB content, keeping
 * the two representations in sync from a single source of truth.
 */
function formatDeepResearchReport(
  report: string,
  citations: Array<{ url: string; title?: string }>
): string {
  let body = report.trim();
  if (citations.length > 0) {
    body += '\n\n**Sources:**\n';
    body += citations
      .map((c, i) => `${i + 1}. [${c.title?.trim() || c.url}](${c.url})`)
      .join('\n');
  }
  return body;
}

function createDeepResearchResponse(params: {
  prompt: string;
  modelId: string;
  dbModelId: number;
  conversationId: string;
  conversationTitle: string;
  isNewConversation: boolean;
  requestId: string;
  abortSignal: AbortSignal;
  routingMetadata: NexusRoutingMetadata;
  deepResearchLeaseId: string | null;
  timer: (data: Record<string, unknown>) => void;
  log: ReturnType<typeof createLogger>;
  runDeepResearch: (typeof import("@/lib/ai/gemini-deep-research-service"))["runDeepResearch"];
  persistAssistantMessage: typeof saveAssistantMessage;
  createUIMessageStream: (typeof import("ai"))["createUIMessageStream"];
  createUIMessageStreamResponse: (typeof import("ai"))["createUIMessageStreamResponse"];
  releaseDeepResearch: (typeof import("@/lib/ai/deep-research-budget"))["releaseDeepResearch"];
}): Response {
  const messageId = `dr-${Date.now()}`;
  const headers: Record<string, string> = {
    "X-Request-Id": params.requestId,
    "X-Conversation-Id": params.conversationId,
    "X-Deep-Research": "true",
    "X-Nexus-Routing": encodeURIComponent(
      JSON.stringify(params.routingMetadata),
    ),
  };
  if (params.isNewConversation) {
    headers["X-Conversation-Title"] = encodeURIComponent(
      params.conversationTitle,
    );
  }
  return params.createUIMessageStreamResponse({
    status: 200,
    headers,
    stream: params.createUIMessageStream({
      async execute({ writer }) {
        writer.write({ type: "text-start", id: messageId });
        writer.write({
          type: "text-delta",
          id: messageId,
          delta:
            "🔍 **Deep Research in progress** — this typically takes 5–15 minutes. " +
            "The full report will appear below when ready.\n\n",
        });
        let lastStatusEmitted = "";
        let streamEnded = false;
        try {
          const result = await params.runDeepResearch({
            prompt: params.prompt,
            modelId: params.modelId,
            abortSignal: params.abortSignal,
            onStatus: ({ message }) => {
              if (message === lastStatusEmitted) return;
              lastStatusEmitted = message;
              writer.write({
                type: "text-delta",
                id: messageId,
                delta: `_${message}_\n\n`,
              });
            },
          });
          const reportBody = formatDeepResearchReport(
            result.report,
            result.citations,
          );
          writer.write({
            type: "text-delta",
            id: messageId,
            delta: `\n---\n\n${reportBody}\n`,
          });
          try {
            await params.persistAssistantMessage({
              conversationId: params.conversationId,
              text: `🔍 **Deep Research Report**\n\n${reportBody}`,
              finishReason: "stop",
              dbModelId: params.dbModelId,
              metadata: { routing: params.routingMetadata },
            });
          } catch (error) {
            params.log.error("Failed to persist Deep Research message", {
              conversationId: params.conversationId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          writer.write({ type: "text-end", id: messageId });
          streamEnded = true;
          params.timer({
            status: "success",
            conversationId: params.conversationId,
            durationMs: result.durationMs,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          const errorType =
            error && typeof error === "object" && "type" in error
              ? (error as { type: string }).type
              : "UNKNOWN";
          params.log.error("Deep Research failed", {
            conversationId: params.conversationId,
            errType: errorType,
            message,
          });
          if (!streamEnded) {
            writer.write({
              type: "text-delta",
              id: messageId,
              delta: `\n\n**Research failed:** ${message}`,
            });
            writer.write({ type: "text-end", id: messageId });
          }
          params.timer({
            status: "error",
            conversationId: params.conversationId,
            errType: errorType,
          });
        } finally {
          if (params.deepResearchLeaseId) {
            await params
              .releaseDeepResearch(params.deepResearchLeaseId)
              .catch((error: unknown) => {
                params.log.error(
                  "Failed to release Deep Research concurrency lease",
                  {
                    leaseId: params.deepResearchLeaseId,
                    error:
                      error instanceof Error ? error.message : String(error),
                  },
                );
              });
          }
        }
      },
    }),
  });
}

/**
 * Handle Gemini Deep Research models (e.g. deep-research-preview-04-2026).
 *
 * These run via Google's Interactions API, not generateContent. Lifecycle is
 * minutes-long polling, so the response shape is:
 *   1. Immediately stream a heads-up message so the user knows we're working.
 *   2. Internally poll Google every 10 s; surface periodic progress as
 *      additional streamed lines (one per minute, kept terse to avoid noise).
 *   3. When the agent completes, stream the full markdown report + cited
 *      sources, then close.
 *   4. On failure, stream a user-readable error and close cleanly.
 *
 * The heavy lifting lives in lib/ai/gemini-deep-research-service.ts; this
 * function is just the SSE writer + DB persistence shim.
 */

async function handleDeepResearch(params: {
  messages: z.infer<typeof ChatRequestSchema>["messages"];
  modelConfig: { provider: string; model_id: string };
  modelId: string;
  dbModelId: number;
  userId: number;
  existingConversationId?: string;
  requestId: string;
  timer: (data: Record<string, unknown>) => void;
  log: ReturnType<typeof createLogger>;
  abortSignal: AbortSignal;
  routingMetadata: NexusRoutingMetadata;
}): Promise<Response> {
  const {
    messages,
    modelConfig,
    modelId,
    dbModelId,
    userId,
    existingConversationId,
    requestId,
    timer,
    log,
    abortSignal,
    routingMetadata,
  } = params;

  log.info("Deep Research model detected — using Interactions API", {
    modelId: modelConfig.model_id,
  });

  // Validate prompt BEFORE creating a conversation to avoid orphaned DB state.
  // extractImagePrompt extracts the last user message text — the name is
  // image-specific but the logic is generic ("get the last user message text").
  const prompt = extractImagePrompt(messages);
  if (!prompt) {
    return new Response(
      JSON.stringify({
        error: "Deep Research requires a text prompt",
        requestId,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Lazy imports keep the cold start of the standard chat path unchanged.
  const [
    { runDeepResearch },
    { saveAssistantMessage: persistAssistantMessage },
    { createUIMessageStream, createUIMessageStreamResponse },
    { reserveDeepResearch, releaseDeepResearch },
  ] = await Promise.all([
    import("@/lib/ai/gemini-deep-research-service"),
    import("./chat-helpers"),
    import("ai"),
    import("@/lib/ai/deep-research-budget"),
  ]);

  // Admission is deliberately before conversation creation and user-message
  // persistence. A denied request must not leave durable chat state, and every
  // failure before the stream takes ownership must release the active lease.
  const reservation = await reserveDeepResearch(userId);
  // OBSERVE-ONLY (2026-07-27, Hagel): the #1353 thresholds were set without
  // data on real consumption, so crossing one is telemetry, not a refusal.
  // A denial carries no leaseId, hence the nullable lease below.
  if (!reservation.allowed) {
    log.warn("Deep Research over threshold (observe-only — request allowed)", {
      requestId,
      reason: reservation.reason,
    });
  }
  const deepResearchLeaseId = reservation.allowed ? reservation.leaseId : null;

  // Conversation setup — same shape the standard flow uses, so the
  // conversation list, history, and resume work without special-casing.
  let convSetup: Awaited<ReturnType<typeof setupConversation>>;
  try {
    convSetup = await setupConversation({
      conversationIdValue: existingConversationId,
      messages,
      userId,
      provider: modelConfig.provider,
      modelId,
      requestId,
      log,
    });
    if ("error" in convSetup) {
      if (deepResearchLeaseId) await releaseDeepResearch(deepResearchLeaseId);
      return convSetup.error;
    }
    await persistLastUserMessage({
      conversationId: convSetup.conversationId,
      messages,
      dbModelId,
    });
  } catch (error) {
    if (deepResearchLeaseId)
      await releaseDeepResearch(deepResearchLeaseId).catch(
        (releaseError: unknown) => {
          log.error("Failed to release Deep Research pre-stream lease", {
            leaseId: deepResearchLeaseId,
            error:
              releaseError instanceof Error
                ? releaseError.message
                : String(releaseError),
          });
        },
      );
    throw error;
  }
  const { conversationId, conversationTitle } = convSetup;

  return createDeepResearchResponse({
    prompt,
    modelId: modelConfig.model_id,
    dbModelId,
    conversationId,
    conversationTitle,
    isNewConversation: !existingConversationId,
    requestId,
    abortSignal,
    routingMetadata,
    deepResearchLeaseId,
    timer,
    log,
    runDeepResearch,
    persistAssistantMessage,
    createUIMessageStream,
    createUIMessageStreamResponse,
    releaseDeepResearch,
  });
}

/**
 * Capability-based dispatch for non-streaming model paths. Returns the
 * Response when one of these handlers owns the request, or null when the
 * caller should continue down the standard streaming path.
 *
 * Extracted to keep POST() under the cyclomatic-complexity threshold and
 * to centralize the place where new "special" model classes get added.
 */
async function routeSpecialModel(params: {
  isImageGenerationModel: boolean;
  isDeepResearchModel: boolean;
  messages: z.infer<typeof ChatRequestSchema>['messages'];
  persistenceMessages: z.infer<typeof ChatRequestSchema>['messages'];
  attachmentReferences: NexusAttachmentReference[];
  modelConfig: { provider: string; model_id: string };
  modelId: string;
  dbModelId: number;
  userId: number;
  existingConversationId?: string;
  requestId: string;
  timer: (data: Record<string, unknown>) => void;
  log: ReturnType<typeof createLogger>;
  abortSignal: AbortSignal;
  routingMetadata: NexusRoutingMetadata;
}): Promise<Response | null> {
  if (params.isImageGenerationModel) {
    // Note: abortSignal is intentionally not forwarded to handleImageGeneration.
    // Image generation is a fast single-shot API call (seconds, not minutes),
    // so cancellation support is not needed. Deep Research is the only path
    // that requires abort propagation due to its 5–25 minute polling lifecycle.
    return handleImageGeneration({
      messages: params.messages,
      persistenceMessages: params.persistenceMessages,
      attachmentReferences: params.attachmentReferences,
      modelConfig: params.modelConfig,
      modelId: params.modelId,
      dbModelId: params.dbModelId,
      userId: params.userId,
      existingConversationId: params.existingConversationId,
      requestId: params.requestId,
      timer: params.timer,
      log: params.log,
      routingMetadata: params.routingMetadata,
    });
  }
  if (params.isDeepResearchModel) {
    return handleDeepResearch({
      messages: params.messages,
      modelConfig: params.modelConfig,
      modelId: params.modelId,
      dbModelId: params.dbModelId,
      userId: params.userId,
      existingConversationId: params.existingConversationId,
      requestId: params.requestId,
      timer: params.timer,
      log: params.log,
      abortSignal: params.abortSignal,
      routingMetadata: params.routingMetadata,
    });
  }
  return null;
}

type ValidationResult = {
  valid: true;
  data: z.infer<typeof ChatRequestSchema>;
} | {
  valid: false;
  error: Response;
};

/**
 * Validate request and return parsed data or error response
 */
function validateRequest(body: unknown, requestId: string, log: ReturnType<typeof createLogger>): ValidationResult {
  const result = ChatRequestSchema.safeParse(body);
  if (!result.success) {
    log.warn('Invalid request format', {
      errors: result.error.issues.map(issue => ({
        path: issue.path.join('.'),
        message: issue.message
      }))
    });
    return {
      valid: false,
      error: new Response(
        JSON.stringify({ error: 'Invalid request format', details: result.error.issues, requestId }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    };
  }
  return { valid: true, data: result.data };
}

/**
 * Validate conversation ID format
 */
function validateConversationId(id: string | undefined, requestId: string, log: ReturnType<typeof createLogger>): Response | null {
  if (!id) return null;

  const uuidValidation = z.string().uuid().safeParse(id);
  if (!uuidValidation.success) {
    log.warn('Invalid conversation ID format', { conversationId: id });
    return new Response(
      JSON.stringify({ error: 'Invalid conversation ID format', details: 'Conversation ID must be a valid UUID', requestId }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }
  return null;
}

function withProtectedLastUserText(
  messages: z.infer<typeof ChatRequestSchema>['messages'],
  protectedText: string
): z.infer<typeof ChatRequestSchema>['messages'] {
  const lastUserIndex = messages.findLastIndex(message => message.role === 'user');
  if (lastUserIndex < 0) return messages;
  return messages.map((message, index) => {
    if (index !== lastUserIndex) return message;
    const nonTextParts = (message.parts ?? []).filter(part => {
      if (!part || typeof part !== 'object') return true;
      return (part as Record<string, unknown>).type !== 'text';
    });
    const updated = {
      ...message,
      parts: [{ type: 'text', text: protectedText }, ...nonTextParts],
    };
    delete updated.content;
    return updated;
  });
}

/**
 * Authenticate user and return user ID or error response
 */
async function authenticateUser(
  log: ReturnType<typeof createLogger>,
  timer: (data: Record<string, unknown>) => void
): Promise<{ userId: number; userRoleNames: string[]; session: { sub: string; idToken?: string } } | { error: Response }> {
  const session = await getServerSession();
  if (!session) {
    log.warn('Unauthorized request - no session');
    timer({ status: 'error', reason: 'unauthorized' });
    return { error: new Response('Unauthorized', { status: 401 }) };
  }

  const currentUser = await getCurrentUserAction();
  if (!currentUser.isSuccess) {
    log.error('Failed to get current user');
    return { error: new Response('Unauthorized', { status: 401 }) };
  }

  const userRoleNames = currentUser.data.roles.map(r => r.name);
  return { userId: currentUser.data.user.id, userRoleNames, session };
}

/**
 * Protect classifier traffic with the same K-12 guardrail and PII tokenization
 * boundary as response-model traffic. The main stream performs its own pass so
 * it can retain token mappings for output detokenization; this preflight exists
 * specifically to ensure the internal router never receives raw PII.
 */
async function prepareRoutingText(text: string, sessionId: string): Promise<{
  text: string;
  contentModified: boolean;
}> {
  if (!text.trim()) return { text, contentModified: false };
  const result = await getContentSafetyService().processInput(text, sessionId);
  if (!result.allowed) {
    throw new ContentSafetyBlockedError(
      result.blockedMessage || 'Content blocked by safety guardrails',
      result.blockedCategories || [],
      'input'
    );
  }
  return { text: result.processedContent, contentModified: result.contentModified };
}

async function resolveRequestRouting(args: {
  messages: z.infer<typeof ChatRequestSchema>['messages'];
  fallbackModelId: string;
  nexusMode: z.infer<typeof nexusExperienceModeSchema>;
  modelFamily: z.infer<typeof nexusModelFamilySchema>;
  manuallyEnabledConnectors: string[];
  manuallyEnabledTools: string[];
  userId: number;
  sessionId: string;
  existingConversationId?: string;
}): Promise<{
  routing: Awaited<ReturnType<typeof routeNexusRequest>>;
  specialRouteMessages: z.infer<typeof ChatRequestSchema>['messages'];
  protectedLatestUserText: string;
}> {
  const rawRoutingText = extractImagePrompt(args.messages);
  const protectedRoutingInput = await prepareRoutingText(rawRoutingText, args.sessionId);
  const imageContext = await getImageRoutingContext({
    messages: args.messages,
    conversationId: args.existingConversationId,
    userId: args.userId,
  });
  const routing = await routeNexusRequest({
    text: protectedRoutingInput.text,
    fallbackModelId: args.fallbackModelId,
    experienceMode: args.nexusMode,
    requestedFamily: args.nexusMode === 'advanced' ? args.modelFamily : 'auto',
    enabledConnectorIds: args.manuallyEnabledConnectors,
    enabledToolNames: args.manuallyEnabledTools,
    userId: args.userId,
    hasImageInput: imageContext.hasImageInput,
    hasPreviousGeneratedImage: imageContext.hasPreviousGeneratedImage,
  });
  return {
    routing,
    protectedLatestUserText: protectedRoutingInput.text,
    specialRouteMessages: protectedRoutingInput.contentModified
      ? withProtectedLastUserText(args.messages, protectedRoutingInput.text)
      : args.messages,
  };
}

/**
 * Get and validate model configuration
 */
async function getValidatedModelConfig(
  modelId: string,
  log: ReturnType<typeof createLogger>
): Promise<{
  modelConfig: NonNullable<Awaited<ReturnType<typeof getModelConfig>>>;
  dbModelId: number;
  isImageGenerationModel: boolean;
  isDeepResearchModel: boolean;
} | { error: Response }> {
  const modelConfig = await getModelConfig(modelId);
  if (!modelConfig) {
    log.error('Model not found', { modelId });
    return {
      error: new Response(
        JSON.stringify({ error: 'Selected model not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      )
    };
  }

  const dbModelId = modelConfig.id;
  // REV-PERF-002: derive capability flags from the row getModelConfig already
  // fetched — the previous getAIModelById(dbModelId) here was a second SELECT of the
  // identical ai_models row on every chat/image/deep-research request.
  const isImageGenerationModel = hasCapability(modelConfig.capabilities, 'imageGeneration');
  const isDeepResearchModel = hasCapability(modelConfig.capabilities, 'deepResearch');

  return { modelConfig, dbModelId, isImageGenerationModel, isDeepResearchModel };
}

/** Create a conversation or verify ownership of an existing one. */
async function setupConversation(params: {
  conversationIdValue?: string;
  messages: z.infer<typeof ChatRequestSchema>['messages'];
  userId: number;
  provider: string;
  modelId: string;
  requestId: string;
  log: ReturnType<typeof createLogger>;
  projectId?: string;
}): Promise<{
  conversationId: string;
  conversationTitle: string;
  created: boolean;
} | { error: Response }> {
  const {
    conversationIdValue,
    messages,
    userId,
    provider,
    modelId,
    requestId,
    log,
    projectId,
  } = params;

  let conversationId = conversationIdValue || '';
  let conversationTitle = 'New Conversation';
  let created = false;

  if (!conversationId) {
    conversationTitle = generateConversationTitle(messages as UIMessage[]);
    const convResult = await createConversation({
      userId,
      provider,
      modelId,
      title: conversationTitle,
      projectId,
    });
    if ('error' in convResult) return convResult;
    conversationId = convResult.conversationId;
    created = true;
  } else {
    // Verify the authenticated user owns this conversation before appending messages.
    // Without this check any authenticated user can inject messages into any conversation.
    const owned = await executeQuery(
      (db) => db
        .select({
          id: nexusConversations.id,
          projectId: nexusConversations.projectId,
        })
        .from(nexusConversations)
        .where(and(
          eq(nexusConversations.id, conversationId),
          eq(nexusConversations.userId, userId)
        ))
        .limit(1),
      'verifyConversationOwnership'
    );
    if (!owned || owned.length === 0) {
      log.warn('Conversation ownership check failed — access denied', { conversationId, userId });
      return {
        error: new Response(
          JSON.stringify({ error: 'Conversation not found or access denied', requestId }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        )
      };
    }
    if (owned[0]?.projectId !== (projectId ?? null)) {
      log.warn('Conversation project binding check failed', {
        conversationId,
        userId,
        requestedProjectId: projectId,
      });
      return {
        error: new Response(
          JSON.stringify({ error: 'Conversation not found or access denied', requestId }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        )
      };
    }
  }

  return { conversationId, conversationTitle, created };
}

async function bindAttachmentReferencesOrError(params: {
  ownerId: number;
  conversationId: string;
  references: NexusAttachmentReference[];
  conversationCreated: boolean;
  requestId: string;
  timer: (data: Record<string, unknown>) => void;
  log: ReturnType<typeof createLogger>;
}): Promise<Response | null> {
  if (params.references.length === 0) return null;
  try {
    await bindNexusRequestAttachmentReferences({
      ownerId: params.ownerId,
      conversationId: params.conversationId,
      references: params.references,
      conversationCreated: params.conversationCreated,
    });
    return null;
  } catch (error) {
    params.log.warn("Nexus attachment binding rejected", {
      ownerId: params.ownerId,
      conversationId: params.conversationId,
      referenceCount: params.references.length,
    });
    if (error instanceof NexusAttachmentBindingCleanupError) {
      params.log.error("Failed to remove rejected empty Nexus conversation", {
        conversationId: params.conversationId,
        error: error.message,
      });
      params.timer({
        status: "error",
        reason: "attachment_binding_cleanup_failed",
      });
      return new Response(
        JSON.stringify({
          error: "Unable to attach repository content",
          requestId: params.requestId,
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
    if (!(error instanceof NexusAttachmentBindingRejectedError)) throw error;
    params.timer({ status: "error", reason: "attachment_not_found" });
    return new Response(
      JSON.stringify({
        error: "Attachment not found or access denied",
        requestId: params.requestId,
      }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

async function preflightAttachmentReferencesOrError(params: {
  ownerId: number;
  messages: z.infer<typeof ChatRequestSchema>['messages'];
  inlineAttachmentCount: number;
  requestId: string;
  timer: (data: Record<string, unknown>) => void;
}): Promise<
  | { preflight: NexusAttachmentRequestPreflight }
  | { error: Response }
> {
  try {
    const preflight = await preflightNexusAttachmentReferences({
      ownerId: params.ownerId,
      messages: params.messages,
      additionalAttachmentCount: params.inlineAttachmentCount,
    });
    if (preflight) return { preflight };
    params.timer({ status: "error", reason: "attachment_not_found" });
    return {
      error: new Response(
        JSON.stringify({
          error: "Attachment not found or access denied",
          requestId: params.requestId,
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }
      ),
    };
  } catch (error) {
    if (!(error instanceof NexusAttachmentTurnLimitError)) throw error;
    params.timer({ status: "error", reason: "attachment_limit" });
    return {
      error: new Response(
        JSON.stringify({
          error: error.message,
          requestId: params.requestId,
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      ),
    };
  }
}

function canonicalizeInlineAttachmentsOrError(params: {
  messages: z.infer<typeof ChatRequestSchema>['messages'];
  requestId: string;
  timer: (data: Record<string, unknown>) => void;
  log: ReturnType<typeof createLogger>;
}):
  | {
      messages: z.infer<typeof ChatRequestSchema>['messages'];
      inlineAttachmentCount: number;
    }
  | { error: Response } {
  try {
    const canonical = canonicalizeInlineAttachmentMessages(params.messages);
    return {
      messages: canonical.messages,
      inlineAttachmentCount: canonical.inlineAttachmentCount,
    };
  } catch (error) {
    if (!(error instanceof NexusInlineAttachmentValidationError)) throw error;
    params.log.warn('Invalid inline attachment payload rejected', {
      reason: error.message,
    });
    params.timer({ status: 'error', reason: 'invalid_inline_attachment' });
    return {
      error: new Response(
        JSON.stringify({
          error: 'Invalid inline attachment payload',
          requestId: params.requestId,
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      ),
    };
  }
}

async function persistLastUserMessage(params: {
  conversationId: string;
  messages: z.infer<typeof ChatRequestSchema>['messages'];
  dbModelId: number;
}): Promise<void> {
  const { conversationId, messages, dbModelId } = params;
  // Guard against truly empty messages (no parts, no content)
  // while preserving attachment-only turns. The guard checks the ORIGINAL message
  // from the client (which includes file/attachment parts), not the extracted content.
  // extractUserContent() only serializes text/image parts, so attachment-only messages
  // arrive at saveUserMessage with content='' and parts=[] — but they ARE still saved
  // because hasOriginalContent is true (the original message had file parts).
  const lastMessage = messages[messages.length - 1];
  if (lastMessage && lastMessage.role === 'user') {
    const hasOriginalContent = (lastMessage.parts && lastMessage.parts.length > 0) ||
      (typeof lastMessage.content === 'string' && lastMessage.content.trim().length > 0) ||
      (Array.isArray(lastMessage.content) && lastMessage.content.length > 0);

    if (hasOriginalContent) {
      const { content, parts } = extractUserContent(lastMessage as UIMessage);
      await saveUserMessage({ conversationId, content, parts, dbModelId });
    }
  }
}

/**
 * Resolve MCP connector tools for all enabled connectors (parallel fetch). Pure:
 * returns the resolved results and the list of connector IDs that failed, without
 * mutating any caller-supplied array. Extracted from POST to keep the route
 * handler's cyclomatic complexity within bounds.
 */
async function resolveConnectorTools(params: {
  enabledConnectors: string[];
  userId: number;
  userRoleNames: string[];
  idToken?: string;
  log: ReturnType<typeof createLogger>;
}): Promise<{ resolved: McpConnectorToolsResult[]; failedIds: string[] }> {
  const { enabledConnectors, userId, userRoleNames, idToken, log } = params;
  const resolved: McpConnectorToolsResult[] = [];
  const failedIds: string[] = [];
  if (enabledConnectors.length === 0) return { resolved, failedIds };

  log.info('Resolving MCP connector tools', { connectorCount: enabledConnectors.length });
  const connectorOptions = idToken ? { idToken } : undefined;
  const results = await Promise.allSettled(
    enabledConnectors.map(serverId => getConnectorTools(serverId, userId, userRoleNames, connectorOptions))
  );
  for (const [i, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      resolved.push(result.value);
    } else {
      failedIds.push(enabledConnectors[i]);
      log.warn('Failed to resolve connector tools', {
        serverId: enabledConnectors[i],
        error: result.reason instanceof Error ? result.reason.message : String(result.reason)
      });
    }
  }
  log.info('MCP connector tools resolved', {
    requested: enabledConnectors.length,
    resolved: resolved.length,
    failed: failedIds.length,
    totalTools: resolved.reduce((sum, r) => sum + Object.keys(r.tools).length, 0)
  });
  return { resolved, failedIds };
}

/**
 * Scope-gate built-in (AI SDK) tools via the unified tool catalog (#924). The
 * client-supplied `enabledTools` is untrusted; the catalog drops any AI SDK tool
 * the caller's role-derived scopes don't permit. Uncataloged tool names pass
 * through unchanged (downstream model-capability filtering still applies).
 */
async function scopeFilterEnabledTools(
  enabledTools: string[],
  userRoleNames: string[],
  log: ReturnType<typeof createLogger>
): Promise<string[]> {
  const callerScopes = getScopesForRoles(userRoleNames);
  const scoped = await toolCatalogInstance.filterAiSdkToolNames(enabledTools, callerScopes);
  if (scoped.length !== enabledTools.length) {
    log.info('Tool catalog filtered enabled tools by scope', {
      requested: enabledTools.length,
      allowed: scoped.length,
    });
  }
  return scoped;
}

function assertAutomaticToolsAvailable(
  automaticToolNames: string[],
  availableToolNames: string[]
): void {
  const available = new Set(availableToolNames);
  if (automaticToolNames.some(toolName => !available.has(toolName))) {
    throw new NexusSpecialistUnavailableError(
      'web-search',
      'Web search is not available for your account or the currently loaded skill. Ask an administrator to enable the Web Search tool.'
    );
  }
}

async function scopeRoutedEnabledTools(args: {
  manuallyEnabledToolNames: string[];
  automaticToolNames: string[];
  userRoleNames: string[];
  log: ReturnType<typeof createLogger>;
}): Promise<string[]> {
  const requested = mergeRoutedToolNames(
    args.manuallyEnabledToolNames,
    args.automaticToolNames
  );
  const scoped = await scopeFilterEnabledTools(requested, args.userRoleNames, args.log);
  assertAutomaticToolsAvailable(args.automaticToolNames, scoped);
  return scoped;
}

/**
 * Load the session's bound skill (#925 AC#4/#6 — epic #922 completion audit).
 * Returns the approved skill's session data (allowed-tools pin + name + s3Key)
 * plus its SKILL.md instructions, or null when no skill is bound or the id is
 * unknown/unapproved (callers must then neither loosen tools nor inject
 * instructions). The SKILL.md read is best-effort: a missing artifact still
 * enforces the pin, it just injects nothing.
 */
async function loadBoundSkill(
  skillId: string | undefined,
  log: ReturnType<typeof createLogger>
): Promise<(ApprovedSkillSession & { instructions: string | null }) | null> {
  if (!skillId) return null;
  const session = await getApprovedSkillSession(skillId);
  if (!session) {
    log.warn('Session bound to unknown/unapproved skill; not enforcing tool pin', { skillId });
    return null;
  }
  const instructions = await readSkillMarkdown(session.s3Key);
  if (instructions === null) {
    log.warn('Bound skill has no readable SKILL.md; enforcing pin without instructions', {
      skillId,
    });
  }
  return { ...session, instructions };
}

/**
 * Apply a bound skill's session binding over the already-scope-filtered tool
 * list (#925 — epic #922 completion audit): intersect the built-in tools with
 * the skill's `allowed-tools`, filter the MCP connector tool sets by the same
 * pin (leaving connectors unpinned let a skill-bound session call any external
 * tool), and surface the skill's SKILL.md for system-prompt injection. With no
 * skillId (or an unknown/unapproved one) everything passes through unchanged.
 */
async function applySkillSessionBinding(args: {
  scopedEnabledTools: string[];
  connectorToolResults: McpConnectorToolsResult[];
  skillId: string | undefined;
  log: ReturnType<typeof createLogger>;
}): Promise<{
  scopedEnabledTools: string[];
  effectiveConnectorToolResults: McpConnectorToolsResult[];
  skillInstructions: string | undefined;
  skillName: string | undefined;
  /**
   * The bound skill's `allowed-tools` pin (empty = no pin / no skill). Callers
   * apply it to ANY additional tool set they add after this binding — e.g. the
   * workspace content tools (§1087) — so a restrictive skill can't be widened by
   * opening a workspace (PR #1136 review, codex P2).
   */
  skillAllowedTools: string[];
  skillRepositoryIds: number[];
}> {
  const { connectorToolResults, skillId, log } = args;
  const boundSkill = await loadBoundSkill(skillId, log);
  if (!boundSkill) {
    return {
      scopedEnabledTools: args.scopedEnabledTools,
      effectiveConnectorToolResults: connectorToolResults,
      skillInstructions: undefined,
      skillName: undefined,
      skillAllowedTools: [],
      skillRepositoryIds: [],
    };
  }
  const scopedEnabledTools = intersectSkillAllowedTools(
    args.scopedEnabledTools,
    boundSkill.allowedTools
  );
  const effectiveConnectorToolResults = filterConnectorToolsByPin(
    connectorToolResults,
    boundSkill.allowedTools
  );
  log.info('Skill session binding applied', {
    skillId,
    toolsBefore: args.scopedEnabledTools.length,
    toolsAfter: scopedEnabledTools.length,
    connectorToolsAfter: effectiveConnectorToolResults.reduce(
      (n, r) => n + Object.keys(r.tools).length,
      0
    ),
    hasInstructions: boundSkill.instructions !== null,
  });
  return {
    scopedEnabledTools,
    effectiveConnectorToolResults,
    skillInstructions: boundSkill.instructions ?? undefined,
    skillName: boundSkill.name,
    skillAllowedTools: boundSkill.allowedTools,
    skillRepositoryIds: boundSkill.repositoryIds,
  };
}

/**
 * Apply a bound skill's `allowed-tools` pin to the workspace content tools
 * (§1087 — PR #1136 review): with a non-empty pin, keep only workspace tools the
 * skill explicitly allows (by tool name); an empty pin (no skill / unpinned)
 * leaves them untouched. Prevents a restrictive skill from being silently widened
 * with document/artifact-edit tools just because a workspace is open.
 */
function filterWorkspaceToolsBySkillPin(
  tools: ToolSet | undefined,
  skillAllowedTools: string[]
): ToolSet | undefined {
  if (!tools || skillAllowedTools.length === 0) return tools;
  const allowedNames = intersectSkillAllowedTools(Object.keys(tools), skillAllowedTools);
  const allowed = new Set(allowedNames);
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => allowed.has(name))
  ) as ToolSet;
}

/**
 * Bind the open-workspace content tools for the chat request (Atrium §1087), or
 * null when no workspace is open. Extracted so POST stays under the complexity
 * budget; `buildWorkspaceChatTools` already canView/canEdit-gates and returns
 * null on a bad/unviewable id.
 */
async function bindWorkspaceTools(
  workspaceId: string | undefined,
  userId: number,
  requestId: string
): Promise<Awaited<ReturnType<typeof buildWorkspaceChatTools>>> {
  if (!workspaceId) return null;
  return buildWorkspaceChatTools({ workspaceIdOrSlug: workspaceId, userId, requestId });
}

/**
 * Bind the §1087 workspace tools AND apply the bound skill's allowed-tools pin to
 * them, returning the (possibly empty) tool set + the matching prompt fragment.
 * Extracted so POST stays under the complexity budget (PR #1136 review).
 */
async function bindWorkspaceToolsForChat(args: {
  workspaceId: string | undefined;
  userId: number;
  requestId: string;
  skillAllowedTools: string[];
}): Promise<{ workspaceTools: ToolSet | undefined; workspacePromptFragment: string | undefined }> {
  const workspace = await bindWorkspaceTools(args.workspaceId, args.userId, args.requestId);
  const workspaceTools = filterWorkspaceToolsBySkillPin(workspace?.tools, args.skillAllowedTools);
  // Drop the prompt fragment when the pin filtered every workspace tool away.
  const hasTools = !!workspaceTools && Object.keys(workspaceTools).length > 0;
  return {
    workspaceTools,
    workspacePromptFragment: hasTools ? workspace?.systemPromptFragment : undefined,
  };
}

async function resolveChatProjectBinding(input: {
  requestedProjectId?: string;
  conversationId?: string;
  userId: number;
  requestId: string;
  log: ReturnType<typeof createLogger>;
}): Promise<
  | {
      projectId: string;
      name: string;
      instructions: string;
      repositoryIds: number[];
    }
  | null
  | { error: Response }
> {
  let projectId = input.requestedProjectId;
  if (!projectId && input.conversationId) {
    const conversationId = input.conversationId;
    const [conversation] = await executeQuery(
      (db) =>
        db
          .select({ projectId: nexusConversations.projectId })
          .from(nexusConversations)
          .where(
            and(
              eq(nexusConversations.id, conversationId),
              eq(nexusConversations.userId, input.userId)
            )
          )
          .limit(1),
      "resolveNexusConversationProject"
    );
    projectId = conversation?.projectId ?? undefined;
  }
  if (!projectId) return null;
  try {
    const context = await resolveNexusProjectChatContext({
      projectId,
      userId: input.userId,
    });
    return { projectId, ...context };
  } catch (error) {
    if (!(error instanceof NexusProjectAccessError)) throw error;
    input.log.warn("Nexus project binding denied", {
      userId: input.userId,
      projectId,
    });
    return {
      error: new Response(
        JSON.stringify({
          error: "Project not found or access denied",
          requestId: input.requestId,
        }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      ),
    };
  }
}

type ChatRequestData = z.infer<typeof ChatRequestSchema>;
type ChatMessages = ChatRequestData['messages'];
type ChatSession = { sub: string; idToken?: string };
type SuccessfulProjectBinding = Exclude<
  Awaited<ReturnType<typeof resolveChatProjectBinding>>,
  { error: Response }
>;

interface PreparedChatRequest {
  validationData: ChatRequestData;
  conversationIdValue?: string;
  enabledTools: string[];
  manuallyEnabledConnectors: string[];
  skillId?: string;
  workspaceId?: string;
  userId: number;
  userRoleNames: string[];
  session: ChatSession;
  projectBinding: SuccessfulProjectBinding;
  attachmentPreflight: NexusAttachmentRequestPreflight;
  safePersistenceMessages: ChatMessages;
  safeModelMessages: ChatMessages;
  routingEnabledTools: string[];
}

type PreparedChatResult =
  | { ok: true; context: PreparedChatRequest }
  | { ok: false; response: Response };

type ValidatedModelConfig = Exclude<
  Awaited<ReturnType<typeof getValidatedModelConfig>>,
  { error: Response }
>;
type SuccessfulConversationSetup = Exclude<
  Awaited<ReturnType<typeof setupConversation>>,
  { error: Response }
>;

interface ResolvedChatRequest {
  routing: Awaited<ReturnType<typeof resolveRequestRouting>>['routing'];
  modelId: string;
  enabledConnectors: string[];
  catalogScopedEnabledTools: string[];
  modelConfig: ValidatedModelConfig['modelConfig'];
  dbModelId: number;
  messagesWithParts: UIMessage[];
  persistenceMessagesWithParts: UIMessage[];
  precomputedInputTokenMappings: TokenMapping[];
  protectedLatestUserText: string;
}

type ResolvedChatResult =
  | { ok: true; context: ResolvedChatRequest }
  | { ok: false; response: Response };

interface ConversationRepositoryContext {
  lightweightMessages: UIMessage[];
  repositoryTokenMappingSink?: TokenMappingSink;
  attachmentTools: ToolSet;
  projectTools: ToolSet;
}

type ConversationRepositoryResult =
  | { ok: true; context: ConversationRepositoryContext }
  | { ok: false; response: Response };

async function buildRoutingEnabledTools(params: {
  conversationId?: string;
  userId: number;
  attachmentPreflight: NexusAttachmentRequestPreflight;
  enabledTools: string[];
  hasProjectBinding: boolean;
  hasSkillBinding: boolean;
}): Promise<string[]> {
  const repositoryIds = params.conversationId
    ? await resolveNexusConversationRepositoryIds({
        ownerId: params.userId,
        conversationId: params.conversationId,
      })
    : [];
  const requiresAttachmentTools =
    repositoryIds.length > 0 ||
    params.attachmentPreflight.requiresAttachmentTools;
  return [
    ...new Set([
      ...params.enabledTools,
      ...(requiresAttachmentTools ? ["searchNexusAttachments"] : []),
      ...(params.hasProjectBinding ? ["searchProjectRepositories"] : []),
      ...(params.hasSkillBinding ? ["searchSkillRepositories"] : []),
    ]),
  ];
}

async function prepareChatRequest(params: {
  req: Request;
  requestId: string;
  timer: (data: Record<string, unknown>) => void;
  log: ReturnType<typeof createLogger>;
}): Promise<PreparedChatResult> {
  const body = await params.req.json();
  const validation = validateRequest(body, params.requestId, params.log);
  if (!validation.valid) return { ok: false, response: validation.error };
  const data = validation.data;
  const conversationIdValue = data.conversationId || undefined;
  const conversationError = validateConversationId(
    conversationIdValue,
    params.requestId,
    params.log,
  );
  if (conversationError) {
    return { ok: false, response: conversationError };
  }
  params.log.info(
    "Request parsed",
    sanitizeForLogging({
      messageCount: data.messages.length,
      fallbackModelId: data.modelId,
      nexusMode: data.nexusMode,
      modelFamily: data.modelFamily,
      hasConversationId: !!conversationIdValue,
      enabledTools: data.enabledTools ?? [],
    }),
  );
  const auth = await authenticateUser(params.log, params.timer);
  if ("error" in auth) return { ok: false, response: auth.error };

  const canonical = canonicalizeInlineAttachmentsOrError({
    messages: data.messages,
    requestId: params.requestId,
    timer: params.timer,
    log: params.log,
  });
  if ("error" in canonical) {
    return { ok: false, response: canonical.error };
  }
  const projectBinding = await resolveChatProjectBinding({
    requestedProjectId: data.projectId,
    conversationId: conversationIdValue,
    userId: auth.userId,
    requestId: params.requestId,
    log: params.log,
  });
  if (projectBinding && "error" in projectBinding) {
    return { ok: false, response: projectBinding.error };
  }
  const preflight = await preflightAttachmentReferencesOrError({
    ownerId: auth.userId,
    messages: canonical.messages,
    inlineAttachmentCount: canonical.inlineAttachmentCount,
    requestId: params.requestId,
    timer: params.timer,
  });
  if ("error" in preflight) {
    return { ok: false, response: preflight.error };
  }
  const prepared = prepareRepositoryAttachmentMessages(
    canonical.messages as UIMessage[],
    preflight.preflight.resolutions.map((resolution) => ({
      bindingId: resolution.bindingId,
      itemId: resolution.itemId,
      name: resolution.itemName,
    })),
  );
  const enabledTools = data.enabledTools ?? [];
  const routingEnabledTools = await buildRoutingEnabledTools({
    conversationId: conversationIdValue,
    userId: auth.userId,
    attachmentPreflight: preflight.preflight,
    enabledTools,
    hasProjectBinding: !!projectBinding,
    hasSkillBinding: !!data.skillId,
  });
  return {
    ok: true,
    context: {
      validationData: data,
      conversationIdValue,
      enabledTools,
      manuallyEnabledConnectors: data.enabledConnectors ?? [],
      skillId: data.skillId,
      workspaceId: data.workspaceId,
      userId: auth.userId,
      userRoleNames: auth.userRoleNames,
      session: auth.session,
      projectBinding,
      attachmentPreflight: preflight.preflight,
      safePersistenceMessages: prepared.messages as ChatMessages,
      safeModelMessages: prepared.modelMessages as ChatMessages,
      routingEnabledTools,
    },
  };
}

function createSpecialModelCompatibilityError(params: {
  isDeepResearchModel: boolean;
  isImageGenerationModel: boolean;
  hasAttachmentReferences: boolean;
  hasProjectBinding: boolean;
  requestId: string;
  timer: (data: Record<string, unknown>) => void;
}): Response | null {
  if (
    params.isDeepResearchModel &&
    (params.hasAttachmentReferences || params.hasProjectBinding)
  ) {
    params.timer({
      status: "error",
      reason: "deep_research_attachment_unsupported",
    });
    return new Response(
      JSON.stringify({
        error:
          "Deep Research does not support repository-backed project content. Choose a chat model for this request.",
        requestId: params.requestId,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  if (params.isImageGenerationModel && params.hasProjectBinding) {
    params.timer({ status: "error", reason: "image_project_unsupported" });
    return new Response(
      JSON.stringify({
        error:
          "Image generation does not use project repository context. Choose a chat model for this request.",
        requestId: params.requestId,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  return null;
}

async function resolveChatModel(params: {
  prepared: PreparedChatRequest;
  abortSignal: AbortSignal;
  requestId: string;
  timer: (data: Record<string, unknown>) => void;
  log: ReturnType<typeof createLogger>;
}): Promise<ResolvedChatResult> {
  const { prepared, requestId, timer, log } = params;
  const {
    routing,
    specialRouteMessages,
    protectedLatestUserText,
  } = await resolveRequestRouting({
    messages: prepared.safeModelMessages,
    fallbackModelId: prepared.validationData.modelId,
    nexusMode: prepared.validationData.nexusMode,
    modelFamily: prepared.validationData.modelFamily,
    manuallyEnabledConnectors: prepared.manuallyEnabledConnectors,
    manuallyEnabledTools: prepared.routingEnabledTools,
    userId: prepared.userId,
    sessionId: prepared.session.sub,
    existingConversationId: prepared.conversationIdValue,
  });
  const modelId = routing.modelId;
  const catalogScopedEnabledTools = await scopeRoutedEnabledTools({
    manuallyEnabledToolNames: prepared.enabledTools,
    automaticToolNames: routing.automaticToolNames,
    userRoleNames: prepared.userRoleNames,
    log,
  });
  const modelResult = await getValidatedModelConfig(modelId, log);
  if ("error" in modelResult) {
    return { ok: false, response: modelResult.error };
  }
  const {
    modelConfig,
    dbModelId,
    isImageGenerationModel,
    isDeepResearchModel,
  } = modelResult;
  log.info(
    "Model configured",
    sanitizeForLogging({
      provider: modelConfig.provider,
      modelId: modelConfig.model_id,
      dbId: dbModelId,
      isImageGeneration: isImageGenerationModel,
      isDeepResearch: isDeepResearchModel,
    }),
  );
  if (!(await userCanAccessResource(prepared.userId, "model", dbModelId))) {
    log.warn("Forbidden model for user", {
      userId: prepared.userId,
      dbModelId,
      modelId: modelConfig.model_id,
    });
    timer({ status: "error", reason: "forbidden_model" });
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          success: false,
          message: "You do not have access to this model",
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    };
  }
  const inlineSafetyResult = await scanCanonicalInlineAttachments({
    messages: convertMessagesToPartsFormat(
      prepared.safeModelMessages as UIMessage[],
    ),
    sessionId: prepared.session.sub,
    safetyProcessor: getContentSafetyService(),
    onFailure: (error) => {
      log.error(
        "Pre-flight attachment privacy scan failed — attachment quarantined",
        {
          requestId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
      );
    },
  });
  const persistenceMessagesWithParts = applyProcessedInlineAttachmentValues(
    convertMessagesToPartsFormat(
      prepared.safePersistenceMessages as UIMessage[],
    ),
    inlineSafetyResult.processedValues,
  );
  const specialRouteMessagesWithParts = applyProcessedInlineAttachmentValues(
    convertMessagesToPartsFormat(specialRouteMessages as UIMessage[]),
    inlineSafetyResult.processedValues,
  );
  const compatibilityError = createSpecialModelCompatibilityError({
    isDeepResearchModel,
    isImageGenerationModel,
    hasAttachmentReferences: prepared.attachmentPreflight.references.length > 0,
    hasProjectBinding: !!prepared.projectBinding,
    requestId,
    timer,
  });
  if (compatibilityError) {
    return { ok: false, response: compatibilityError };
  }
  const specialRoute = await routeSpecialModel({
    isImageGenerationModel,
    isDeepResearchModel,
    messages: specialRouteMessagesWithParts as ChatMessages,
    persistenceMessages: persistenceMessagesWithParts as ChatMessages,
    attachmentReferences: prepared.attachmentPreflight.references,
    modelConfig,
    modelId,
    dbModelId,
    userId: prepared.userId,
    existingConversationId: prepared.conversationIdValue,
    requestId,
    timer,
    log,
    abortSignal: params.abortSignal,
    routingMetadata: routing.metadata,
  });
  if (specialRoute) {
    return { ok: false, response: specialRoute };
  }
  return {
    ok: true,
    context: {
      routing,
      modelId,
      enabledConnectors: routing.connectorIds,
      catalogScopedEnabledTools,
      modelConfig,
      dbModelId,
      messagesWithParts: inlineSafetyResult.messages,
      persistenceMessagesWithParts,
      precomputedInputTokenMappings: inlineSafetyResult.tokens,
      protectedLatestUserText,
    },
  };
}

async function prepareConversationRepositories(params: {
  prepared: PreparedChatRequest;
  resolved: ResolvedChatRequest;
  conversation: SuccessfulConversationSetup;
  requestId: string;
  timer: (data: Record<string, unknown>) => void;
  log: ReturnType<typeof createLogger>;
}): Promise<ConversationRepositoryResult> {
  const { prepared, resolved, conversation, requestId, timer, log } = params;
  const bindingError = await bindAttachmentReferencesOrError({
    ownerId: prepared.userId,
    conversationId: conversation.conversationId,
    references: prepared.attachmentPreflight.references,
    conversationCreated: conversation.created,
    requestId,
    timer,
    log,
  });
  if (bindingError) {
    return { ok: false, response: bindingError };
  }
  await persistLastUserMessage({
    conversationId: conversation.conversationId,
    messages: resolved.persistenceMessagesWithParts as ChatMessages,
    dbModelId: resolved.dbModelId,
  });
  const attachmentRepositoryIds = await resolveNexusConversationRepositoryIds({
    ownerId: prepared.userId,
    conversationId: conversation.conversationId,
  });
  const repositoryTokenMappingSink =
    attachmentRepositoryIds.length > 0 ||
    prepared.projectBinding ||
    prepared.skillId
      ? createTokenMappingSink()
      : undefined;
  const attachmentTools = repositoryTokenMappingSink
    ? createNexusAttachmentTools({
        repositoryIds: attachmentRepositoryIds,
        userCognitoSub: prepared.session.sub,
        tokenMappingSink: repositoryTokenMappingSink,
      })
    : {};
  const projectTools =
    repositoryTokenMappingSink && prepared.projectBinding
      ? createNexusRepositorySearchTools({
          repositoryIds: prepared.projectBinding.repositoryIds,
          userCognitoSub: prepared.session.sub,
          tokenMappingSink: repositoryTokenMappingSink,
          toolName: "searchProjectRepositories",
          description:
            `Search the repositories connected to the Nexus project "${prepared.projectBinding.name}". ` +
            "Use this before making project-specific claims and cite returned sources.",
        })
      : {};
  const { lightweightMessages } = await processMessagesWithAttachments(
    conversation.conversationId,
    resolved.messagesWithParts,
  );
  return {
    ok: true,
    context: {
      lightweightMessages,
      repositoryTokenMappingSink,
      attachmentTools,
      projectTools,
    },
  };
}

function buildRepositoryPromptFragment(params: {
  projectBinding: SuccessfulProjectBinding;
  skillRepositoryIds: number[];
}): string | undefined {
  const fragments = [
    params.projectBinding
      ? `You are working in the Nexus project "${params.projectBinding.name}". Follow these project instructions for this conversation:\n\n${params.projectBinding.instructions || "(No additional instructions.)"}\n\nUse searchProjectRepositories for project repository questions.`
      : null,
    params.skillRepositoryIds.length > 0
      ? "The loaded skill has repository bindings. Use searchSkillRepositories before applying repository-dependent instructions."
      : null,
  ].filter((value): value is string => value !== null);
  return fragments.join("\n\n---\n\n") || undefined;
}

async function resolveToolsAndStream(params: {
  prepared: PreparedChatRequest;
  resolved: ResolvedChatRequest;
  conversation: SuccessfulConversationSetup;
  repositories: ConversationRepositoryContext;
  connectorToolResults: McpConnectorToolsResult[];
  requestId: string;
  timer: (data: Record<string, unknown>) => void;
  log: ReturnType<typeof createLogger>;
}): Promise<Response> {
  const { prepared, resolved, conversation, repositories, log } = params;
  const { resolved: connectorTools, failedIds } = await resolveConnectorTools({
    enabledConnectors: resolved.enabledConnectors,
    userId: prepared.userId,
    userRoleNames: prepared.userRoleNames,
    idToken: prepared.session.idToken,
    log,
  });
  params.connectorToolResults.push(...connectorTools);
  const failedAutomaticConnectorIds =
    resolved.routing.automaticConnectorIds.filter((connectorId) =>
      failedIds.includes(connectorId),
    );
  if (failedAutomaticConnectorIds.length > 0) {
    throw new NexusSpecialistUnavailableError(
      "psd-data",
      "PSD Data could not be connected for this request. Reconnect the service or try again shortly.",
      failedAutomaticConnectorIds,
    );
  }
  const skillBinding = await applySkillSessionBinding({
    scopedEnabledTools: resolved.catalogScopedEnabledTools,
    connectorToolResults: connectorTools,
    skillId: prepared.skillId,
    log,
  });
  assertAutomaticToolsAvailable(
    resolved.routing.automaticToolNames,
    skillBinding.scopedEnabledTools,
  );
  const skillRepositoryTools =
    repositories.repositoryTokenMappingSink &&
    skillBinding.skillRepositoryIds.length > 0
      ? createNexusRepositorySearchTools({
          repositoryIds: skillBinding.skillRepositoryIds,
          userCognitoSub: prepared.session.sub,
          tokenMappingSink: repositories.repositoryTokenMappingSink,
          toolName: "searchSkillRepositories",
          description:
            "Search the repositories bound to the loaded skill. Use current results before following repository-dependent skill instructions and cite returned sources.",
        })
      : {};
  const repositoryTools: ToolSet = {
    ...repositories.attachmentTools,
    ...repositories.projectTools,
    ...skillRepositoryTools,
  };
  const { workspaceTools, workspacePromptFragment } =
    await bindWorkspaceToolsForChat({
      workspaceId: prepared.workspaceId,
      userId: prepared.userId,
      requestId: params.requestId,
      skillAllowedTools: skillBinding.skillAllowedTools,
    });
  const memoryToolCallingSupported = modelSupportsFunctionCalling({
    provider: resolved.modelConfig.provider,
    providerMetadata: resolved.modelConfig.providerMetadata,
  });
  const memoryContext = await resolveNexusMemoryContext({
    userId: prepared.userId,
    cognitoSub: prepared.session.sub,
    conversationId: conversation.conversationId,
    latestUserText: resolved.protectedLatestUserText,
    requestId: params.requestId,
    toolCallingSupported: memoryToolCallingSupported,
  });
  log.info("Nexus memory turn context resolved", {
    conversationId: conversation.conversationId,
    enabled: memoryContext.enabled,
    reason: memoryContext.reason,
    hasFragment: !!memoryContext.userMemoryFragment,
    toolsBound: !!memoryContext.tools,
  });
  return executeStreaming({
    messages: repositories.lightweightMessages,
    modelConfig: resolved.modelConfig,
    userId: prepared.userId,
    sessionId: prepared.session.sub,
    conversationId: conversation.conversationId,
    conversationIdValue: prepared.conversationIdValue,
    conversationTitle: conversation.conversationTitle,
    enabledTools: skillBinding.scopedEnabledTools,
    enabledConnectors: resolved.enabledConnectors,
    connectorToolResults: skillBinding.effectiveConnectorToolResults,
    failedConnectorIds: failedIds,
    skillInstructions: skillBinding.skillInstructions,
    skillName: skillBinding.skillName,
    workspaceTools,
    workspacePromptFragment,
    attachmentTools: repositoryTools,
    repositoryPromptFragment: buildRepositoryPromptFragment({
      projectBinding: prepared.projectBinding,
      skillRepositoryIds: skillBinding.skillRepositoryIds,
    }),
    memoryTools: memoryContext.tools,
    userMemoryFragment: memoryContext.userMemoryFragment,
    latestUserText: resolved.protectedLatestUserText,
    reasoningEffort: prepared.validationData.reasoningEffort || "medium",
    responseMode: prepared.validationData.responseMode || "standard",
    requestId: params.requestId,
    dbModelId: resolved.dbModelId,
    log,
    timer: params.timer,
    precomputedInputTokenMappings: resolved.precomputedInputTokenMappings,
    inputTokenMappingSink: repositories.repositoryTokenMappingSink,
    routingMetadata: resolved.routing.metadata,
  });
}

async function compensateFailedAttachmentTurn(params: {
  prepared: PreparedChatRequest;
  conversation: SuccessfulConversationSetup;
  log: ReturnType<typeof createLogger>;
}): Promise<void> {
  if (
    !params.conversation.created ||
    params.prepared.attachmentPreflight.references.length === 0
  ) {
    return;
  }
  try {
    await rollbackNewNexusAttachmentConversation({
      ownerId: params.prepared.userId,
      conversationId: params.conversation.conversationId,
    });
  } catch (cleanupError) {
    params.log.error(
      "Failed to compensate a failed repository attachment turn",
      {
        conversationId: params.conversation.conversationId,
        error:
          cleanupError instanceof Error
            ? cleanupError.message
            : "Unknown cleanup error",
      },
    );
    throw cleanupError;
  }
}

async function executeStandardChatTurn(params: {
  prepared: PreparedChatRequest;
  resolved: ResolvedChatRequest;
  connectorToolResults: McpConnectorToolsResult[];
  requestId: string;
  timer: (data: Record<string, unknown>) => void;
  log: ReturnType<typeof createLogger>;
}): Promise<Response> {
  const conversation = await setupConversation({
    conversationIdValue: params.prepared.conversationIdValue,
    messages: params.resolved.messagesWithParts as ChatMessages,
    userId: params.prepared.userId,
    provider: params.resolved.modelConfig.provider,
    modelId: params.resolved.modelId,
    requestId: params.requestId,
    log: params.log,
    projectId: params.prepared.projectBinding?.projectId,
  });
  if ("error" in conversation) return conversation.error;
  try {
    const repositories = await prepareConversationRepositories({
      prepared: params.prepared,
      resolved: params.resolved,
      conversation,
      requestId: params.requestId,
      timer: params.timer,
      log: params.log,
    });
    if (!repositories.ok) return repositories.response;
    return await resolveToolsAndStream({
      prepared: params.prepared,
      resolved: params.resolved,
      conversation,
      repositories: repositories.context,
      connectorToolResults: params.connectorToolResults,
      requestId: params.requestId,
      timer: params.timer,
      log: params.log,
    });
  } catch (turnError) {
    await compensateFailedAttachmentTurn({
      prepared: params.prepared,
      conversation,
      log: params.log,
    });
    throw turnError;
  }
}

/**
 * Nexus Chat API - Native Streaming with AI SDK v5
 */

export async function POST(req: Request) {
  const requestId = generateRequestId();
  const timer = startTimer("api.nexus.chat");
  const log = createLogger({ requestId, route: "api.nexus.chat" });
  const connectorToolResults: McpConnectorToolsResult[] = [];

  log.info(
    "POST /api/nexus/chat - Processing chat request with native streaming",
  );

  try {
    const prepared = await prepareChatRequest({
      req,
      requestId,
      timer,
      log,
    });
    if (!prepared.ok) return prepared.response;

    const resolved = await resolveChatModel({
      prepared: prepared.context,
      abortSignal: req.signal,
      requestId,
      timer,
      log,
    });
    if (!resolved.ok) return resolved.response;

    return await executeStandardChatTurn({
      prepared: prepared.context,
      resolved: resolved.context,
      connectorToolResults,
      requestId,
      timer,
      log,
    });
  } catch (error) {
    await closeMcpClients(connectorToolResults, log, "catch");
    return buildChatErrorResponse(error, requestId, log, timer);
  }
}

/**
 * Map a pre-stream POST error to an HTTP Response. Content-safety blocks return
 * 400 with category detail; everything else returns a generic 500. Extracted
 * from POST to keep the route handler's cyclomatic complexity within bounds.
 */
function buildChatErrorResponse(
  error: unknown,
  requestId: string,
  log: ReturnType<typeof createLogger>,
  timer: (data: Record<string, unknown>) => void
): Response {
  if (error instanceof NexusSpecialistUnavailableError) {
    log.warn('Nexus specialist unavailable', {
      specialist: error.specialist,
      reconnectConnectorCount: error.reconnectConnectorIds.length,
    });
    timer({ status: 'error', reason: `${error.specialist}_unavailable` });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Request-Id': requestId,
    };
    if (error.reconnectConnectorIds.length > 0) {
      headers['X-Connector-Reconnect'] = error.reconnectConnectorIds.join(',');
    }
    return new Response(
      JSON.stringify({
        error: error.message,
        code: 'NEXUS_SPECIALIST_UNAVAILABLE',
        specialist: error.specialist,
        requestId,
      }),
      { status: 503, headers }
    );
  }

  if (error instanceof ContentSafetyBlockedError) {
    log.warn('Content blocked by safety guardrails', {
      error: { message: error.message, name: error.name },
      categories: error.blockedCategories,
      source: error.source
    });
    timer({ status: 'blocked' });
    return new Response(
      JSON.stringify({
        error: error.message,
        code: 'CONTENT_BLOCKED',
        categories: error.blockedCategories,
        source: error.source,
        requestId,
      }),
      { status: 400, headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId } }
    );
  }

  log.error('Nexus chat API error', {
    error: error instanceof Error ? { message: error.message, name: error.name } : String(error)
  });
  timer({ status: 'error' });
  return new Response(
    JSON.stringify({ error: 'Failed to process chat request', requestId }),
    { status: 500, headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId } }
  );
}
