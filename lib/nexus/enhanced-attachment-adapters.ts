import {
  AttachmentAdapter,
  PendingAttachment,
  CompleteAttachment,
  CompositeAttachmentAdapter,
  SimpleImageAttachmentAdapter,
  SimpleTextAttachmentAdapter,
} from "@assistant-ui/react";
import { createLogger } from "@/lib/client-logger";
import { generateUUID } from "@/lib/utils/uuid";
import { UploadClassifiedError, type UploadErrorCode } from "@/lib/errors/upload-errors";

const log = createLogger({ moduleName: 'enhanced-attachment-adapters' });

export interface AttachmentProcessingCallbacks {
  onProcessingStart?: (attachmentId: string) => void;
  onProcessingComplete?: (attachmentId: string) => void;
}

/**
 * Document Adapter that processes all supported document formats
 * through server-side processing for consistent extraction quality
 */
export class HybridDocumentAdapter implements AttachmentAdapter {
  accept = "application/pdf,.docx,.xlsx,.pptx,.doc,.xls,.ppt,.txt,.md,.csv,.json,.xml,.yaml,.yml";

  // Supported text-based file extensions (files without magic bytes)
  private static readonly TEXT_BASED_EXTENSIONS = ['csv', 'txt', 'md', 'json', 'xml', 'yaml', 'yml'] as const;

  // Explicitly allowed MIME types for text-based files
  // Note: MIME types can be spoofed, but server-side processing provides
  // additional validation. For text files, this dual-check (extension + MIME)
  // provides reasonable security without the overhead of content inspection.
  private static readonly VALID_TEXT_MIME_TYPES = [
    'text/csv',
    'application/csv',  // Some systems send CSV as application/csv
    'text/plain',
    'text/markdown',
    'application/json',
    'application/xml',
    'text/xml',
    'application/x-yaml',
    'text/yaml'
  ] as const;

  // Code-based lookup: preferred when server error `code` is available.
  // Only these controlled strings are embedded in LLM prompts (prompt injection defense).
  private static readonly CODE_TO_SAFE_MESSAGE: Partial<Record<UploadErrorCode, string>> = {
    STORAGE_UNAVAILABLE: 'Storage service temporarily unavailable.',
    UPLOAD_TIMEOUT: 'Upload timed out.',
    INVALID_FORMAT: 'Invalid file format.',
    FILE_TOO_LARGE: 'File size exceeds the allowed limit.',
    JOB_SERVICE_UNAVAILABLE: 'Document processing service temporarily unavailable.',
    QUEUE_UNAVAILABLE: 'Processing queue temporarily unavailable.',
    CONFIG_ERROR: 'Service configuration error.',
    UPLOAD_FAILED: 'Upload failed.',
    UNAUTHORIZED: 'Authentication required.',
    NO_FILE: 'No file provided.',
    VALIDATION_ERROR: 'Invalid request data.',
  };

  // Fallback string matching for errors without a code (network errors, polling
  // failures, ALB gateway errors). Only used when CODE_TO_SAFE_MESSAGE has no match.
  private static readonly SAFE_ERROR_MAP: Array<{ pattern: string; message: string }> = [
    { pattern: 'upload service temporarily unavailable', message: 'Upload service temporarily unavailable.' },
    { pattern: 'processing service temporarily unavailable', message: 'Processing service temporarily unavailable.' },
    { pattern: 'processing timeout', message: 'Processing timed out.' },
    { pattern: 'network error during upload', message: 'Network error during upload.' },
    { pattern: 'failed to check processing status', message: 'Could not check processing status.' },
    // Intentionally broad catch-all for server-side failures. New error categories
    // that deserve their own message should be added as specific entries above this one.
    { pattern: 'server processing failed', message: 'Server processing failed.' },
  ];

  static toSafeErrorMessage(rawMessage: string, code?: UploadErrorCode): string {
    // Prefer code-based lookup — no string coupling with server messages
    if (code && code in HybridDocumentAdapter.CODE_TO_SAFE_MESSAGE) {
      return HybridDocumentAdapter.CODE_TO_SAFE_MESSAGE[code]!;
    }

    // Fallback to pattern matching for non-code errors (network, polling, ALB)
    const lower = rawMessage.toLowerCase();
    for (const { pattern, message } of HybridDocumentAdapter.SAFE_ERROR_MAP) {
      if (lower.includes(pattern)) return message;
    }
    return 'An unexpected error occurred during processing.';
  }

