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
import { legacyContentRetirementResponse } from '@/lib/repositories/content-platform/legacy-retirement-response';

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

type UploadLogger = ReturnType<typeof createLogger>;
type UploadTimer = ReturnType<typeof startTimer>;
type UploadHeaders = Record<string, string>;

interface UploadContext {
  userId: number;
  headers: UploadHeaders;
  log: UploadLogger;
  timer: UploadTimer;
}

function uploadResponse(
  body: object,
  status: number,
  headers: UploadHeaders,
): NextResponse {
  return new NextResponse(JSON.stringify(body), { status, headers });
}

async function cleanupOrphanedS3(key: string, log: UploadLogger): Promise<void> {
  try {
    await deleteDocument(key);
    log.info('[Upload API] Removed orphaned S3 object after failed upload', { key });
  } catch (error) {
    log.error('[Upload API] Failed to remove orphaned S3 object', error);
  }
}

async function cleanupOrphanedDocument(
  id: number,
  log: UploadLogger,
): Promise<void> {
  try {
    await deleteDocumentById({ id });
    log.info('[Upload API] Removed orphaned document row after failed chunk insert', { id });
  } catch (error) {
    log.error('[Upload API] Failed to remove orphaned document row', error);
  }
}

async function prepareUpload(
  request: NextRequest,
  context: UploadContext,
) {
  const maxFileSize = await getMaxFileSize();
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (
    Number.isFinite(contentLength) &&
    contentLength > maxFileSize + UPLOAD_BODY_OVERHEAD_BYTES
  ) {
    context.log.warn('Upload rejected by Content-Length guard', {
      contentLength,
      maxFileSize,
    });
    context.timer({ status: "error", reason: "file_too_large" });
    return {
      ok: false as const,
      response: uploadResponse(
        {
          success: false,
          error: `File size must be less than ${maxFileSize / (1024 * 1024)}MB`,
        },
        413,
        context.headers,
      ),
    };
  }

  let formData: FormData;
  try {
    formData = await request.formData();
    context.log.info('[Upload API] Form data parsed');
  } catch (error) {
    context.log.error('[Upload API] Step failed: Parsing Form Data', error);
    context.timer({ status: "error", reason: "form_parse_error" });
    return {
      ok: false as const,
      response: uploadResponse(
        { success: false, error: 'Invalid form data' },
        400,
        context.headers,
      ),
    };
  }

  const file = formData.get('file') as File | null;
  context.log.info('Form data received:', {
    fileName: file?.name,
    fileSize: file?.size,
  });
  if (!file) {
    context.log.warn('No file uploaded in form data');
    context.timer({ status: "error", reason: "no_file" });
    return {
      ok: false as const,
      response: uploadResponse(
        { success: false, error: 'No file uploaded' },
        400,
        context.headers,
      ),
    };
  }

  const extension = `.${file.name.split('.').pop()?.toLowerCase()}`;
  if (!ALLOWED_FILE_EXTENSIONS.includes(
    extension as (typeof ALLOWED_FILE_EXTENSIONS)[number],
  )) {
    context.log.warn('Unsupported file extension:', extension);
    context.timer({ status: "error", reason: "invalid_extension" });
    return {
      ok: false as const,
      response: uploadResponse(
        {
          success: false,
          error: `Unsupported file extension. Allowed file types are: ${ALLOWED_FILE_EXTENSIONS.join(', ')}`,
        },
        400,
        context.headers,
      ),
    };
  }
  if (!ALLOWED_MIME_TYPES.includes(
    file.type as (typeof ALLOWED_MIME_TYPES)[number],
  )) {
    context.log.warn('Unsupported MIME type:', file.type);
    context.timer({ status: "error", reason: "invalid_mime" });
    return {
      ok: false as const,
      response: uploadResponse(
        {
          success: false,
          error: `Unsupported MIME type. Allowed MIME types are: ${ALLOWED_MIME_TYPES.join(', ')}`,
        },
        400,
        context.headers,
      ),
    };
  }
  if (file.size > maxFileSize) {
    context.log.warn('File too large:', file.size, 'Max:', maxFileSize);
    context.timer({ status: "error", reason: "file_too_large" });
    return {
      ok: false as const,
      response: uploadResponse(
        {
          success: false,
          error: `File size must be less than ${maxFileSize / (1024 * 1024)}MB`,
        },
        400,
        context.headers,
      ),
    };
  }

  const validation = FileSchema.safeParse({ file });
  if (!validation.success) {
    const message = validation.error.issues.map((issue) => issue.message).join(', ');
    context.log.warn('File validation error:', message);
    context.timer({ status: "error", reason: "validation_error" });
    return {
      ok: false as const,
      response: uploadResponse(
        { success: false, error: message },
        400,
        context.headers,
      ),
    };
  }

  try {
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    context.log.info(`File converted to buffer, size: ${fileBuffer.length}`);
    return {
      ok: true as const,
      file,
      fileBuffer,
      fileType: getFileTypeFromFileName(file.name),
      sanitizedFileName: file.name.replace(/[^\w.-]/g, '_'),
    };
  } catch (error) {
    context.log.error('[Upload API] Step failed: Converting to Buffer', error);
    context.timer({ status: "error", reason: "buffer_conversion_error" });
    return {
      ok: false as const,
      response: uploadResponse(
        { success: false, error: 'Error processing file' },
        500,
        context.headers,
      ),
    };
  }
}

