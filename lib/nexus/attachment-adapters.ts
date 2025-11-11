import {
  AttachmentAdapter,
  PendingAttachment,
  CompleteAttachment,
  CompositeAttachmentAdapter,
  SimpleImageAttachmentAdapter,
  SimpleTextAttachmentAdapter,
} from "@assistant-ui/react";
import { generateUUID } from "@/lib/utils/uuid";

/**
 * Vision-capable image adapter for LLMs like GPT-4V, Claude 3, Gemini Pro Vision
 * Sends images as base64 data URLs to vision-capable models
 */
export class VisionImageAdapter implements AttachmentAdapter {
  accept = "image/jpeg,image/png,image/webp,image/gif";

  async add({ file }: { file: File }): Promise<PendingAttachment> {
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
      reader.onload = () => {
        // FileReader result is already a data URL
        resolve(reader.result as string);
      };
      reader.onerror = reject;
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
    return name.replace(/[^a-zA-Z0-9.-]/g, '_').substring(0, 255);
  }
}

/**
 * PDF document adapter
 * Handles PDF files by converting to base64 for processing
 * Future enhancement: Add text extraction using pdf.js
 */
export class PDFAttachmentAdapter implements AttachmentAdapter {
  accept = "application/pdf";

  async add({ file }: { file: File }): Promise<PendingAttachment> {
    // Validate file size
    const maxSize = 10 * 1024 * 1024; // 10MB limit
    if (file.size > maxSize) {
      throw new Error("PDF size exceeds 10MB limit");
    }

    // Validate MIME type using magic bytes
    const isValidPDF = await this.verifyPDFMimeType(file);
    if (!isValidPDF) {
      throw new Error("Invalid PDF file format");
    }

    return {
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
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    // For now, just send a reference to the PDF
    // Full implementation requires pdf.js or similar library
    const fileName = this.sanitizeFileName(attachment.name);
    const fileSize = attachment.file.size;
    const fileSizeKB = Math.round(fileSize / 1024);
    
    return {
      id: attachment.id,
      type: "document",
      name: fileName,
      contentType: attachment.contentType || "application/pdf",
      file: attachment.file, // Keep the file reference - required by assistant-ui
      content: [
        {
          type: "text",
          text: `<attachment name="${fileName}" type="pdf" size="${fileSizeKB}KB">
[PDF placeholder - actual content extraction pending implementation]
</attachment>`,
        },
      ],
      status: { type: "complete" },
    };
  }

   
  async remove(_attachment: PendingAttachment): Promise<void> {
    // Cleanup if needed
  }

  private async fileToBase64(file: File): Promise<string> {
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    
    // For large files, we need to process in chunks to avoid stack overflow
    let binary = '';
    const chunkSize = 0x8000; // 32KB chunks
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, Array.from(chunk));
    }
    return btoa(binary);
  }

  private async verifyPDFMimeType(file: File): Promise<boolean> {
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer).subarray(0, 4);
      const header = Array.from(bytes)
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
      
      // Check for PDF magic bytes: %PDF (25504446)
      return header.toLowerCase().startsWith('25504446');
    } catch {
      return false;
    }
  }

  private sanitizeFileName(name: string): string {
    // Remove dangerous characters and limit length
    return name.replace(/[^a-zA-Z0-9.-]/g, '_').substring(0, 255);
  }

  // Optional: Extract text from PDF using a library like pdf.js
  // private async extractTextFromPDF(file: File): Promise<string> {
  //   // Implementation would use pdf.js or similar
  //   // This is a placeholder
  //   return "Extracted PDF text content";
  // }
}

/**
 * Creates a composite adapter combining all attachment adapters for Nexus
 * Includes:
 * - Vision-capable image adapter (for AI models with vision)
 * - Simple image adapter (for display-only)
 * - Simple text adapter (for text files)
 * - PDF adapter (for document processing - basic implementation)
 * 
 * @deprecated This function has been replaced by createEnhancedNexusAttachmentAdapter
 * Use import { createEnhancedNexusAttachmentAdapter } from '@/lib/nexus/enhanced-attachment-adapters'
 */
export function createNexusAttachmentAdapter() {
  return new CompositeAttachmentAdapter([
    new VisionImageAdapter(),           // For vision-capable models
    new SimpleImageAttachmentAdapter(), // For display-only images
    new SimpleTextAttachmentAdapter(),  // For text files
    new PDFAttachmentAdapter(),         // For PDF documents (placeholder implementation)
  ]);
}