  private processedCache = new Map<string, CompleteAttachment>();
  private processingPromises = new Map<string, Promise<CompleteAttachment>>();
  private callbacks?: AttachmentProcessingCallbacks;

  constructor(callbacks?: AttachmentProcessingCallbacks) {
    this.callbacks = callbacks;
  }

  async add({ file }: { file: File }): Promise<PendingAttachment> {
    // Validate file size (500MB max for server processing)
    const maxSize = 500 * 1024 * 1024;
    if (file.size > maxSize) {
      throw new Error(`File size exceeds 500MB limit`);
    }

    // Validate file type using magic bytes
    const isValid = await this.validateFileType(file);
    if (!isValid) {
      throw new Error(`Invalid file format`);
    }

    const attachment: PendingAttachment = {
      id: generateUUID(),
      type: "document",
      name: this.sanitizeFileName(file.name),
      contentType: file.type,
      file,
      status: { 
        type: "running",
        reason: "uploading",
        progress: 0
      },
    };

    // Start background processing immediately
    if (this.callbacks?.onProcessingStart) {
      this.callbacks.onProcessingStart(attachment.id);
      
      // Start processing in background and cache the result
      const processingPromise = this.processServerSide(attachment)
        .then(result => {
          this.processedCache.set(attachment.id, result);
          this.processingPromises.delete(attachment.id);
          if (this.callbacks?.onProcessingComplete) {
            this.callbacks.onProcessingComplete(attachment.id);
          }
          log.info('Background processing completed', { attachmentId: attachment.id, fileName: attachment.name });
          return result;
        })
        .catch(error => {
          this.processingPromises.delete(attachment.id);
          if (this.callbacks?.onProcessingComplete) {
            this.callbacks.onProcessingComplete(attachment.id);
          }
          log.error('Background processing failed', {
            attachmentId: attachment.id,
            fileName: attachment.name,
            error: error instanceof Error ? error.message : String(error),
            errorName: error instanceof Error ? error.name : undefined,
          });
          throw error;
        });

      this.processingPromises.set(attachment.id, processingPromise);
      log.info('Started background processing', { attachmentId: attachment.id, fileName: attachment.name });
    }

    return attachment;
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    // Check if we have a cached result from background processing
    const cached = this.processedCache.get(attachment.id);
    if (cached) {
      this.processedCache.delete(attachment.id);
      log.info('Using cached processing result', { attachmentId: attachment.id, fileName: attachment.name });
      return cached;
    }

    // Check if background processing is still in progress
    const processingPromise = this.processingPromises.get(attachment.id);
    if (processingPromise) {
      log.info('Waiting for background processing to complete', { attachmentId: attachment.id, fileName: attachment.name });
      const result = await processingPromise;
      this.processedCache.delete(attachment.id); // Clean up cache after use
      return result;
    }

    // Fallback: Process normally if no background processing was initiated
    log.info('Processing attachment synchronously (fallback)', { attachmentId: attachment.id, fileName: attachment.name });
    return this.processServerSide(attachment);
  }


  private async processServerSide(attachment: PendingAttachment): Promise<CompleteAttachment> {
    try {
      log.info('Processing document server-side', {
        fileName: attachment.name,
        fileSize: attachment.file.size
      });

      // Use server-side upload to bypass school network restrictions on S3 presigned URLs
      // See: https://github.com/psd401/aistudio/issues/632
      const uploadResult = await this.uploadViaServer(attachment);

      // Poll for processing results
      const processedContent = await this.pollForResults(uploadResult.jobId, attachment.name);
      
      // Step 5: Return in assistant-ui format
      return {
        id: attachment.id,
        type: "document",
        name: attachment.name,
        contentType: attachment.contentType,
        file: attachment.file,
        content: processedContent,
        status: { type: "complete" },
      };
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const errorCode: UploadErrorCode | undefined = error instanceof UploadClassifiedError ? error.code : undefined;
      log.error('Server-side processing failed', {
        attachmentId: attachment.id,
        fileName: attachment.name,
        error: rawMessage,
        code: errorCode,
        errorName: error instanceof Error ? error.name : undefined,
      });

      // Map known error codes/messages to safe canned text for AI model context.
      // Only controlled strings reach the LLM — unknown errors get a generic
      // message to prevent indirect prompt injection (OWASP LLM Top 10).
      const safeMessage = HybridDocumentAdapter.toSafeErrorMessage(rawMessage, errorCode);

      return {
        id: attachment.id,
        type: "document",
        name: attachment.name,
        contentType: attachment.contentType,
        file: attachment.file,
        content: [{
          type: "text" as const,
          text: `## Document: ${attachment.name}

*Processing failed: ${safeMessage}*

**Size:** ${Math.round(attachment.file.size / 1024)}KB

Please try re-uploading. If the issue persists, contact support.`
        }],
        status: {
          type: "complete"
        },
      };
    }
  }

