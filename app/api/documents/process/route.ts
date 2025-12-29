import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getServerSession } from '@/lib/auth/server-session'
import { getCurrentUserAction } from '@/actions/db/get-current-user-action'
import { getObjectStream, documentExists } from '@/lib/aws/s3-client'
import { saveDocument, batchInsertDocumentChunks } from '@/lib/db/queries/documents'
import { extractTextFromDocument, chunkText, getFileTypeFromFileName } from '@/lib/document-processing'
import { createLogger, generateRequestId, startTimer } from '@/lib/logger'
import { withActionState, unauthorized } from '@/lib/api-utils'
import { handleError } from '@/lib/error-utils'
import { type ActionState } from '@/types/actions-types'
import { getMaxFileSize, formatFileSize } from '@/lib/file-validation'

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

  const userId = currentUser.data.user.id
  log.debug("Processing for user", { userId });

  return withActionState(async (): Promise<ActionState<ProcessDocumentResponse>> => {
    try {

    // Parse and validate request body
    const body = await request.json()
    const validation = ProcessDocumentRequestSchema.safeParse(body)

    if (!validation.success) {
      const errorMessage = validation.error.issues.map((e: { message: string }) => e.message).join(', ')
      log.warn("Validation error", { error: errorMessage });
      timer({ status: "error", reason: "validation_error" });
      return { isSuccess: false, message: errorMessage }
    }

    const { key, fileName, fileSize, conversationId } = validation.data

    // Verify file size is within limits
    const maxFileSize = await getMaxFileSize()
    if (fileSize > maxFileSize) {
      log.warn("File size exceeds limit", { fileSize, maxFileSize });
      timer({ status: "error", reason: "file_too_large" });
      return { 
        isSuccess: false, 
        message: `File size must be less than ${formatFileSize(maxFileSize)}` 
      }
    }

    // Verify the S3 key belongs to this user
    if (!key.startsWith(`${userId}/`)) {
      log.error("Unauthorized access attempt to S3 key", { key, userId });
      timer({ status: "error", reason: "unauthorized_access" });
      return { 
        isSuccess: false, 
        message: 'Unauthorized access to document' 
      }
    }

    // Verify document exists in S3
    const exists = await documentExists(key)
    if (!exists) {
      log.error("Document not found in S3", { key });
      timer({ status: "error", reason: "not_found" });
      return { 
        isSuccess: false, 
        message: 'Document not found' 
      }
    }

    log.debug("Retrieving document from S3", { key });

    // Get document stream from S3
    const { stream, metadata } = await getObjectStream(key)

    // Extract file type
    const fileType = getFileTypeFromFileName(fileName)
    log.debug("File type determined", { fileType });

    // Convert stream to buffer for processing
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const fileBuffer = Buffer.concat(chunks)
    log.debug("File retrieved from S3", { size: fileBuffer.length });

    // Process document content for text extraction
    log.debug("Extracting text from document");
    let text, extractedMetadata
    try {
      const extracted = await extractTextFromDocument(fileBuffer, fileType)
      text = extracted.text
      extractedMetadata = extracted.metadata
      log.debug("Text extracted", { textLength: text?.length ?? 0 });
    } catch (extractError) {
      log.error("Error extracting text", extractError);
      timer({ status: "error", reason: "extraction_failed" });
      return { 
        isSuccess: false, 
        message: `Failed to extract text from document: ${extractError instanceof Error ? extractError.message : String(extractError)}` 
      }
    }

    // Ensure text is not null or undefined
    if (!text) {
      log.error("No text content extracted from document");
      timer({ status: "error", reason: "no_text_content" });
      return { 
        isSuccess: false, 
        message: 'Failed to extract text content from document' 
      }
    }

    // Save document metadata to database
    log.debug("Saving document to database");
    let document
    try {
      document = await saveDocument({
        userId,
        conversationId: conversationId || null,
        name: fileName,
        type: fileType,
        size: fileSize,
        url: key, // Store S3 key
        metadata: {
          ...extractedMetadata,
          originalName: metadata?.originalName || fileName,
          uploadedAt: metadata?.uploadedAt || new Date().toISOString()
        }
      })
      log.info("Document saved to database", { documentId: document.id });
    } catch (saveError) {
      log.error("Error saving document", saveError);
      timer({ status: "error", reason: "db_save_failed" });
      return { 
        isSuccess: false, 
        message: `Failed to save document: ${saveError instanceof Error ? saveError.message : String(saveError)}` 
      }
    }

    // Chunk text and save to database
    log.debug("Chunking text");
    let textChunks: string[] = []
    try {
      textChunks = chunkText(text)
      log.debug("Chunks created", { count: textChunks.length });
      
      if (textChunks.length > 0) {
        const documentChunks = textChunks.map((chunk, index) => ({
          documentId: document.id,
          content: chunk,
          chunkIndex: index,
          metadata: { position: index }
        }))

        log.debug("Saving chunks to database");
        const savedChunks = await batchInsertDocumentChunks(documentChunks)
        log.info("Chunks saved", { count: savedChunks.length });
      } else {
        log.warn("No chunks created from document");
      }
    } catch (chunkError) {
      log.error("Error processing chunks", chunkError);
      // Note: We don't fail the whole operation if chunking fails
      // The document is already saved and can be re-processed later
    }

    // Return success response
    log.info("Document processed successfully", { 
      documentId: document.id, 
      chunks: textChunks.length 
    });
    timer({ status: "success", chunks: textChunks.length });
    
    return {
      isSuccess: true,
      message: 'Document processed successfully',
      data: {
        document: {
          id: document.id,
          name: document.name,
          type: document.type,
          size: document.size,
          url: document.url,
          totalChunks: textChunks.length
        }
      }
    }
    } catch (error) {
      timer({ status: "error" });
      log.error("Failed to process document", error);
      return handleError(error, 'Failed to process document')
    }
  })
}