type PreparedUpload = Awaited<ReturnType<typeof prepareUpload>> & { ok: true };

async function storeAndExtractUpload(
  prepared: PreparedUpload,
  context: UploadContext,
) {
  context.log.info('Uploading to AWS S3...');
  let uploadResult;
  try {
    uploadResult = await uploadDocument({
      userId: String(context.userId),
      fileName: prepared.sanitizedFileName,
      fileContent: prepared.fileBuffer,
      contentType: prepared.file.type,
      metadata: {
        originalName: prepared.file.name,
        uploadedBy: String(context.userId),
      },
    });
    context.log.info('File uploaded successfully to S3:', uploadResult);
  } catch (error) {
    context.log.error('[Upload API] Step failed: Uploading to S3', error);
    context.timer({ status: "error", reason: "s3_upload_error" });
    return {
      ok: false as const,
      response: uploadResponse(
        { success: false, error: 'Failed to upload file to storage' },
        500,
        context.headers,
      ),
    };
  }

  const s3Key = uploadResult.key;
  context.log.debug(`S3 key: ${s3Key}`);
  context.log.debug(`Signed URL: ${uploadResult.url}`);
  try {
    const extracted = await extractTextFromDocument(
      prepared.fileBuffer,
      prepared.fileType,
    );
    context.log.info(`Text extracted, length: ${extracted.text?.length ?? 0}`);
    if (extracted.text === null || extracted.text === undefined) {
      context.log.error(
        '[Upload API] Text extraction resulted in null or undefined text.',
      );
      context.timer({ status: "error", reason: "no_text_extracted" });
      await cleanupOrphanedS3(s3Key, context.log);
      return {
        ok: false as const,
        response: uploadResponse(
          {
            success: false,
            error: 'Failed to extract valid text content from the document.',
          },
          500,
          context.headers,
        ),
      };
    }
    return {
      ok: true as const,
      s3Key,
      text: extracted.text,
      metadata: extracted.metadata,
    };
  } catch (error) {
    context.log.error('[Upload API] Step failed: Text Extraction', error);
    context.log.error('Error extracting text from document:', error);
    context.timer({ status: "error", reason: "text_extraction_error" });
    await cleanupOrphanedS3(s3Key, context.log);
    return {
      ok: false as const,
      response: uploadResponse(
        { success: false, error: 'Failed to extract text from document' },
        500,
        context.headers,
      ),
    };
  }
}

type ExtractedUpload = Awaited<ReturnType<typeof storeAndExtractUpload>> & {
  ok: true;
};