  /**
   * Upload file via server-side endpoint to bypass school network restrictions.
   * School networks block direct S3 presigned URL uploads, but allow uploads
   * to aistudio.psd401.ai domain which then proxies to S3.
   *
   * @see https://github.com/psd401/aistudio/issues/632
   */
  private async uploadViaServer(attachment: PendingAttachment): Promise<{ jobId: string }> {
    const formData = new FormData();
    formData.append('file', attachment.file);
    formData.append('purpose', 'chat');
    formData.append('processingOptions', JSON.stringify({
      extractText: true,
      convertToMarkdown: true,
      extractImages: false, // Disable for chat to reduce processing time
      ocrEnabled: true
    }));

    let response: Response;
    try {
      response = await fetch('/api/documents/v2/upload', {
        method: 'POST',
        body: formData, // No Content-Type header - browser sets it with boundary
      });
    } catch (networkError) {
      log.error('Upload network error', {
        attachmentId: attachment.id,
        fileName: attachment.name,
        error: networkError instanceof Error ? networkError.message : String(networkError),
      });
      throw new Error('Network error during upload - check your connection and try again');
    }

    if (!response.ok) {
      // Try to parse JSON error from our API. If it fails (e.g. ALB 502/503
      // returning HTML), include the HTTP status for diagnostics.
      const errorData: { error?: string; code?: string; requestId?: string } | null =
        await response.json().catch(() => null);

      if (errorData?.error) {
        log.error('Upload server error', {
          attachmentId: attachment.id,
          fileName: attachment.name,
          status: response.status,
          code: errorData.code,
          error: errorData.error,
          requestId: errorData.requestId,
        });
        throw new UploadClassifiedError(
          (errorData.code ?? 'UPLOAD_FAILED') as UploadErrorCode,
          errorData.error,
          response.status
        );
      }

      // Non-JSON response — likely ALB 502/503 or infrastructure error
      log.error('Upload failed with non-JSON response', {
        attachmentId: attachment.id,
        fileName: attachment.name,
        status: response.status,
        statusText: response.statusText,
      });
      throw new Error(
        response.status === 502 || response.status === 503
          ? 'Upload service temporarily unavailable - please try again in a moment'
          : `Upload failed (HTTP ${response.status}) - please try again`
      );
    }

    const result = await response.json();

    if (!result.jobId) {
      throw new Error('Server upload response missing jobId');
    }

    log.info('Server-side upload completed', {
      attachmentId: attachment.id,
      fileName: attachment.name,
      jobId: result.jobId
    });

    return { jobId: result.jobId };
  }

  private formatJobResult(result: { markdown?: string; text?: string; images?: unknown[] }, fileName: string) {
    const content = []

    if (result.markdown) {
      content.push({
        type: 'text' as const,
        text: `\`\`\`document:${fileName}\n${result.markdown}\n\`\`\``
      })
    } else if (result.text) {
      content.push({
        type: 'text' as const,
        text: `\`\`\`document:${fileName}\n${result.text}\n\`\`\``
      })
    } else {
      content.push({
        type: 'text' as const,
        text: `\`\`\`document:${fileName}\n*Document processed but no text content was extracted.*\n\nThis might be because:\n- The document contains only images\n- The document is password protected\n- The document format is not fully supported\n\`\`\``
      })
    }

    if (result.images && result.images.length > 0) {
      content.push({
        type: 'text' as const,
        text: `\n**Extracted Images:** ${result.images.length} image(s) found`
      })
    }

    return content
  }

  private async fetchJobStatus(jobId: string) {
    const response = await fetch(`/api/documents/v2/jobs/${jobId}`)

    if (!response.ok) {
      if (response.status === 502 || response.status === 503) {
        throw new Error('Processing service temporarily unavailable')
      }
      throw new Error('Failed to check processing status - please try again')
    }

    return response.json()
  }

