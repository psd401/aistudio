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
          log.error('Background processing failed', { attachmentId: attachment.id, fileName: attachment.name, error });
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

      // Step 1: Initiate server upload
      const uploadSession = await this.initiateUpload(attachment);
      
      // Step 2: Upload to S3 using presigned URL
      await this.uploadToS3(attachment.file, uploadSession);
      
      // Step 3: Confirm upload completion
      await this.confirmUpload(uploadSession);
      
      // Step 4: Poll for processing results
      const processedContent = await this.pollForResults(uploadSession.jobId, attachment.name);
      
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
      log.error('Server-side processing failed', { error, fileName: attachment.name });
      
      return {
        id: attachment.id,
        type: "document",
        name: attachment.name,
        contentType: attachment.contentType,
        file: attachment.file,
        content: [{
          type: "text" as const,
          text: `## Document: ${attachment.name}

*Server processing failed. The document could not be processed.*

**Error:** ${error instanceof Error ? error.message : 'Unknown server error'}
**Size:** ${Math.round(attachment.file.size / 1024)}KB

*This may be due to:*
- Unsupported document format
- Corrupted file
- Server processing limits
- Network connectivity issues

Please try re-uploading or contact support if the issue persists.`
        }],
        status: { 
          type: "complete"
        },
      };
    }
  }

  private async initiateUpload(attachment: PendingAttachment) {
    const response = await fetch('/api/documents/v2/initiate-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: attachment.name,
        fileSize: attachment.file.size,
        fileType: attachment.contentType,
        purpose: 'chat',
        processingOptions: {
          extractText: true,
          convertToMarkdown: true,
          extractImages: false, // Disable for chat to reduce processing time
          ocrEnabled: true
        }
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to initiate upload: ${error}`);
    }
    
    return response.json();
  }

  private async uploadToS3(file: File, session: { uploadMethod?: string; uploadUrl?: string; partUrls?: { uploadUrl: string }[]; uploadId?: string; jobId?: string }) {
    if (session.uploadMethod === 'multipart' && session.partUrls && session.uploadId && session.jobId) {
      // Handle multipart upload for very large files
      await this.multipartUpload(file, { partUrls: session.partUrls, uploadId: session.uploadId, jobId: session.jobId });
    } else if (session.uploadUrl) {
      // Direct upload for medium files
      const response = await fetch(session.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: {
          'Content-Type': file.type
        }
      });
      
      if (!response.ok) {
        throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
      }
    } else {
      throw new Error('Invalid session: missing uploadUrl for direct upload or required multipart data');
    }
  }

  private async multipartUpload(file: File, session: { partUrls: { uploadUrl: string }[]; uploadId: string; jobId: string }) {
    const partSize = 5 * 1024 * 1024; // 5MB chunks
    const parts = [];
    
    for (let i = 0; i < session.partUrls.length; i++) {
      const start = i * partSize;
      const end = Math.min(start + partSize, file.size);
      const chunk = file.slice(start, end);
      
      const response = await fetch(session.partUrls[i].uploadUrl, {
        method: 'PUT',
        body: chunk
      });
      
      if (!response.ok) {
        throw new Error(`Part upload failed: ${response.status}`);
      }
      
      parts.push({
        ETag: response.headers.get('ETag')?.replace(/"/g, ''),
        PartNumber: i + 1
      });
    }
    
    // Complete multipart upload
    const completeResponse = await fetch('/api/documents/v2/complete-multipart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId: session.uploadId,
        jobId: session.jobId,
        parts
      })
    });
    
    if (!completeResponse.ok) {
      throw new Error('Failed to complete multipart upload');
    }
  }

  private async confirmUpload(session: { uploadId: string; jobId: string }) {
    const response = await fetch('/api/documents/v2/confirm-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId: session.uploadId,
        jobId: session.jobId
      })
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to confirm upload: ${error}`);
    }
  }

  private async pollForResults(jobId: string, fileName: string, maxAttempts = 60) {
    let attempts = 0;
    let pollInterval = 1000; // Start with 1 second
    
    while (attempts < maxAttempts) {
      try {
        const response = await fetch(`/api/documents/v2/jobs/${jobId}`);
        
        if (!response.ok) {
          throw new Error(`Failed to check job status: ${response.status}`);
        }
      
      const job = await response.json();
      
      if (job.status === 'completed') {
        // Return content in assistant-ui format using code block for collapsible UI
        const result = job.result;
        const content = [];

        if (result.markdown) {
          content.push({
            type: 'text' as const,
            text: `\`\`\`document:${fileName}
${result.markdown}
\`\`\``
          });
        } else if (result.text) {
          content.push({
            type: 'text' as const,
            text: `\`\`\`document:${fileName}
${result.text}
\`\`\``
          });
        } else {
          content.push({
            type: 'text' as const,
            text: `\`\`\`document:${fileName}
*Document processed but no text content was extracted.*

This might be because:
- The document contains only images
- The document is password protected
- The document format is not fully supported
\`\`\``
          });
        }

        // Add images if extracted
        if (result.images && result.images.length > 0) {
          content.push({
            type: 'text' as const,
            text: `\n**Extracted Images:** ${result.images.length} image(s) found`
          });
        }

        return content;
      } else if (job.status === 'failed') {
        throw new Error(job.error || 'Server processing failed');
      } else if (job.status === 'processing') {
        // Show progress if available
        if (job.progress && job.processingStage) {
          log.info('Processing progress', { 
            jobId, 
            progress: job.progress, 
            stage: job.processingStage 
          });
        }
      }
      
        // Wait before next poll with exponential backoff
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        pollInterval = Math.min(pollInterval * 1.2, 5000); // Max 5 seconds
        attempts++;
      } catch (error) {
        // If fetch fails, log it but continue trying
        if (attempts < maxAttempts - 1) {
          log.warn('Polling request failed, retrying', { 
            error: error instanceof Error ? error.message : 'Unknown error', 
            jobId, 
            attempts,
            nextRetryIn: pollInterval 
          });
          await new Promise(resolve => setTimeout(resolve, pollInterval));
          attempts++;
          continue;
        }
        // On final attempt, throw the error
        throw error;
      }
    }
    
    throw new Error('Processing timeout - document processing took too long');
  }

  private formatProcessingTime(startTime: string, endTime: string): string {
    const start = new Date(startTime).getTime();
    const end = new Date(endTime).getTime();
    const duration = end - start;
    
    if (duration < 1000) return `${duration}ms`;
    if (duration < 60000) return `${Math.round(duration / 1000)}s`;
    return `${Math.round(duration / 60000)}m ${Math.round((duration % 60000) / 1000)}s`;
  }

  private async validateFileType(file: File): Promise<boolean> {
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer).subarray(0, 8);
      const header = Array.from(bytes)
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
      
      // Check magic bytes for supported formats
      const magicBytes = {
        pdf: '25504446',      // %PDF
        office: '504b0304',   // ZIP-based format (Office 2007+)
        ole: 'd0cf11e0',      // OLE format (Office 97-2003)
      };
      
      // Check PDF
      if (header.startsWith(magicBytes.pdf)) return true;
      
      // Check Office formats
      if (header.startsWith(magicBytes.office) || header.startsWith(magicBytes.ole)) {
        const ext = file.name.split('.').pop()?.toLowerCase();
        return ['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt'].includes(ext || '');
      }
      
      return false;
    } catch {
      return false;
    }
  }

  private getFileTypeFromName(fileName: string): string {
    const extension = fileName.split('.').pop()?.toLowerCase() || '';
    
    switch (extension) {
      case 'pdf': return 'pdf';
      case 'docx':
      case 'doc': return 'docx';
      case 'xlsx':
      case 'xls': return 'xlsx';
      case 'pptx':
      case 'ppt': return 'pptx';
      default: return extension;
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