import { NextRequest, NextResponse } from 'next/server';
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"

// NOTE: `export const config = { api: { bodyParser } }` was removed
// (REV-COR-213 / REV-SEC-126). That is a Pages-Router API config; App Router route
// handlers ignore it, so it enforced no size cap. The limit is now applied via an
// early Content-Length guard plus the authoritative post-parse `file.size` check.
import { z } from 'zod';
import { uploadDocument, deleteDocument } from '@/lib/aws/s3-client';
import { saveDocument, batchInsertDocumentChunks, deleteDocumentById } from '@/lib/db/queries/documents';
import { extractTextFromDocument, chunkText, getFileTypeFromFileName } from '@/lib/document-processing';
import { getServerSession } from '@/lib/auth/server-session';
import { getCurrentUserAction } from '@/actions/db/get-current-user-action';
// import * as fs from 'fs'; // No longer needed if text processing is out
// import * as path from 'path'; // No longer needed if text processing is out

import {
  ALLOWED_FILE_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  getMaxFileSize
} from '@/lib/file-validation';

// Multipart framing (boundary + part headers + filename) makes the request body
// slightly larger than the file itself, so the early Content-Length guard allows
// this much overhead above the max file size; `file.size` stays authoritative.
const UPLOAD_BODY_OVERHEAD_BYTES = 100 * 1024;

// Enhanced file validation schema
// Using z.any() since File/Blob classes are not available during SSR/build
const FileSchema = z.object({
  file: z.any()
    .refine((file) => {
      // Runtime check for file-like object
      return file && typeof file === 'object' && 'size' in file && 'name' in file && 'type' in file;
    }, {
      message: 'Invalid file object',
    })
    .refine((file) => {
      const fileName = file.name || '';
      const fileExtension = `.${fileName.split('.').pop()?.toLowerCase()}`;
      return ALLOWED_FILE_EXTENSIONS.includes(fileExtension as typeof ALLOWED_FILE_EXTENSIONS[number]);
    }, {
      message: `Unsupported file extension. Allowed file types are: ${ALLOWED_FILE_EXTENSIONS.join(', ')}`,
    })
    .refine((file) => {
      const mimeType = file.type;
      return ALLOWED_MIME_TYPES.includes(mimeType as typeof ALLOWED_MIME_TYPES[number]);
    }, {
      message: `Unsupported file type. Allowed MIME types are: ${ALLOWED_MIME_TYPES.join(', ')}`,
    })
});