  private async pollForResults(jobId: string, fileName: string, maxAttempts = 60) {
    let attempts = 0
    let pollInterval = 1000

    while (attempts < maxAttempts) {
      try {
        const job = await this.fetchJobStatus(jobId)

        if (job.status === 'completed') {
          return this.formatJobResult(job.result, fileName)
        } else if (job.status === 'failed') {
          throw new Error(job.error || 'Server processing failed')
        } else if (job.status === 'processing' && job.progress && job.processingStage) {
          log.info('Processing progress', {
            jobId,
            progress: job.progress,
            stage: job.processingStage
          })
        }

        await new Promise(resolve => setTimeout(resolve, pollInterval))
        pollInterval = Math.min(pollInterval * 1.2, 5000)
        attempts++
      } catch (error) {
        if (attempts < maxAttempts - 1) {
          log.warn('Polling request failed, retrying', {
            error: error instanceof Error ? error.message : 'Unknown error',
            jobId,
            attempts,
            nextRetryIn: pollInterval
          })
          await new Promise(resolve => setTimeout(resolve, pollInterval))
          attempts++
          continue
        }
        throw error
      }
    }

    throw new Error('Processing timeout - document processing took too long')
  }

  /**
   * Type guard to check if extension is a supported text-based format
   */
  private static isTextBasedExtension(
    ext: string | undefined
  ): ext is typeof HybridDocumentAdapter.TEXT_BASED_EXTENSIONS[number] {
    if (!ext) return false;
    return HybridDocumentAdapter.TEXT_BASED_EXTENSIONS.includes(
      ext as typeof HybridDocumentAdapter.TEXT_BASED_EXTENSIONS[number]
    );
  }

  /**
   * Type guard to check if MIME type is a supported text format
   */
  private static isValidTextMimeType(
    mimeType: string
  ): mimeType is typeof HybridDocumentAdapter.VALID_TEXT_MIME_TYPES[number] {
    return HybridDocumentAdapter.VALID_TEXT_MIME_TYPES.includes(
      mimeType as typeof HybridDocumentAdapter.VALID_TEXT_MIME_TYPES[number]
    );
  }

  /**
   * Validates file type using extension and MIME type for text files,
   * or magic bytes for binary formats.
   * @param file - The file to validate
   * @returns True if file type is supported, false otherwise
   */
  private async validateFileType(file: File): Promise<boolean> {
    try {
      // Validate file is not empty
      if (file.size === 0) {
        log.warn('File rejected: empty file', { fileName: file.name });
        return false;
      }

      // Extract file extension and validate it exists
      const ext = file.name.includes('.')
        ? file.name.split('.').pop()?.toLowerCase()
        : undefined;

      if (!ext) {
        log.warn('File rejected: no extension', { fileName: file.name });
        return false;
      }

      log.debug('Validating file type', {
        fileName: file.name,
        extension: ext,
        mimeType: file.type,
        fileSize: file.size
      });

      // Text-based formats don't have magic bytes - validate by extension and MIME type
      if (HybridDocumentAdapter.isTextBasedExtension(ext)) {
        // Only allow explicitly validated MIME types for security
        const isValid = HybridDocumentAdapter.isValidTextMimeType(file.type);

        if (!isValid) {
          log.warn('Text file rejected: invalid MIME type', {
            fileName: file.name,
            extension: ext,
            mimeType: file.type,
            allowedTypes: HybridDocumentAdapter.VALID_TEXT_MIME_TYPES
          });
        }

        return isValid;
      }

      // For binary formats, check magic bytes
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer).subarray(0, 8);
      const header = Array.from(bytes)
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');

      log.debug('Validating binary file format', {
        fileName: file.name,
        header: header.substring(0, 16),
      });

      // Check magic bytes for supported binary formats
      const magicBytes = {
        pdf: '25504446',      // %PDF
        office: '504b0304',   // ZIP-based format (Office 2007+)
        ole: 'd0cf11e0',      // OLE format (Office 97-2003)
      };

      // Check PDF
      if (header.startsWith(magicBytes.pdf)) return true;

      // Check Office formats
      if (header.startsWith(magicBytes.office) || header.startsWith(magicBytes.ole)) {
        return ['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt'].includes(ext || '');
      }

      log.warn('File validation failed: no matching format', {
        fileName: file.name,
        extension: ext,
        mimeType: file.type,
        headerPreview: header.substring(0, 16),
      });

      return false;
    } catch (error) {
      log.error('File type validation error', {
        fileName: file.name,
        fileType: file.type,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return false;
    }
  }

  private sanitizeFileName(name: string): string {
    // Remove dangerous characters and limit length
    return name.replace(/[^\d.A-Za-z-]/g, '_').substring(0, 255);
  }

   
  async remove(_attachment: PendingAttachment): Promise<void> {
    // Cleanup if needed
  }
}

/**
 * Vision-capable image adapter for LLMs like GPT-4V, Claude 3, Gemini Pro Vision
 * Sends images as base64 data URLs to vision-capable models
 * Enhanced with additional validation but maintains full compatibility
 */
export class VisionImageAdapter implements AttachmentAdapter {
  accept = "image/jpeg,image/png,image/webp,image/gif";
  
