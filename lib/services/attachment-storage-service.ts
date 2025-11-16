import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { createLogger } from '@/lib/logger';
import type { UIMessage } from 'ai';
import { generateUUID } from '@/lib/utils/uuid';

const s3Client = new S3Client({});
const log = createLogger({ service: 'attachment-storage' });

// Environment validation with test environment support
function getDocumentsBucket(): string {
  if (process.env.NODE_ENV === 'test') {
    return process.env.DOCUMENTS_BUCKET_NAME || 'test-documents-bucket';
  }
  
  if (!process.env.DOCUMENTS_BUCKET_NAME) {
    throw new Error('DOCUMENTS_BUCKET_NAME environment variable is required but not configured');
  }
  
  return process.env.DOCUMENTS_BUCKET_NAME;
}

const DOCUMENTS_BUCKET = getDocumentsBucket();

// Use the proper UIMessage structure with parts array

export interface AttachmentMetadata {
  s3Key: string;
  originalName: string;
  contentType: string;
  size: number;
  attachmentId: string;
}

export interface AttachmentContent {
  id?: string;
  name?: string;
  type: 'image' | 'document' | 'file';
  contentType?: string;
  image?: string; // base64 data for images
  data?: string; // data for documents/files
  content?: string; // alternative data field
}

export interface StoredAttachment {
  type: 'image' | 'document' | 'file';
  s3Key: string;
  originalContent: AttachmentContent;
  metadata: AttachmentMetadata;
}

/**
 * Store attachment content in S3 with conversation-scoped keys
 */