// Ensure this route is built for the Node.js runtime so that Node-only   
// dependencies such as `pdf-parse` and `mammoth` (which rely on the FS   
// module and other Node APIs) work correctly. If this is omitted, Next.js   
// will attempt to bundle the route for the Edge runtime, leading to         
// unresolved module errors.                                                 
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const requestId = generateRequestId();
  const timer = startTimer("api.documents.upload");
  const log = createLogger({ requestId, route: "api.documents.upload" });
  
  log.info('[Upload API - Restore Step 1] Handler Entered');
  
  // Set response headers early to ensure proper content type
  const headers = {
    'Content-Type': 'application/json',
    'X-Request-Id': requestId,
  };
  
  // Check authentication first
  log.info('[Upload API] Attempting getServerSession...');
  const session = await getServerSession();
  log.info(`[Upload API] getServerSession completed. session exists: ${!!session}`);

  if (!session) {
    log.warn('Unauthorized - No session');
    timer({ status: "error", reason: "unauthorized" });
    return new NextResponse(
      JSON.stringify({ error: 'Unauthorized' }), 
      { status: 401, headers }
    );
  }
  
  const currentUser = await getCurrentUserAction();
  if (!currentUser.isSuccess || !currentUser.data?.user) {
    log.warn('Unauthorized - User not found');
    timer({ status: "error", reason: "user_not_found" });
    return new NextResponse(
      JSON.stringify({ error: 'User not found' }), 
      { status: 401, headers }
    );
  }
  
  const userId = currentUser.data.user.id;
  log.debug(`Current user ID: ${userId}, type: ${typeof userId}`);

  // Best-effort compensating cleanup (REV-COR-214). The upload proceeds in stages
  // (S3 object -> text extraction -> documents row -> chunks); a failure in a later
  // stage must not orphan the S3 object or a half-written documents row. These run
  // outside any DB transaction (S3 deletes are side effects) and never throw.
  const cleanupOrphanedS3 = async (key: string) => {
    try {
      await deleteDocument(key);
      log.info('[Upload API] Removed orphaned S3 object after failed upload', { key });
    } catch (cleanupError) {
      log.error('[Upload API] Failed to remove orphaned S3 object', cleanupError);
    }
  };
  const cleanupOrphanedDocument = async (id: number) => {
    try {
      await deleteDocumentById({ id });
      log.info('[Upload API] Removed orphaned document row after failed chunk insert', { id });
    } catch (cleanupError) {
      log.error('[Upload API] Failed to remove orphaned document row', cleanupError);
    }
  };

  try {
    log.info('[Upload API] Inside main try block');
    // --- Original logic commented out for now ---
    /*
    // Ensure documents bucket exists
    // ... 
    // Parse form data
    // ...
    // Validate file
    // ...
    // Extract text
    // ...
    // Upload to storage
    // ...
    // Save metadata
    // ...
    // Chunk and save
    // ...
    */
    
    
    // Enforce the upload size limit BEFORE buffering the whole body into memory
    // (REV-COR-213 / REV-SEC-126). Reject on Content-Length here; the authoritative
    // per-file `file.size > maxFileSize` check below still runs post-parse. The
    // Content-Length header can be spoofed/absent, so this is a coarse pre-buffer
    // guard, not the source of truth.
    const maxFileSize = await getMaxFileSize();
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > maxFileSize + UPLOAD_BODY_OVERHEAD_BYTES) {
      log.warn('Upload rejected by Content-Length guard', { contentLength, maxFileSize });
      timer({ status: "error", reason: "file_too_large" });
      return new NextResponse(
        JSON.stringify({
          success: false,
          error: `File size must be less than ${maxFileSize / (1024 * 1024)}MB`
        }),
        { status: 413, headers }
      );
    }

    // Parse the form data
    let formData;
    try {
      formData = await request.formData();
      log.info('[Upload API] Form data parsed');
    } catch (formError) {
      log.error('[Upload API] Step failed: Parsing Form Data', formError);
      timer({ status: "error", reason: "form_parse_error" });
      return new NextResponse(
        JSON.stringify({ 
          success: false,
          error: 'Invalid form data' 
        }), 
        { status: 400, headers }
      );
    }
    
    const file = formData.get('file') as File;
    
    log.info('Form data received:', {
      fileName: file?.name,
      fileSize: file?.size
    });
    
    if (!file) {
      log.warn('No file uploaded in form data');
      timer({ status: "error", reason: "no_file" });
      return new NextResponse(
        JSON.stringify({ success: false, error: 'No file uploaded' }), 
        { status: 400, headers }
      );
    }
    
    // Validate file type with a comprehensive approach
    // 1. Check file extension
    const fileExtension = `.${file.name.split('.').pop()?.toLowerCase()}`;
    if (!ALLOWED_FILE_EXTENSIONS.includes(fileExtension as typeof ALLOWED_FILE_EXTENSIONS[number])) {
      log.warn('Unsupported file extension:', fileExtension);
      timer({ status: "error", reason: "invalid_extension" });
      return new NextResponse(
        JSON.stringify({ 
          success: false,
          error: `Unsupported file extension. Allowed file types are: ${ALLOWED_FILE_EXTENSIONS.join(', ')}` 
        }), 
        { status: 400, headers }
      );
    }
    
    // 2. Check MIME type for additional security
    if (!ALLOWED_MIME_TYPES.includes(file.type as typeof ALLOWED_MIME_TYPES[number])) {
      log.warn('Unsupported MIME type:', file.type);
      timer({ status: "error", reason: "invalid_mime" });
      return new NextResponse(
        JSON.stringify({ 
          success: false,
          error: `Unsupported MIME type. Allowed MIME types are: ${ALLOWED_MIME_TYPES.join(', ')}` 
        }), 
        { status: 400, headers }
      );
    }
    
    // 3. Check file size (authoritative — maxFileSize resolved before the guard above)
    if (file.size > maxFileSize) {
      log.warn('File too large:', file.size, 'Max:', maxFileSize);
      timer({ status: "error", reason: "file_too_large" });
      return new NextResponse(
        JSON.stringify({ 
          success: false,
          error: `File size must be less than ${maxFileSize / (1024 * 1024)}MB` 
        }), 
        { status: 400, headers }
      );
    }

    const validatedFile = FileSchema.safeParse({ file });
    if (!validatedFile.success) {
      const errorMessage = validatedFile.error.issues.map((error: { message: string }) => error.message).join(', ');
      log.warn('File validation error:', errorMessage);
      timer({ status: "error", reason: "validation_error" });
      return new NextResponse(
        JSON.stringify({ 
          success: false,
          error: errorMessage 
        }), 
        { status: 400, headers }
      );
    }

    // Extract file type from file name
    const fileType = getFileTypeFromFileName(file.name);
    log.debug(`File type (using file name): ${fileType}`);
    
    // Convert File to Buffer for processing (still needed for storage and non-PDF extraction)
    let fileBuffer: Buffer;
    try {
      fileBuffer = Buffer.from(await file.arrayBuffer());
      log.info(`File converted to buffer, size: ${fileBuffer.length}`);
    } catch (bufferError) {
      log.error('[Upload API] Step failed: Converting to Buffer', bufferError);
      timer({ status: "error", reason: "buffer_conversion_error" });
      return new NextResponse(
        JSON.stringify({ 
          success: false,
          error: 'Error processing file' 
        }), 
        { status: 500, headers }
      );
    }

    // Sanitize file name to prevent path traversal
    const sanitizedFileName = file.name.replace(/[^\w.-]/g, '_');
    
    
    // Upload file to AWS S3
    log.info('Uploading to AWS S3...');
    let uploadResult;
    try {
      uploadResult = await uploadDocument({
        userId: String(userId),
        fileName: sanitizedFileName,
        fileContent: fileBuffer,
        contentType: file.type,
        metadata: {
          originalName: file.name,
          uploadedBy: String(userId),
        }
      });
      log.info('File uploaded successfully to S3:', uploadResult);
    } catch (uploadError) {
      log.error('[Upload API] Step failed: Uploading to S3', uploadError);
      timer({ status: "error", reason: "s3_upload_error" });
      return new NextResponse(
        JSON.stringify({ 
          success: false,
          error: `Failed to upload file to storage: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}` 
        }), 
        { status: 500, headers }
      );
    }

    const fileUrl = uploadResult.url;
    const s3Key = uploadResult.key;
    log.debug(`S3 key: ${s3Key}`);
    log.debug(`Signed URL: ${fileUrl}`);

    // Process document content for text extraction
    log.info('Extracting text from document...');
    let text, metadata;
    try {
      // Use server-side extraction for all supported types
      const extracted = await extractTextFromDocument(fileBuffer, fileType);
      text = extracted.text;
      metadata = extracted.metadata;
      log.info(`Text extracted, length: ${text?.length ?? 0}`);
    } catch (extractError) {
      log.error('[Upload API] Step failed: Text Extraction', extractError);
      log.error('Error extracting text from document:', extractError);
      timer({ status: "error", reason: "text_extraction_error" });
      // REV-COR-214: the S3 object was already uploaded — remove it so it is not orphaned.
      await cleanupOrphanedS3(s3Key);
      return new NextResponse(
        JSON.stringify({
          success: false,
          error: `Failed to extract text from document: ${extractError instanceof Error ? extractError.message : String(extractError)}`
        }),
        { status: 500, headers }
      );
    }

    // Ensure text is not null or undefined before proceeding
    if (text === null || text === undefined) {
      log.error('[Upload API] Text extraction resulted in null or undefined text.');
      timer({ status: "error", reason: "no_text_extracted" });
      // REV-COR-214: no usable text — remove the already-uploaded S3 object.
      await cleanupOrphanedS3(s3Key);
      return new NextResponse(
        JSON.stringify({
          success: false,
          error: 'Failed to extract valid text content from the document.'
        }),
        { status: 500, headers }
      );
    }

    // Save document metadata to database
    log.info('Saving document to database...');
    let document;
    try {
      document = await saveDocument({
        userId,
        conversationId: null, // Save with null conversationId initially
        name: sanitizedFileName, // Use the sanitized name
        type: fileType,
        size: file.size,
        url: s3Key, // Store S3 key, we'll generate signed URLs on demand
        metadata: metadata || {}, // Ensure metadata is not undefined
      });
      log.info(`Document saved to database: ${document.id}`);
    } catch (saveError) {
      log.error('[Upload API] Step failed: Saving Document Metadata', saveError);
      log.error('Error saving document to database:', saveError);
      timer({ status: "error", reason: "db_save_error" });
      // REV-COR-214: the documents row failed to persist, so only the S3 object
      // needs removing to avoid an orphan.
      await cleanupOrphanedS3(s3Key);
      return new NextResponse(
        JSON.stringify({
          success: false,
          error: `Failed to save document to database: ${saveError instanceof Error ? saveError.message : String(saveError)}`
        }),
        { status: 500, headers }
      );
    }

    // Chunk text and save to database
    log.info('Chunking text...');
    let chunks;
    try {
      chunks = chunkText(text);
      log.info(`Created ${chunks.length} chunks`);
      
      if (chunks.length === 0) {
        log.warn('[Upload API] Chunking resulted in 0 chunks. Document might be empty or processing failed silently.');
        // Proceed to save document metadata but skip saving chunks
      } else {
        const documentChunks = chunks.map((chunk, index) => ({
          documentId: document.id,
          content: chunk,
          chunkIndex: index,
          metadata: { position: index }, // Simple metadata for chunk
        }));

        log.info('Saving chunks to database...');
        const savedChunks = await batchInsertDocumentChunks(documentChunks);
        log.info(`Saved ${savedChunks.length} chunks to database`);
      }
    } catch (chunkError) {
      log.error('[Upload API] Step failed: Chunking/Saving Chunks', chunkError);
      log.error('Error processing or saving chunks:', chunkError);
      timer({ status: "error", reason: "chunk_processing_error" });
      // REV-COR-214: both the documents row and the S3 object are now orphaned
      // (the row exists but has no/partial chunks, so it would appear in the user's
      // list yet return nothing on retrieval). Roll both back — document row first,
      // then the S3 object.
      await cleanupOrphanedDocument(document.id);
      await cleanupOrphanedS3(s3Key);
      return new NextResponse(
        JSON.stringify({
          success: false,
          error: `Failed to process or save document chunks: ${chunkError instanceof Error ? chunkError.message : String(chunkError)}`
        }),
        { status: 500, headers }
      );
    }

    // Verification happens when linked via chat API

    // Return the correct, full response object
    log.info('Document uploaded successfully', { 
      documentId: document.id, 
      chunks: chunks?.length ?? 0 
    });
    timer({ status: "success" });
    
    return new NextResponse(
      JSON.stringify({
        success: true,
        document: {
          id: document.id,
          name: document.name,
          type: document.type,
          size: document.size,
          url: document.url,
          totalChunks: chunks?.length ?? 0,
        }
      }), 
      { status: 200, headers }
    );
      
  } catch (error) {
    timer({ status: "error" });
    log.error('[Upload API] General Error in POST handler (Restore Step 1):', error);
    log.error('Detailed Error:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
    return new NextResponse(
      JSON.stringify({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Failed during restore step 1' 
      }),
      { status: 500, headers }
    );
  }
}

// All previous code removed for this basic test 