async function persistUpload(
  prepared: PreparedUpload,
  extracted: ExtractedUpload,
  context: UploadContext,
): Promise<NextResponse> {
  context.log.info('Saving document to database...');
  let document;
  try {
    document = await saveDocument({
      userId: context.userId,
      conversationId: null,
      name: prepared.sanitizedFileName,
      type: prepared.fileType,
      size: prepared.file.size,
      url: extracted.s3Key,
      metadata: extracted.metadata || {},
    });
    context.log.info(`Document saved to database: ${document.id}`);
  } catch (error) {
    context.log.error('[Upload API] Step failed: Saving Document Metadata', error);
    context.log.error('Error saving document to database:', error);
    context.timer({ status: "error", reason: "db_save_error" });
    await cleanupOrphanedS3(extracted.s3Key, context.log);
    return uploadResponse(
      { success: false, error: 'Failed to save document to database' },
      500,
      context.headers,
    );
  }

  let chunks: string[];
  try {
    chunks = chunkText(extracted.text);
    context.log.info(`Created ${chunks.length} chunks`);
    if (chunks.length === 0) {
      context.log.warn(
        '[Upload API] Chunking resulted in 0 chunks. Document might be empty or processing failed silently.',
      );
    } else {
      const savedChunks = await batchInsertDocumentChunks(
        chunks.map((content, chunkIndex) => ({
          documentId: document.id,
          content,
          chunkIndex,
          metadata: { position: chunkIndex },
        })),
      );
      context.log.info(`Saved ${savedChunks.length} chunks to database`);
    }
  } catch (error) {
    context.log.error('[Upload API] Step failed: Chunking/Saving Chunks', error);
    context.log.error('Error processing or saving chunks:', error);
    context.timer({ status: "error", reason: "chunk_processing_error" });
    await cleanupOrphanedDocument(document.id, context.log);
    await cleanupOrphanedS3(extracted.s3Key, context.log);
    return uploadResponse(
      { success: false, error: 'Failed to process or save document chunks' },
      500,
      context.headers,
    );
  }

  context.log.info('Document uploaded successfully', {
    documentId: document.id,
    chunks: chunks.length,
  });
  context.timer({ status: "success" });
  return uploadResponse(
    {
      success: true,
      document: {
        id: document.id,
        name: document.name,
        type: document.type,
        size: document.size,
        url: document.url,
        totalChunks: chunks.length,
      },
    },
    200,
    context.headers,
  );
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId();
  const timer = startTimer("api.documents.upload");
  const log = createLogger({ requestId, route: "api.documents.upload" });
  const headers = {
    'Content-Type': 'application/json',
    'X-Request-Id': requestId,
  };

  log.info('[Upload API] Handler entered');
  const session = await getServerSession();
  log.info('[Upload API] Session lookup completed', {
    sessionExists: Boolean(session),
  });
  if (!session) {
    log.warn('Unauthorized - No session');
    timer({ status: "error", reason: "unauthorized" });
    return uploadResponse({ error: 'Unauthorized' }, 401, headers);
  }

  const currentUser = await getCurrentUserAction();
  if (!currentUser.isSuccess || !currentUser.data?.user) {
    log.warn('Unauthorized - User not found');
    timer({ status: "error", reason: "user_not_found" });
    return uploadResponse({ error: 'User not found' }, 401, headers);
  }
  const retired = await legacyContentRetirementResponse();
  if (retired) return retired;

  const context: UploadContext = {
    userId: currentUser.data.user.id,
    headers,
    log,
    timer,
  };
  log.debug('Current user resolved', { userId: context.userId });

  try {
    const prepared = await prepareUpload(request, context);
    if (!prepared.ok) {
      return prepared.response;
    }
    const extracted = await storeAndExtractUpload(prepared, context);
    if (!extracted.ok) {
      return extracted.response;
    }
    return await persistUpload(prepared, extracted, context);
  } catch (error) {
    timer({ status: "error" });
    log.error('[Upload API] Unhandled POST failure', error);
    return uploadResponse(
      { success: false, error: 'Failed to upload document' },
      500,
      headers,
    );
  }
}
