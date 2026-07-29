import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getServerSession } from '@/lib/auth/server-session'
import { getCurrentUserAction } from '@/actions/db/get-current-user-action'
import { getObjectStream, documentExists } from '@/lib/aws/s3-client'
import { saveDocument, batchInsertDocumentChunks } from '@/lib/db/queries/documents'
import { getConversationById } from '@/lib/db/drizzle/nexus-conversations'
import { extractTextFromDocument, chunkText, getFileTypeFromFileName } from '@/lib/document-processing'
import { createLogger, generateRequestId, startTimer } from '@/lib/logger'
import { withActionState, unauthorized } from '@/lib/api-utils'
import { handleError } from '@/lib/error-utils'
import { type ActionState } from '@/types/actions-types'
import { getMaxFileSize, formatFileSize } from '@/lib/file-validation'
import { legacyContentRetirementResponse } from '@/lib/repositories/content-platform/legacy-retirement-response'

// Ensure this route is built for the Node.js runtime
export const runtime = "nodejs"


// Request validation schema
// Note: conversationId is a UUID string linking to nexus_conversations.id (Issue #549)
const ProcessDocumentRequestSchema = z.object({
  key: z.string().min(1),
  fileName: z.string().min(1).max(255),
  fileSize: z.number().positive(),
  conversationId: z.string().uuid().nullable().optional()
})

interface ProcessDocumentResponse {
  document: {
    id: number
    name: string
    type: string
    size: number
    url: string
    totalChunks: number
  }
}

type ProcessDocumentRequest = z.infer<typeof ProcessDocumentRequestSchema>
type ProcessLogger = ReturnType<typeof createLogger>
type ProcessTimer = ReturnType<typeof startTimer>
type ProcessFailure = { ok: false; state: ActionState<ProcessDocumentResponse> }

interface ProcessContext {
  userId: number
  log: ProcessLogger
  timer: ProcessTimer
}

async function validateProcessRequest(
  request: NextRequest,
  context: ProcessContext,
): Promise<{ ok: true; data: ProcessDocumentRequest } | ProcessFailure> {
  const validation = ProcessDocumentRequestSchema.safeParse(await request.json())
  if (!validation.success) {
    const message = validation.error.issues.map((issue) => issue.message).join(', ')
    context.log.warn("Validation error", { error: message })
    context.timer({ status: "error", reason: "validation_error" })
    return { ok: false, state: { isSuccess: false, message } }
  }

  const data = validation.data
  const maxFileSize = await getMaxFileSize()
  if (data.fileSize > maxFileSize) {
    context.log.warn("File size exceeds limit", {
      fileSize: data.fileSize,
      maxFileSize,
    })
    context.timer({ status: "error", reason: "file_too_large" })
    return {
      ok: false,
      state: {
        isSuccess: false,
        message: `File size must be less than ${formatFileSize(maxFileSize)}`,
      },
    }
  }
  if (!data.key.startsWith(`${context.userId}/`)) {
    context.log.error("Unauthorized access attempt to S3 key", {
      key: data.key,
      userId: context.userId,
    })
    context.timer({ status: "error", reason: "unauthorized_access" })
    return {
      ok: false,
      state: { isSuccess: false, message: "Unauthorized access to document" },
    }
  }
  if (!(await documentExists(data.key))) {
    context.log.error("Document not found in S3", { key: data.key })
    context.timer({ status: "error", reason: "not_found" })
    return {
      ok: false,
      state: { isSuccess: false, message: "Document not found" },
    }
  }
  if (data.conversationId) {
    const conversation = await getConversationById(
      data.conversationId,
      context.userId,
    )
    if (!conversation) {
      context.log.warn("Conversation not found or access denied", {
        conversationId: data.conversationId,
        userId: context.userId,
      })
      context.timer({ status: "error", reason: "conversation_not_found" })
      return {
        ok: false,
        state: { isSuccess: false, message: "Conversation not found" },
      }
    }
  }
  return { ok: true, data }
}

