"use client"

import { useCallback, useMemo, useState } from "react"
import type { AttachmentAdapter } from "@assistant-ui/react"
import { toast } from "sonner"
import { createLogger } from "@/lib/client-logger"
import { UploadClassifiedError } from "@/lib/errors/upload-errors"
import type {
  AttachmentProcessingCallbacks,
  ChatAttachmentAdapterOptions,
} from "@/lib/attachments/chat-attachment-adapters"

const log = createLogger({ moduleName: "use-chat-attachments" })

/**
 * Stable closure-backed holder for the current conversation id. The attachment
 * adapter reads it lazily via `get`; the page's conversation callback updates
 * it synchronously via `set`. See docs/features/nexus-conversation-architecture.md
 * (Pitfall 4) for why the id must NOT be a memo dependency of the adapter.
 */
export interface ConversationIdAccessor {
  get: () => string | null
  set: (value: string | null) => void
}

function createConversationIdAccessor(
  initialValue: string | null
): ConversationIdAccessor {
  let value = initialValue
  return {
    get: () => value,
    set: (nextValue) => {
      value = nextValue
    },
  }
}

/** Module-level factory (e.g. `createEnhancedNexusAttachmentAdapter`) — must be stable. */
export type ChatAttachmentAdapterFactory = (
  callbacks: AttachmentProcessingCallbacks,
  options: ChatAttachmentAdapterOptions
) => AttachmentAdapter

function showAttachmentErrorToast(error: UploadClassifiedError | Error): void {
  if (error instanceof UploadClassifiedError && error.code === "UNAUTHORIZED") {
    toast.error("Session expired", {
      description: "Your session expired during file upload. Please sign in again.",
      duration: 8000,
      action: {
        label: "Sign in",
        onClick: () => {
          const callbackUrl = encodeURIComponent(
            window.location.pathname + window.location.search
          )
          window.location.href = `/api/auth/signin?callbackUrl=${callbackUrl}`
        },
      },
    })
    return
  }
  toast.error("File upload failed", {
    description: error instanceof UploadClassifiedError
      ? `Upload error: ${error.code.replace(/_/g, " ").toLowerCase()}.`
      : "The file could not be uploaded. Please try again.",
    duration: 6000,
  })
}

interface UseChatAttachmentsOptions {
  initialConversationId?: string | null
  purpose?: ChatAttachmentAdapterOptions["purpose"]
}

/**
 * Shared attachment wiring for every assistant-ui composer (Nexus, decision
 * capture, Assistant Architect): the memoized repository-backed adapter, the
 * processing-spinner and failed sets `Thread` renders, the upload-failure
 * toast, and the conversation-id accessor the adapter binds uploads to.
 */
export function useChatAttachments(
  createAdapter: ChatAttachmentAdapterFactory,
  { initialConversationId = null, purpose }: UseChatAttachmentsOptions = {}
): {
  attachmentAdapter: AttachmentAdapter
  conversationId: ConversationIdAccessor
  processingAttachments: Set<string>
  failedAttachments: Set<string>
} {
  const [processingAttachments, setProcessingAttachments] = useState<Set<string>>(
    () => new Set()
  )
  // A failed upload still resolves as a "complete" attachment (it carries a
  // safe error message for the model), so without this set the chip would show
  // "Ready" next to the failure toast.
  const [failedAttachments, setFailedAttachments] = useState<Set<string>>(
    () => new Set()
  )
  const [conversationId] = useState(() =>
    createConversationIdAccessor(initialConversationId)
  )

  const handleProcessingStart = useCallback((attachmentId: string) => {
    setProcessingAttachments(previous => new Set(previous).add(attachmentId))
    log.debug("Attachment processing started", { attachmentId })
  }, [])

  const handleProcessingComplete = useCallback((attachmentId: string) => {
    setProcessingAttachments(previous => {
      const next = new Set(previous)
      next.delete(attachmentId)
      return next
    })
    log.debug("Attachment processing completed", { attachmentId })
  }, [])

  const handleError = useCallback((
    attachmentId: string,
    error: UploadClassifiedError | Error
  ) => {
    log.warn("Attachment processing failed", {
      attachmentId,
      code: error instanceof UploadClassifiedError ? error.code : undefined,
      error: error.message,
    })
    setFailedAttachments(previous => new Set(previous).add(attachmentId))
    showAttachmentErrorToast(error)
  }, [])

  const attachmentAdapter = useMemo(() => createAdapter({
    onProcessingStart: handleProcessingStart,
    onProcessingComplete: handleProcessingComplete,
    onError: handleError,
  }, {
    repositoryBacked: true,
    getConversationId: conversationId.get,
    purpose,
  }), [
    createAdapter,
    conversationId,
    handleError,
    handleProcessingComplete,
    handleProcessingStart,
    purpose,
  ])

  return { attachmentAdapter, conversationId, processingAttachments, failedAttachments }
}
