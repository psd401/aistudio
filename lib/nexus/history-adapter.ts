"use client";

import { createLogger } from "@/lib/client-logger";
import type {
  ThreadHistoryAdapter,
  ThreadMessage,
  MessageFormatAdapter,
  MessageFormatRepository,
  MessageFormatItem,
  GenericThreadHistoryAdapter,
} from "@assistant-ui/react";
// @assistant-ui/react 0.14.23 moved fromThreadMessageLike from the INTERNAL
// namespace to a top-level export.
import { fromThreadMessageLike } from "@assistant-ui/react";

// Import ExportedMessageRepository type and utility
type ExportedMessageRepository = {
  headId?: string | null;
  messages: Array<{
    message: ThreadMessage;
    parentId: string | null;
  }>;
};

// Type for incoming message data from API
type MessageData = {
  id: string;
  role: "user" | "assistant" | "system";
  content?:
    Array<{ type: "text"; text?: string; [key: string]: unknown }> | string;
  createdAt?: string | Date;
  [key: string]: unknown;
};

// Allow only https: image URLs to prevent javascript:/data: XSS via stored imageUrl values.
const isSafeImageUrl = (url: string): boolean => {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
};

// Helper to convert a content part to text format
// Handles text, image, and other part types by converting to displayable text
const convertPartToText = (part: {
  type: string;
  text?: string;
  imageUrl?: string;
  [key: string]: unknown;
}): string => {
  if (part.type === "text") {
    return part.text || "";
  }
  if (part.type === "image" && part.imageUrl && isSafeImageUrl(part.imageUrl)) {
    // Convert image parts to markdown image syntax (URL already validated as https: only)
    return `![Generated Image](${part.imageUrl})`;
  }
  // Skip step-start, step-finish, and other control types
  if (part.type === "step-start" || part.type === "step-finish") {
    return "";
  }
  return "";
};

// Validated role set — guards against non-standard roles from partial writes or migrations.
const VALID_ROLES = new Set(["user", "assistant", "system"] as const);
type ValidRole = "user" | "assistant" | "system";
const safeRole = (role: string | undefined): ValidRole =>
  VALID_ROLES.has(role as ValidRole) ? (role as ValidRole) : "user";

// Returns a valid Date if the value is parseable and finite, otherwise undefined.
const safeDate = (value: string | Date | undefined): Date | undefined => {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : undefined;
};

// JSON object type for tool arguments (matches assistant-ui's ReadonlyJSONObject)
type JSONObject = { readonly [key: string]: JSONValue };
type JSONValue =
  string | number | boolean | null | JSONObject | readonly JSONValue[];

// Type for assistant-ui content parts
// Uses tool-call format for fromThreadMessageLike compatibility (Issue #798)
type ContentPartLike =
  | { type: "text"; text: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      args: JSONObject;
      argsText: string;
      result?: unknown;
      isError?: boolean;
      // AI SDK v6 UIMessage fields required by convertToModelMessages (Issue #977)
      state: "input-available" | "output-available" | "output-error";
      input: JSONObject;
    };

type StoredPartData = {
  type: string;
  text?: string;
  imageUrl?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  state?: unknown;
};

function storedToolState(
  part: StoredPartData,
): "input-available" | "output-available" | "output-error" {
  if (
    part.state === "input-available" ||
    part.state === "output-available" ||
    part.state === "output-error"
  ) {
    return part.state;
  }
  if (part.isError === true) return "output-error";
  return part.result == null ? "input-available" : "output-available";
}

function storedToolPart(part: StoredPartData): ContentPartLike | null {
  if (!part.toolName || !part.toolCallId) return null;
  const args: JSONObject = (part.args ?? {}) as JSONObject;
  return {
    type: "tool-call",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    args,
    argsText: JSON.stringify(args),
    result: part.result,
    isError: part.isError === true,
    state: storedToolState(part),
    input: args,
  };
}

function storedContentPart(part: StoredPartData): ContentPartLike | null {
  if (part.type === "text") {
    return { type: "text", text: part.text || "" };
  }
  if (part.type === "tool-call") return storedToolPart(part);
  if (part.type === "image" && part.imageUrl && isSafeImageUrl(part.imageUrl)) {
    return { type: "text", text: `![Generated Image](${part.imageUrl})` };
  }
  return null;
}

