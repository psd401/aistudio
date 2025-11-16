
/**
 * Message conversion utilities for handling different message formats
 * between assistant-ui, AI SDK, and provider-specific formats
 */

export interface MessagePart {
  type: string;
  text?: string;
  image?: string;
  [key: string]: unknown;
}

export interface AssistantUIMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content?: string | MessagePart[];
  parts?: MessagePart[];
  metadata?: Record<string, unknown>;
  createdAt?: string;
  attachments?: unknown[];
}

export interface CoreMessage {
  role: 'user' | 'assistant' | 'system';
  parts: MessagePart[];
  [key: string]: unknown;
}

/**
 * Pass messages through unchanged - let AI SDK convertToModelMessages handle the conversion
 */
export function convertAssistantUIMessages(messages: AssistantUIMessage[]): AssistantUIMessage[] {
  return messages.map((msg) => normalizeMessage(msg));
}

/**
 * Pass messages through unchanged - let AI SDK handle the conversion
 */
export function normalizeMessage(msg: AssistantUIMessage): AssistantUIMessage {
  // Return the message as-is and let convertToModelMessages handle proper conversion
  return msg;
}

/**
 * Extract text content from a message
 */
export function extractTextContent(msg: AssistantUIMessage): string {
  // Try parts first
  if (msg.parts && Array.isArray(msg.parts)) {
    return msg.parts
      .filter(part => part.type === 'text' && part.text)
      .map(part => part.text)
      .join(' ');
  }
  
  // Try content
  if (msg.content) {
    if (typeof msg.content === 'string') {
      return msg.content;
    }
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter(part => part.type === 'text' && part.text)
        .map(part => part.text)
        .join(' ');
    }
  }
  
  return '';
}

/**
 * Check if message has any attachments
 */
export function hasAttachments(msg: AssistantUIMessage): boolean {
  // Check attachments array
  if (msg.attachments && msg.attachments.length > 0) {
    return true;
  }
  
  // Check parts for non-text content
  if (msg.parts && Array.isArray(msg.parts)) {
    return msg.parts.some(part => part.type !== 'text');
  }
  
  // Check content array for non-text content
  if (Array.isArray(msg.content)) {
    return msg.content.some(part => part.type !== 'text');
  }
  
  return false;
}

/**
 * Validate message format
 */
export function validateMessage(msg: unknown): string[] {
  const errors: string[] = [];
  
  if (!msg || typeof msg !== 'object') {
    errors.push('Message is null or undefined or not an object');
    return errors;
  }
  
  const message = msg as Record<string, unknown>;
  
  if (!message.role || !['user', 'assistant', 'system'].includes(message.role as string)) {
    errors.push(`Invalid role: ${message.role}`);
  }
  
  const hasContent = message.content && (
    typeof message.content === 'string' || 
    Array.isArray(message.content)
  );
  const hasParts = message.parts && Array.isArray(message.parts);
  
  if (!hasContent && !hasParts) {
    errors.push('Message must have either content or parts');
  }
  
  return errors;
}

/**
 * Validate messages array
 */
export function validateMessages(messages: unknown[]): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (!Array.isArray(messages)) {
    return {
      isValid: false,
      errors: ['Messages must be an array']
    };
  }
  
  if (messages.length === 0) {
    return {
      isValid: false,
      errors: ['Messages array cannot be empty']
    };
  }
  
  for (const [index, msg] of messages.entries()) {
    const msgErrors = validateMessage(msg);
    for (const error of msgErrors) {
      errors.push(`Message ${index}: ${error}`);
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}