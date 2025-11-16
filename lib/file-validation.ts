import { getSetting } from '@/lib/settings-manager'

// Supported file types
export const ALLOWED_FILE_EXTENSIONS = ['.pdf', '.docx', '.xlsx', '.pptx', '.txt', '.md', '.csv'] as const
export const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/markdown',
  'text/csv'
] as const

// Type for allowed extensions
export type AllowedFileExtension = typeof ALLOWED_FILE_EXTENSIONS[number]
export type AllowedMimeType = typeof ALLOWED_MIME_TYPES[number]

/**
 * Get the maximum file size allowed for uploads
 * @returns Maximum file size in bytes
 */
export async function getMaxFileSize(): Promise<number> {
  const maxSizeMB = await getSetting('MAX_FILE_SIZE_MB') || process.env.MAX_FILE_SIZE_MB || '25'
  return Number.parseInt(maxSizeMB, 10) * 1024 * 1024
}

/**
 * Get the threshold for using presigned URLs vs direct upload
 * Fixed at 1MB due to AWS Amplify request body size limit
 * @returns Threshold in bytes
 */
export function getPresignedUrlThreshold(): number {
  return 1 * 1024 * 1024 // 1MB - AWS Amplify limit
}

/**
 * Validate file extension
 * @param fileName - The name of the file to validate
 * @returns True if valid, false otherwise
 */
export function isValidFileExtension(fileName: string): boolean {
  const fileExtension = `.${fileName.split('.').pop()?.toLowerCase()}`
  return ALLOWED_FILE_EXTENSIONS.includes(fileExtension as AllowedFileExtension)
}

/**
 * Validate MIME type
 * @param mimeType - The MIME type to validate
 * @returns True if valid, false otherwise
 */
export function isValidMimeType(mimeType: string): boolean {
  return ALLOWED_MIME_TYPES.includes(mimeType as AllowedMimeType)
}

/**
 * Get file extension from filename
 * @param fileName - The filename
 * @returns The file extension with dot prefix
 */
export function getFileExtension(fileName: string): string {
  return `.${fileName.split('.').pop()?.toLowerCase() || ''}`
}

/**
 * Validate file size
 * @param fileSize - Size in bytes
 * @param maxSize - Maximum allowed size in bytes
 * @returns True if within limits, false otherwise
 */
export function isValidFileSize(fileSize: number, maxSize: number): boolean {
  return fileSize > 0 && fileSize <= maxSize
}

/**
 * Get human-readable file size
 * @param bytes - Size in bytes
 * @returns Human-readable size string
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes'
  
  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  
  return Number.parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

/**
 * Comprehensive file validation
 * @param file - File object or file metadata
 * @returns Validation result with error message if invalid
 */
export async function validateFile(file: {
  name: string
  type: string
  size: number
}): Promise<{ isValid: boolean; error?: string }> {
  // Check file extension
  if (!isValidFileExtension(file.name)) {
    return {
      isValid: false,
      error: `Unsupported file extension. Allowed types: ${ALLOWED_FILE_EXTENSIONS.join(', ')}`
    }
  }

  // Check MIME type
  if (!isValidMimeType(file.type)) {
    return {
      isValid: false,
      error: `Unsupported file type. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}`
    }
  }

  // Check file size
  const maxSize = await getMaxFileSize()
  if (!isValidFileSize(file.size, maxSize)) {
    return {
      isValid: false,
      error: `File size must be less than ${formatFileSize(maxSize)}`
    }
  }

  return { isValid: true }
}