function messageContent(message: MessageData): ContentPartLike[] {
  if (typeof message.content === "string") {
    return [{ type: "text", text: message.content }];
  }
  if (!Array.isArray(message.content)) return [{ type: "text", text: "" }];
  const parts = message.content
    .map((part) => storedContentPart(part as StoredPartData))
    .filter((part): part is ContentPartLike => part !== null);
  return parts.length > 0 ? parts : [{ type: "text", text: "" }];
}

function repositoryParentId(
  messages: MessageData[],
  index: number,
): string | null {
  return index === 0 ? null : messages[index - 1]?.id || null;
}

function placeholderMessage(message: MessageData): ThreadMessage {
  return fromThreadMessageLike(
    {
      id: message.id,
      role: safeRole(message.role),
      content: [
        { type: "text", text: "[Message could not be loaded]" },
      ] as unknown as string,
    },
    message.id,
    { type: "complete", reason: "unknown" },
  );
}

function convertRepositoryMessage(
  message: MessageData,
  index: number,
  messages: MessageData[],
): ExportedMessageRepository["messages"][number] | null {
  const role = safeRole(message.role);
  const createdAt = safeDate(message.createdAt);
  const parentId = repositoryParentId(messages, index);
  try {
    const converted = fromThreadMessageLike(
      {
        id: message.id,
        role,
        content: messageContent(message) as unknown as string,
        ...(createdAt && { createdAt }),
      },
      message.id,
      { type: "complete", reason: "unknown" },
    );
    if (!converted) throw new Error("fromThreadMessageLike returned falsy");
    return { message: converted, parentId };
  } catch (error) {
    log.warn("Failed to convert message, using placeholder", {
      messageId: message.id,
      messageIndex: index,
      error:
        error instanceof Error
          ? error.message.substring(0, 200)
          : String(error).substring(0, 200),
    });
    try {
      return { message: placeholderMessage(message), parentId };
    } catch (fallbackError) {
      log.error("Fallback message construction failed, skipping message", {
        messageId: message.id,
        messageIndex: index,
        error:
          fallbackError instanceof Error
            ? fallbackError.message.substring(0, 200)
            : String(fallbackError).substring(0, 200),
      });
      return null;
    }
  }
}

// We'll use a simple implementation since ExportedMessageRepository.fromArray may not be accessible
const createExportedMessageRepository = (
  messages: MessageData[],
): ExportedMessageRepository => {
  // Filter out null/undefined entries and messages with malformed IDs before processing.
  // This guards against partially-persisted messages (e.g. from expired-session writes)
  // that would cause fromThreadMessageLike to throw and crash the whole conversation load.
  const validMessages = messages.filter(
    (msg): msg is MessageData => msg != null && typeof msg.id === "string",
  );

  return {
    messages: validMessages
      .map((message, index) =>
        convertRepositoryMessage(message, index, validMessages),
      )
      .filter((item): item is NonNullable<typeof item> => item !== null),
  };
};

// ExportedMessageRepositoryItem is not exported from the main module, so we'll define it based on the expected structure
type ExportedMessageRepositoryItem = {
  message: ThreadMessage;
  parentId: string | null;
};

const log = createLogger({ moduleName: "nexus-history-adapter" });

/**
 * Creates a ThreadHistoryAdapter that loads and saves conversation messages.
 *
 * Accepts a getter function for conversationId so the adapter instance can
 * remain stable (not recreated) when the ID transitions from null → UUID
 * during a new conversation. This prevents the runtime from re-calling
 * load() mid-stream, which would fetch already-displayed messages from
 * the database and cause duplicate message rendering. (Issue #868)
 */