  private callbacks?: AttachmentProcessingCallbacks;

  constructor(callbacks?: AttachmentProcessingCallbacks) {
    this.callbacks = callbacks;
  }

  async add({ file }: { file: File }): Promise<PendingAttachment> {
    log.info('VisionImageAdapter.add() called', {
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type
    });

    // Validate file size (20MB limit for most LLMs)
    const maxSize = 20 * 1024 * 1024; // 20MB
    if (file.size > maxSize) {
      throw new Error("Image size exceeds 20MB limit");
    }

    // Validate MIME type using magic bytes
    const isValidImage = await this.verifyImageMimeType(file);
    if (!isValidImage) {
      throw new Error("Invalid image file format");
    }

    log.info('VisionImageAdapter.add() validation passed');

    // Return pending attachment while processing
    return {
      id: generateUUID(),
      type: "image",
      name: this.sanitizeFileName(file.name),
      contentType: file.type,
      file,
      status: { 
        type: "running",
        reason: "uploading",
        progress: 0
      },
    };
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    // Convert image to base64 data URL
    const base64 = await this.fileToBase64DataURL(attachment.file);

    log.info('VisionImageAdapter.send() called', {
      attachmentId: attachment.id,
      fileName: attachment.name,
      fileSize: attachment.file.size,
      base64Length: base64.length,
      base64Preview: base64.substring(0, 50) + '...'
    });

    // Return in assistant-ui format with image content
    return {
      id: attachment.id,
      type: "image",
      name: attachment.name,
      contentType: attachment.contentType || "image/jpeg",
      file: attachment.file, // Keep the file reference - required by assistant-ui
      content: [
        {
          type: "image",
          image: base64, // data:image/jpeg;base64,... format
        },
      ],
      status: { type: "complete" },
    };
  }

   
  async remove(_attachment: PendingAttachment): Promise<void> {
    // Cleanup if needed (e.g., revoke object URLs if you created any)
  }

  private async fileToBase64DataURL(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => {
        // FileReader result is already a data URL
        resolve(reader.result as string);
      });
      reader.addEventListener('error', () => reject(reader.error));
      reader.readAsDataURL(file);
    });
  }

  private async verifyImageMimeType(file: File): Promise<boolean> {
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer).subarray(0, 4);
      const header = Array.from(bytes)
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
      
      // Check magic bytes for common image formats
      const imageHeaders = {
        '89504e47': 'image/png',
        'ffd8ffe0': 'image/jpeg',
        'ffd8ffe1': 'image/jpeg',
        'ffd8ffe2': 'image/jpeg',
        '47494638': 'image/gif',
        '52494646': 'image/webp', // Actually checks for RIFF, need to check WEBP after
      };
      
      return Object.keys(imageHeaders).some(h => header.startsWith(h.toLowerCase()));
    } catch {
      return false;
    }
  }

  private sanitizeFileName(name: string): string {
    // Remove dangerous characters and limit length
    return name.replace(/[^\d.A-Za-z-]/g, '_').substring(0, 255);
  }
}

/**
 * Creates a composite adapter combining all enhanced attachment adapters for Nexus
 * Includes:
 * - Enhanced vision-capable image adapter
 * - Hybrid document adapter (client/server processing)
 * - Simple text adapter
 */
export function createEnhancedNexusAttachmentAdapter(callbacks?: AttachmentProcessingCallbacks) {
  return new CompositeAttachmentAdapter([
    new VisionImageAdapter(callbacks),           // For vision-capable models
    new SimpleImageAttachmentAdapter(), // For display-only images (RESTORED)
    new HybridDocumentAdapter(callbacks),        // Smart document processing (client/server)
    new SimpleTextAttachmentAdapter(),  // Text files
  ]);
}