async function extractProcessDocument(
  request: ProcessDocumentRequest,
  context: ProcessContext,
) {
  context.log.debug("Retrieving document from S3", { key: request.key })
  const { stream, metadata } = await getObjectStream(request.key)
  const fileType = getFileTypeFromFileName(request.fileName)
  context.log.debug("File type determined", { fileType })

  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const fileBuffer = Buffer.concat(chunks)
  context.log.debug("File retrieved from S3", { size: fileBuffer.length })

  try {
    const extracted = await extractTextFromDocument(fileBuffer, fileType)
    context.log.debug("Text extracted", {
      textLength: extracted.text?.length ?? 0,
    })
    if (!extracted.text) {
      context.log.error("No text content extracted from document")
      context.timer({ status: "error", reason: "no_text_content" })
      return {
        ok: false as const,
        state: {
          isSuccess: false as const,
          message: "Failed to extract text content from document",
        },
      }
    }
    return {
      ok: true as const,
      fileType,
      text: extracted.text,
      extractedMetadata: extracted.metadata,
      objectMetadata: metadata,
    }
  } catch (error) {
    context.log.error("Error extracting text", error)
    context.timer({ status: "error", reason: "extraction_failed" })
    return {
      ok: false as const,
      state: {
        isSuccess: false as const,
        message: `Failed to extract text from document: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    }
  }
}

async function persistProcessedDocument(
  request: ProcessDocumentRequest,
  extracted: Awaited<ReturnType<typeof extractProcessDocument>> & { ok: true },
  context: ProcessContext,
): Promise<ActionState<ProcessDocumentResponse>> {
  context.log.debug("Saving document to database")
  let document
  try {
    document = await saveDocument({
      userId: context.userId,
      conversationId: request.conversationId || null,
      name: request.fileName,
      type: extracted.fileType,
      size: request.fileSize,
      url: request.key,
      metadata: {
        ...extracted.extractedMetadata,
        originalName: extracted.objectMetadata?.originalName || request.fileName,
        uploadedAt:
          extracted.objectMetadata?.uploadedAt || new Date().toISOString(),
      },
    })
    context.log.info("Document saved to database", { documentId: document.id })
  } catch (error) {
    context.log.error("Error saving document", error)
    context.timer({ status: "error", reason: "db_save_failed" })
    return {
      isSuccess: false,
      message: `Failed to save document: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }

  let textChunks: string[] = []
  try {
    textChunks = chunkText(extracted.text)
    context.log.debug("Chunks created", { count: textChunks.length })
    if (textChunks.length > 0) {
      const savedChunks = await batchInsertDocumentChunks(
        textChunks.map((content, chunkIndex) => ({
          documentId: document.id,
          content,
          chunkIndex,
          metadata: { position: chunkIndex },
        })),
      )
      context.log.info("Chunks saved", { count: savedChunks.length })
    } else {
      context.log.warn("No chunks created from document")
    }
  } catch (error) {
    context.log.error("Error processing chunks", error)
  }

  context.log.info("Document processed successfully", {
    documentId: document.id,
    chunks: textChunks.length,
  })
  context.timer({ status: "success", chunks: textChunks.length })
  return {
    isSuccess: true,
    message: "Document processed successfully",
    data: {
      document: {
        id: document.id,
        name: document.name,
        type: document.type,
        size: document.size,
        url: document.url,
        totalChunks: textChunks.length,
      },
    },
  }
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId();
  const timer = startTimer("api.documents.process");
  const log = createLogger({ requestId, route: "api.documents.process" });
  
  log.info("POST /api/documents/process - Processing document");

  // Check authentication
  const session = await getServerSession()
  if (!session) {
    log.warn("Unauthorized - No session");
    timer({ status: "error", reason: "unauthorized" });
    return unauthorized()
  }

  const currentUser = await getCurrentUserAction()
  if (!currentUser.isSuccess || !currentUser.data?.user) {
    log.warn("Unauthorized - User not found");
    timer({ status: "error", reason: "user_not_found" });
    return unauthorized('User not found')
  }
  const retired = await legacyContentRetirementResponse()
  if (retired) return retired

  const userId = currentUser.data.user.id
  log.debug("Processing for user", { userId });

  const context = { userId, log, timer }
  return withActionState(async (): Promise<ActionState<ProcessDocumentResponse>> => {
    try {
      const validation = await validateProcessRequest(request, context)
      if (!validation.ok) {
        return validation.state
      }
      const extracted = await extractProcessDocument(validation.data, context)
      if (!extracted.ok) {
        return extracted.state
      }
      return await persistProcessedDocument(validation.data, extracted, context)
    } catch (error) {
      timer({ status: "error" });
      log.error("Failed to process document", error);
      return handleError(error, 'Failed to process document')
    }
  })
}