export function createNexusHistoryAdapter(
  getConversationId: () => string | null,
): ThreadHistoryAdapter {
  const adapter: ThreadHistoryAdapter = {
    async load(): Promise<
      ExportedMessageRepository & { unstable_resume?: boolean }
    > {
      const conversationId = getConversationId();
      if (!conversationId) {
        log.debug("No conversation ID, returning empty repository");
        return { messages: [] };
      }

      try {
        log.debug("Loading conversation messages", { conversationId });

        const response = await fetch(
          `/api/nexus/conversations/${conversationId}/messages`,
        );

        if (!response.ok) {
          if (response.status === 404) {
            log.warn("Conversation not found", { conversationId });
            return { messages: [] };
          }
          throw new Error(`Failed to load messages: ${response.status}`);
        }

        const data = await response.json();
        const { messages = [] } = data;

        // Convert messages using our helper function
        const repository = createExportedMessageRepository(messages);

        log.debug("Messages loaded successfully", {
          conversationId,
          messageCount: repository.messages.length,
        });

        return repository;
      } catch (error) {
        log.error("Failed to load conversation messages", {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        });

        return { messages: [] };
      }
    },

    async append(item: ExportedMessageRepositoryItem): Promise<void> {
      // Messages are persisted server-side in the /api/nexus/chat route handler:
      // user messages by setupConversation() and assistant messages by onFinish().
      // This no-op prevents the runtime from double-saving through the history adapter.
      log.debug("Skipping message save - handled by chat route handler", {
        conversationId: getConversationId(),
        messageRole: item.message.role,
        messageId: item.message.id,
      });
      return;
    },

    withFormat<TMessage, TStorageFormat extends Record<string, unknown>>(
      formatAdapter: MessageFormatAdapter<TMessage, TStorageFormat>,
    ): GenericThreadHistoryAdapter<TMessage> {
      return {
        async load(): Promise<MessageFormatRepository<TMessage>> {
          // Load from base adapter (returns ExportedMessageRepository with ThreadMessages)
          const exportedRepo = await adapter.load();

          log.debug("withFormat.load called", {
            conversationId: getConversationId(),
            messageCount: exportedRepo.messages.length,
          });

          // Convert ThreadMessage format to storage format, then decode to TMessage
          return {
            headId: exportedRepo.headId || null,
            messages: exportedRepo.messages.map((item) => {
              // ThreadMessage has .content (array of parts)
              // Storage format expects .parts (array of parts)
              const threadMessage = item.message;

              // Create MessageStorageEntry for the format adapter
              const storageEntry = {
                id: threadMessage.id,
                parent_id: item.parentId,
                format: formatAdapter.format,
                content: {
                  role: threadMessage.role,
                  parts: threadMessage.content, // Convert .content → .parts
                  ...(threadMessage.createdAt && {
                    createdAt: threadMessage.createdAt,
                  }),
                } as unknown as TStorageFormat,
              };

              // Use format adapter to decode into the expected message format
              return formatAdapter.decode(storageEntry);
            }),
          };
        },

        async append(item: MessageFormatItem<TMessage>): Promise<void> {
          log.debug("withFormat.append called", {
            conversationId: getConversationId(),
          });

          // Encode the message to storage format
          const encoded = formatAdapter.encode(item);
          // Parts may include AI SDK v5 control types (step-start, step-finish) that need filtering
          const encodedAny = encoded as unknown as {
            role: "user" | "assistant" | "system";
            parts: Array<{ type: string; text?: string }>;
            createdAt?: Date;
          };

          // Convert storage format back to ThreadMessage format
          // Storage has .parts, ThreadMessage expects .content
          // Convert all parts to text format (handles images as markdown, filters control types)
          const textParts = encodedAny.parts
            .map((part) =>
              convertPartToText(
                part as { type: string; text?: string; imageUrl?: string },
              ),
            )
            .filter((text) => text.length > 0)
            .map((text) => ({ type: "text" as const, text }));

          // Ensure at least one content part
          const content =
            textParts.length > 0
              ? textParts
              : [{ type: "text" as const, text: "" }];

          const threadMessage = fromThreadMessageLike(
            {
              id: formatAdapter.getId(item.message),
              role: encodedAny.role,
              content,
              ...(encodedAny.createdAt && {
                createdAt: encodedAny.createdAt,
              }),
            },
            formatAdapter.getId(item.message),
            { type: "complete", reason: "unknown" },
          );

          // Delegate to base adapter
          await adapter.append({
            parentId: item.parentId,
            message: threadMessage,
          });
        },
      };
    },
  };

  return adapter;
}
