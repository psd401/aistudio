/**
 * Upload file via server-side endpoint to bypass school network restrictions.
 * School networks block direct S3 presigned URL uploads, but allow uploads
 * to aistudio.psd401.ai domain which then proxies to S3.
 *
 * @see https://github.com/psd401/aistudio/issues/632
 */
export async function uploadViaServer(file: File, purpose: 'chat' | 'assistant' = 'assistant'): Promise<{ jobId: string }> {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('purpose', purpose)
  formData.append('processingOptions', JSON.stringify({
    extractText: true,
    convertToMarkdown: true,
    extractImages: false,
    generateEmbeddings: false,
    ocrEnabled: true
  }))

  const response = await fetch('/api/documents/v2/upload', {
    method: 'POST',
    body: formData,
  })

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Upload failed' }))
    throw new Error(errorData.error || `Upload failed: ${response.status}`)
  }

  const result = await response.json()

  if (!result.jobId) {
    throw new Error('Server upload response missing jobId')
  }

  return { jobId: result.jobId }
}

export function formatDocumentTag(extractedText: string, fileName: string): string {
  const fileExt = fileName.split('.').pop()?.toLowerCase() || 'unknown'
  return `<document title="${fileName}" type="${fileExt}">\n${extractedText}\n</document>`
}

export function getButtonText(
  processingStatus: string,
  isLoading: boolean,
  uploadedFileName: string | null,
  defaultLabel: string
): string {
  if (processingStatus) return processingStatus
  if (isLoading) return "Processing..."
  if (uploadedFileName) {
    return `✓ ${uploadedFileName.length > 20 ? uploadedFileName.substring(0, 20) + '...' : uploadedFileName}`
  }
  return defaultLabel
}

export const SUPPORTED_FILE_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/xml',
  'text/xml',
  'application/x-yaml',
  'text/yaml',
  'text/x-yaml',
]

export const MAX_FILE_SIZE = 50 * 1024 * 1024