export async function storeAttachmentInS3(
  conversationId: string,
  messageId: string,
  attachment: AttachmentContent,
  attachmentIndex: number
): Promise<AttachmentMetadata> {
  try {
    const attachmentId = attachment.id || generateUUID();
    const sanitizedName = sanitizeFileName(attachment.name || 'attachment');
    
    // Create conversation-scoped S3 key
    const s3Key = `conversations/${conversationId}/attachments/${messageId}-${attachmentIndex}-${sanitizedName}`;
    
    // Determine content to store based on attachment type
    let contentToStore: Record<string, unknown>;
    let contentType: string;
    
    if (attachment.type === 'image' && attachment.image) {
      // Store image data (base64)
      contentToStore = {
        type: 'image',
        image: attachment.image,
        name: attachment.name,
        contentType: attachment.contentType
      };
      contentType = 'application/json';
    } else if (attachment.type === 'document' || attachment.type === 'file') {
      // Store document/file data
      contentToStore = {
        type: attachment.type,
        data: attachment.data || attachment.content,
        name: attachment.name,
        contentType: attachment.contentType
      };
      contentType = 'application/json';
    } else {
      throw new Error(`Unsupported attachment type: ${attachment.type}`);
    }
    
    // Store in S3
    await s3Client.send(new PutObjectCommand({
      Bucket: DOCUMENTS_BUCKET,
      Key: s3Key,
      Body: JSON.stringify(contentToStore),
      ContentType: contentType,
      Metadata: {
        conversationId,
        messageId,
        attachmentId,
        originalName: sanitizedName,
        attachmentType: attachment.type,
      },
    }));
    
    log.info('Attachment stored in S3', {
      conversationId,
      messageId,
      attachmentId,
      s3Key,
      size: JSON.stringify(contentToStore).length
    });
    
    return {
      s3Key,
      originalName: attachment.name || 'attachment',
      contentType: attachment.contentType || 'application/octet-stream',
      size: JSON.stringify(contentToStore).length,
      attachmentId
    };
    
  } catch (error) {
    log.error('Failed to store attachment in S3', {
      conversationId,
      messageId,
      error: error instanceof Error ? error.message : String(error)
    });
    throw new Error(`Failed to store attachment: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Retrieve attachment content from S3
 */
export async function getAttachmentFromS3(s3Key: string): Promise<AttachmentContent> {
  try {
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: DOCUMENTS_BUCKET,
      Key: s3Key,
    }));
    
    if (!response.Body) {
      throw new Error('No content returned from S3');
    }
    
    const bodyText = await response.Body.transformToString();
    const attachmentData = JSON.parse(bodyText) as AttachmentContent;
    
    log.info('Attachment retrieved from S3', {
      s3Key,
      type: attachmentData.type,
      size: bodyText.length
    });
    
    return attachmentData;
    
  } catch (error) {
    log.error('Failed to retrieve attachment from S3', {
      s3Key,
      error: error instanceof Error ? error.message : String(error)
    });
    throw new Error(`Failed to retrieve attachment: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Process messages to extract and store attachments in S3
 * Returns lightweight messages with S3 references
 */
export async function processMessagesWithAttachments(
  conversationId: string,
  messages: UIMessage[]
): Promise<{ lightweightMessages: UIMessage[], attachmentReferences: AttachmentMetadata[] }> {
  const lightweightMessages: UIMessage[] = [];
  const attachmentReferences: AttachmentMetadata[] = [];
  
  for (const message of messages) {
    const messageId = generateUUID();
    
    if (Array.isArray(message.parts)) {
      const lightweightParts = [];
      let attachmentIndex = 0;
      
      for (const part of message.parts) {
        const partData = part as { type: string; image?: string; data?: string; content?: string; name?: string; [key: string]: unknown };
        if (partData.type === 'image' && partData.image) {
          // Store image in S3
          const metadata = await storeAttachmentInS3(
            conversationId,
            messageId,
            partData as AttachmentContent,
            attachmentIndex++
          );
          
          attachmentReferences.push(metadata);
          
          // Replace with lightweight S3 reference for Lambda reconstruction
          lightweightParts.push({
            type: 'image' as const,
            image: `s3://${metadata.s3Key}`, // S3 reference that Lambda can reconstruct
            s3Key: metadata.s3Key,
            attachmentId: metadata.attachmentId
          } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
        } else if ((partData.type === 'document' || partData.type === 'file') && (partData.data || partData.content)) {
          // Store document in S3
          const metadata = await storeAttachmentInS3(
            conversationId,
            messageId,
            partData as AttachmentContent,
            attachmentIndex++
          );
          
          attachmentReferences.push(metadata);
          
          // Replace with lightweight S3 reference for Lambda reconstruction
          lightweightParts.push({
            type: 'file' as const,
            url: `s3://${metadata.s3Key}`, // S3 reference that Lambda can reconstruct
            mediaType: partData.mediaType || 'application/octet-stream',
            filename: partData.name,
            s3Key: metadata.s3Key,
            attachmentId: metadata.attachmentId
          } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
        } else {
          // Keep text and other parts as-is
          lightweightParts.push(part);
        }
      }
      
      lightweightMessages.push({
        ...message,
        parts: lightweightParts
      });
    } else {
      // No attachments, keep message as-is
      lightweightMessages.push(message);
    }
  }
  
  return { lightweightMessages, attachmentReferences };
}

/**
 * Reconstruct full messages with attachment data from S3
 */
export async function reconstructMessagesWithAttachments(
  lightweightMessages: UIMessage[],
  attachmentReferences: AttachmentMetadata[]
): Promise<UIMessage[]> {
  const fullMessages: UIMessage[] = [];
  
  for (const message of lightweightMessages) {
    if (Array.isArray(message.parts)) {
      const fullParts = [];
      
      for (const part of message.parts) {
        if (part.type === 'text' && typeof part.text === 'string' && part.text.startsWith('[Image:') && part.text.includes('conversation context')) {
          // Find and restore image from S3
          const matchingAttachment = attachmentReferences.find(ref => 
            part.text && part.text.includes(ref.originalName)
          );
          
          if (matchingAttachment) {
            const attachmentData = await getAttachmentFromS3(matchingAttachment.s3Key);
            fullParts.push(attachmentData);
          } else {
            fullParts.push(part); // Keep as-is if not found
          }
        } else {
          fullParts.push(part);
        }
      }
      
      fullMessages.push({
        ...message,
        parts: fullParts as UIMessage['parts']
      });
    } else {
      fullMessages.push(message);
    }
  }
  
  return fullMessages;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^\d.A-Za-z-]/g, '_').substring(0, 255);
}